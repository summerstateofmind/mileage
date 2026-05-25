# Part 3 (Session-Intent Judge) — Remaining Work & Dogfood Guide

**Date:** 2026-05-25
**Status:** Foundation engine SHIPPED (commits `fb2eab2` → `5420dbc`). View integration + YPT feed remain, gated on dogfooding the verdicts.

Specs/plans: `specs/2026-05-25-session-intent-judge-design.md`, `plans/2026-05-25-session-intent-judge-foundation.md`.

---

## Where we are
The judge **engine** exists and is unit-tested (63 tests green), but **no verdicts have been produced yet** — that needs a real model. Nothing reads content or hits the network until you set up a model and run a pass. `show` and YPT are untouched (per the phasing). Default: judge OFF.

The deliberate checkpoint: **produce real verdicts on your own sessions, confirm they ring true, THEN build the view around them.**

---

## Step 1 — Dogfood the judge (do this next)

### Pick a model path
- **Cloud (recommended for the 8 GB dev machine).** A local 3B will mostly abstain on this hardware. Use an OpenAI-compatible endpoint with your own key.
  ```
  mileage judge:set-cloud <openai-compatible-endpoint> <model>   # e.g. .../v1/chat/completions
  set MILEAGE_JUDGE_API_KEY=...        # PowerShell: $env:MILEAGE_JUDGE_API_KEY="..."
  mileage judge:enable                 # read disclosure, type: yes I read this
  mileage judge                        # judges high-effort no-commit sessions, last 30d
  ```
  ⚠ Once `judge:set-cloud` is set, the next `judge`/sync **sends prompts + trajectory to that endpoint** (never code/diffs). That is the only point content leaves the machine.
- **Local Ollama (free, fully on-device, but flaky on 8 GB → expect many `unjudged`).**
  ```
  # install Ollama from https://ollama.com, then:
  ollama pull qwen2.5:3b
  mileage judge:enable
  mileage judge
  ```

### Inspect the verdicts
```
node -e "const{DatabaseSync}=require('node:sqlite');const os=require('os'),p=require('path');const db=new DatabaseSync(p.join(os.homedir(),'.mileage','metrics.db'));console.table(db.prepare('SELECT session_id,verdict,confidence,rationale,model FROM session_verdicts ORDER BY confidence DESC').all())"
```

### What to evaluate (the whole point of the checkpoint)
- **Accuracy:** for sessions you remember — do `productive` / `spinning` match your lived experience? Specifically, are real research/design sessions (e.g. the YPT-math ones) marked `productive`, not `spinning`?
- **False spinning:** any productive session mislabeled `spinning`? (This is the dangerous error — it would scold good work.) If frequent, the rubric/prompt needs tightening before the view.
- **Confidence calibration:** are high-confidence verdicts actually the trustworthy ones? Is the 0.7 gate (used later in the view) catching the right ones, or is everything stuck low (→ mostly `unjudged`, especially on a 3B)?
- **Rationale quality:** is the ≤12-word reason specific and useful ("kept re-running the failing migration") or vague?
- **The trust question:** would you trust these enough to (a) surface in `show`, and (b) eventually feed YPT? (a) gates the Integration plan; (b) gates v2.

Record findings (a few sentences) before we plan the view.

---

## Step 2 — Integration plan (after dogfood; ~2–3 tasks)
Only build this once Step 1's verdicts ring true.
- **`effectiveness.ts`:** add a research sub-split that reads `session_verdicts` (via `getVerdictsForSessions`) and the **0.7 confidence gate** → label each research session `explored` (productive, conf ≥ 0.7), `spun` (spinning, conf ≥ 0.7), or `unjudged` (no verdict / uncertain / below threshold). Top-level Shipped/Likely/Research counts unchanged; research is decomposed. Pure + unit-tested.
- **`show.ts`:** Ship sub-line gains the decomposition when the judge is on, e.g. `… · 23 research (9 explored · 3 spun · 11 unjudged)`; a `spun` top-session row shows its rationale — the honest replacement for the retired waste flag. Off → unchanged.
- No YPT change in this step.

## Step 3 — v2: YPT feed (after the view is trusted)
- Confidence-gated `productive` verdicts contribute a small, capped term to `composite_outcomes` (rescuing no-commit yield); confident `spinning` = 0.
- **Re-open the "cache, not snapshot" decision** explicitly (per the spec): a *score* would then depend on a non-deterministic verdict — update YPT provenance to disclose it, and decide whether that trade is worth it.

---

## Calibration watch-items (revisit after dogfood)
- **Run-twice / order-swap bias mitigation** — add if verdicts prove unstable across runs.
- **Confidence threshold** (0.7) — tune from real distribution.
- **Prompt rubric** — refine the productive/spinning definitions + few-shot anchors from observed misses.

## Known gaps / deferred (revisit as needed)
- **Effort threshold is tokens-only** (`≥ 250K`). Add a duration arm (`session_end_ms`) if low-token-but-long research sessions are being missed — requires threading `session_end_ms` through `SessionOutcomeRow`/`SessionComposite`.
- **Cloud provider** is OpenAI-compatible only (`Bearer` + `/chat/completions`). Anthropic-native shape is a later option.
- **`findSessionSegmentEntries` scans all project JSONL per session** — fine at the per-sync cap, but index it if it gets slow on large histories.
- **Code-quality / static-analysis Quality Mode** (lizard/jscpd/Semgrep) — separate, indefinitely deferred (decided not the YPT lever).
