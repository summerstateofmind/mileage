# Mileage — Local Session-Intent Judge Design Spec

**Date:** 2026-05-25
**Status:** Draft
**Goal:** Split the "research" bucket (high-effort, no-commit sessions) into **productive** design/research vs **genuine spinning**, using a local LLM that reads a session's *intent* (prompts) and *behavioral trajectory* (tool-action arc) — never code, never the network by default. This is the only way to measure value that never became a commit, and to isolate the *true* token drain (spinning) from legitimate thinking.

This is **Part 3 of 3** of the effectiveness work, built on Part 1 (attribution) and Part 2 (effectiveness view).

- ✅ Part 1 — attribution sharpening + multi-repo sync
- ✅ Part 2 — flat-rate effectiveness view (Shipped / Likely / Research buckets)
- **Part 3 — session-intent judge (this spec)**

**Phased delivery (decided):** v1 (this spec) ships the judge + a **view-only** split of the research bucket; it does **not** move the YPT number. A later v2 — only after the judge proves calibrated through dogfooding — feeds a confidence-gated "productive" term into `composite_outcomes`/YPT. This protects YPT's determinism until the fuzzy judge earns trust.

---

## Why

Part 2 surfaced that ~89 of 135 weekly sessions land in "research" (no attributed commit). Today they contribute **zero** to yield — tokens spent, no measured outcome. That's YPT's biggest blind spot: it cannot see value that didn't become a commit (deep design, research, debugging that paid off later — the user's own largest sessions), and it cannot distinguish that from the AI genuinely spinning. Commit-based attribution can never tell these apart; only reading the session's intent can. The judge converts the research void into signal: **productive** (recognized thinking) vs **spinning** (the real, finally-trustworthy waste signal) vs **uncertain** (honest abstention).

---

## Scope

### What we ARE building (v1)
- **Opt-in gate** (`mileage enable judge` / `disable judge`) with ironclad disclosure; default **OFF**.
- **`judge/detect.ts`** — hardware + runtime probe → model selection across tiers (off / local-3B / local-7–8B / cloud-opt-in), with manual override.
- **`judge/input.ts`** — the **only** content-reading module; assembles prompts + trajectory for a session, gated by the opt-in flag.
- **`judge/prompt.ts`** + **`judge/runner.ts`** — the rubric prompt and the Ollama/cloud call returning `{ verdict, confidence, rationale }`.
- **`session_verdicts`** storage + helpers.
- **`mileage judge`** — run a bounded judging pass; also runs as a capped background pass during `mileage sync` when enabled.
- **View integration** — `effectiveness.ts` + `show.ts` split "research" into `explored` / `spun` / `unjudged`, and surface `spun` sessions (with the one-line rationale) as the honest waste signal.

### What we are NOT building (defer)
- **YPT-number feed** (the confidence-gated productive term in `composite_outcomes`) → **v2**, after calibration. v1 does not change any YPT math.
- **Code-quality / static-analysis Quality Mode** (lizard/jscpd/Semgrep/diff-judge) → separate, indefinitely deferred.
- **Bias-mitigation** (run-twice / order-swap) → deferred; the confidence threshold is the v1 guard.
- **Auto-installing Ollama or models** → never; we detect, we don't install. No model bundled.

### What changes for users
With the judge **off** (default): nothing — Part 2's view is unchanged. With it **on**: the research bucket splits (`explored / spun / unjudged`), and the most expensive *spinning* sessions surface with a reason — "here's where your tokens actually drained," cleanly separated from research that paid off.

---

## The design

### Opt-in gate (`mileage enable judge`)
Default `config.judge.enabled = false`. `mileage enable judge` prints, then requires a typed `yes I read this`:
1. **What it reads:** your **prompts** (user message text) + **tool-action metadata** (tool names, file paths, error/retry counts) for high-effort no-commit ("research") sessions only. Not code, not diffs, not assistant prose.
2. **What runs:** the auto-selected local model (e.g. Ollama `qwen2.5:3b`), or — *only if you separately opt into cloud* — your configured API endpoint.
3. **What's stored:** `verdict + confidence + a ≤12-word rationale`, on this machine only.
4. **What leaves the machine:** **nothing** for local; for the cloud opt-in, *prompts + trajectory only* (never code).
`mileage disable judge` flips the bit and **purges `session_verdicts`**.

### Model selection — `judge/detect.ts`
`selectJudgeModel(cfg): { kind: 'off' | 'ollama' | 'cloud'; model: string; reason: string }`. Order:
1. If `cfg.judge.model_override` is set, honor it (`off` | an Ollama model | `cloud`).
2. Else if cloud opt-in is configured (`cfg.judge.cloud = { enabled, endpoint, model }`), use it. The **API key is read from an env var, never written to config** (and never logged).
3. Else probe Ollama (`GET localhost:11434/api/tags`) and free RAM:
   - Ollama reachable + ≥ 14 GB RAM → `ollama:qwen2.5:7b`
   - Ollama reachable + ≥ 7 GB RAM → `ollama:qwen2.5:3b`
   - else → `off` (with a reason string surfaced to the user).

RAM probe reuses the cross-platform pattern (`os.totalmem()` / `os.freemem()`; GPU is a bonus, not required). Model names are configurable defaults, not hardcoded requirements.

### Judge input — `judge/input.ts` (the one privacy-line crossing)
`buildJudgeInput(session): JudgeInput` runs **only** when the gate is enabled. It locates the session's raw JSONL (reusing `claude_code.ts`'s sessionId + 10-minute-gap segmentation to find the right segment) and extracts:
- **prompts:** the text of `role: user` messages in the segment (intent).
- **trajectory:** a structured summary from the segment's `tool_use`/`tool_result` entries — per-tool counts (Edit/Write/Bash/Read), error count (`is_error`), distinct files touched (paths), and a **loop signal** (same file edited ≥ N times, or near-identical Bash commands retried). Counts and paths only — no diffs, no command output bodies.

`JudgeInput = { prompts: string[]; trajectory: TrajectorySummary }`. Nothing here is persisted; it lives in memory for the single judge call. All content-reading is contained to this module — the default `claude_code.ts` ingest stays content-free.

### Prompt + verdict — `judge/prompt.ts`, `judge/runner.ts`
`buildJudgePrompt(input)` produces a rubric:
> *productive* = explored options, researched, localized a bug, made a real decision, or correctly abandoned a bad approach after learning something. *spinning* = repeated near-identical failed attempts, no convergence, thrashing the same files, confidently-wrong loops. Respond ONLY as JSON: `{"verdict":"productive"|"spinning"|"uncertain","confidence":0.0-1.0,"rationale":"≤12 words"}`.

`runJudge(model, input)`: POST to Ollama `/api/generate` (or the cloud endpoint), parse the JSON. Any malformed/empty/timeout response → `{ verdict: 'uncertain', confidence: 0, rationale: 'judge unavailable' }`. A confidence threshold (`JUDGE_CONFIDENCE_MIN = 0.7`) gates trust: below it, the verdict is recorded but treated as `uncertain` by the view.

### Which sessions & when
Only **research-bucket** sessions (per Part 2's `classifySessionBucket`: no attributed commit, not tagged shipped) **above an effort threshold** — `duration ≥ 30 min` OR `tokens ≥ JUDGE_EFFORT_TOKENS` (default 250,000; a fixed, documented constant, not a per-window percentile). Trivial short no-commit sessions are never judged. The pass runs:
- as a **capped background pass during `mileage sync`** when enabled — judge up to `JUDGE_MAX_PER_SYNC` (default 8) unjudged qualifying sessions, so it never overruns a weak CPU;
- on demand via `mileage judge` (`--refresh` re-judges already-cached ones).
Verdicts are **cached** keyed by `session_id`; a session is judged once unless refreshed.

### Storage — `session_verdicts`
```sql
CREATE TABLE IF NOT EXISTS session_verdicts (
  session_id  TEXT PRIMARY KEY,
  verdict     TEXT NOT NULL CHECK (verdict IN ('productive','spinning','uncertain')),
  confidence  REAL NOT NULL,
  model       TEXT NOT NULL,
  rationale   TEXT,
  judged_at   INTEGER NOT NULL
);
```
This is a **cache of a non-deterministic model**, explicitly NOT a recomputable snapshot — `mileage rebuild` will not reproduce it bit-identically, and that is intended (re-judging is on demand via `mileage judge --refresh`). It is purged on `disable judge`.

### View integration (v1 — no YPT change)
- **`effectiveness.ts`** gains `bucketWindowJudged(...)` (or an overload) that, for sessions in the `research` bucket, reads `session_verdicts` and sub-labels them `explored` (productive, confident), `spun` (spinning, confident), or `unjudged` (no verdict / uncertain / below threshold). The three top-level buckets (Shipped/Likely/Research) are unchanged; the research count is decomposed.
- **`show.ts`** subscription Ship line: `… · 23 research (9 explored · 3 spun · 11 unjudged)` when the judge is on; unchanged when off. Top-session rows for a `spun` session show `spun` (dim red) with its rationale available; this becomes the honest replacement for the retired waste flag.
- **YPT/composite: untouched in v1.**

---

## Contracts
- **Privacy:** content reading is confined to `judge/input.ts`, runs only under the typed opt-in, reads prompts + action-metadata only (never code/diffs/assistant prose), and persists only `verdict + confidence + ≤12-word rationale` on-device. Local is default; the cloud path is a separate, loud, off-by-default opt-in that transmits prompts + trajectory only. The default ingest pipeline remains content-free.
- **Recomputability exception — and why it is contained.** Every other table (`snapshots`, `attributions`, `commit_survival`) is a deterministic function of `events` + git/JSONL facts: `mileage rebuild` reproduces them byte-identically, which is what makes every reported number defensible — the provenance contract the standards-play depends on. `session_verdicts` cannot honor that, because an LLM verdict is non-deterministic (the same prompts+trajectory can yield a different verdict/confidence across runs, models, and model versions); it is the output of an external oracle, not a derivation of facts. We therefore treat it as a **cache, not a snapshot**: stored to avoid re-running a slow local model, re-runnable on demand (`mileage judge --refresh`), purged on `disable judge`, and explicitly **skipped by `rebuild`** (which leaves cached verdicts untouched rather than pretending to regenerate them). The non-determinism is **quarantined** — it lives in its own table, never in `snapshots`, and in v1 never feeds YPT — so every *score* the product reports stays 100% replayable. This is the project's single deliberate break from "everything replayable," and it is safe only because it is isolated, labeled honestly as a cache, purgeable, and kept out of the trusted-metric path. Any future code that makes a *score* depend on a verdict (v2) must re-open this decision explicitly.
- **Provenance:** each verdict stores the `model` that produced it; `mileage judge` output and the view note that verdicts are model-derived, confidence-gated, and advisory in v1.

## Error handling & edge cases
- **Ollama not running / not installed:** `detect` returns `off` with a reason; `mileage judge` prints how to enable (install Ollama + pull a model) and exits cleanly; the view shows research un-split.
- **Model too slow / times out:** per-session timeout (default 60 s) → `uncertain`; the background pass respects `JUDGE_MAX_PER_SYNC` so a slow CPU never stalls `sync`.
- **Malformed JSON from the model:** → `uncertain` (never crashes).
- **No qualifying sessions:** pass is a no-op.
- **Gate off:** `judge/input.ts` is never called; no content is read.
- **Session JSONL not found** (rotated/deleted): skip with a counted warning.

## Acceptance criteria
1. With the gate **off**, `mileage show` and ingest behave exactly as today; no content is read (verifiable: `judge/input.ts` is only reachable when enabled).
2. `mileage enable judge` prints the full disclosure and requires typed confirmation; `disable judge` purges `session_verdicts`.
3. `detect.selectJudgeModel` returns the correct tier for representative `(ram, ollama-present, override, cloud-cfg)` inputs (unit-tested), including `off` on an 8 GB-no-Ollama box.
4. `runJudge` returns `uncertain` on malformed/empty/timeout output (unit-tested with a stubbed transport).
5. On a machine with Ollama + a model, `mileage judge` produces verdicts for qualifying research sessions, cached in `session_verdicts`; re-running without `--refresh` re-judges nothing.
6. With the gate on, the subscription Ship line decomposes research into explored/spun/unjudged, and a `spun` session surfaces with its rationale. **YPT is byte-identical to pre-Part-3.**
7. `npm test` green; `npm run build` clean.

## Testing
- **`detect.ts`:** pure tier-selection over `(freeRamGb, ollamaModels, override, cloudEnabled)` fixtures — every tier + `off`.
- **`input.ts`:** trajectory summarization over a fixture JSONL segment (tool counts, error count, loop detection); assert no diff/assistant text leaks into `JudgeInput`.
- **`runner.ts`:** parse well-formed JSON → verdict; malformed/empty/timeout → `uncertain`. Transport is injected/stubbed (no real model in tests).
- **storage:** insert/get/purge `session_verdicts` on an in-memory DB.
- **view:** `classify`-level test that a research session with a confident `spinning` verdict sub-labels `spun`, and a below-threshold verdict stays `unjudged`.
- **Not unit-tested:** the live model call (external/non-deterministic) — covered by manual dogfooding.

## Calibration & known limitations
- "Productive vs spinning" is inherently fuzzier than a compile check; v1 leans on the rubric + the 0.7 confidence threshold, and stays **advisory** (no YPT effect) precisely so miscalibration can't corrupt the score. Run-twice bias-mitigation is the first refinement if dogfooding shows instability.
- On an 8 GB / no-GPU machine the only local option is a 3B model (flaky, slow) — hence the cloud opt-in for the dogfooder; verdicts from a 3B should be read with skepticism (reflected in confidence).
- A 3B local model may rarely clear the 0.7 threshold → most sessions stay `unjudged`; that's acceptable (honest) for v1.

## Decomposition (for the plan)
The implementation plan will split into two task groups, both within v1:
1. **Foundation:** opt-in gate + `detect` + `input` + `prompt` + `runner` + `session_verdicts` + `mileage judge`/`enable`/`disable` — produces cached verdicts.
2. **Integration:** the `effectiveness.ts` research sub-split + the `show.ts` rendering of explored/spun/unjudged.

## Future (post-v1)
- **v2:** confidence-gated `productive` term feeds `composite_outcomes`/YPT once calibrated (the deferred half of the phased decision).
- Run-twice bias-mitigation; richer cloud-provider config; the separate static-analysis Quality Mode.
