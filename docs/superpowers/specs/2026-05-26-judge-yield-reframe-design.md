# Judge Yield Reframe — Design

**Date:** 2026-05-26
**Status:** Design — addendum to `2026-05-25-session-intent-judge-design.md`. Supersedes the binary verdict; the rest of that spec (opt-in gate, privacy model, detect/input/runner structure, phased view→YPT delivery) stands.

## Why

Dogfooding the Foundation (16 real verdicts, `llama-3.3-70b` via Groq) surfaced two structural problems, not prompt typos:

1. **Commit-anchoring.** The judge used edit/commit *absence* as its progress signal — e.g. `cost-of-living, May 14` → `spinning 90%`, rationale "no edits or commits indicate lack of progress." The user confirmed that session "wasn't the best but wasn't spinning." For a tool whose thesis is *no-commit research is legitimate*, equating "no commits" with "stuck" is the most dangerous possible error.
2. **The binary has no middle.** `productive / spinning` cannot express "fine, some progress, not stellar" — which is where most real sessions live. The repetitive rationales ("explored options without commits" ×5) are a symptom: the model is forced to the extremes and has no specific signal to cite.

The deeper miss: the binary asks a **usage-based** question ("did you waste tokens?") and sells it to a **flat-rate** user who has tokens and doesn't care. Their real question is **yield**: *is my effort converting into fast, meaningful progress?* That is exactly what YPT was always meant to measure. This reframe makes the judge the per-session **yield estimator** YPT needs — graded, not binary.

## Output model — graded yield (4 tiers + unrated)

Replace `verdict ∈ {productive, spinning, uncertain}` with `tier`:

| tier | meaning | YPT credit (v2, calibratable) |
|---|---|---|
| **high** | focused, efficient progress on something that matters; converged; clear forward motion | 1.0 |
| **solid** | real, meaningful progress — the normal good working session | 0.7 |
| **thin** | some progress but slow, scattered, minor, or partly off-track; not wasted, not impressive (the `May 14` case) | 0.35 |
| **stalled** | little/no meaningful progress: repeated failed attempts, circling, thrashing, or abandoned unresolved (the *true* spinning) | 0.0 |
| **unrated** | model declined / no signal / unavailable / below confidence gate — **not a yield grade** | excluded |

`confidence` (0–1) and a `≤14-word rationale` are retained. The `JUDGE_CONFIDENCE_MIN = 0.7` gate still applies: a below-threshold tier is recorded but treated as `unrated` by any consumer.

**Yield is defined by meaningful forward progress + momentum — never by edits/commits.** Commits are explicitly *not* the signal; a no-commit research session that converged on a decision is `high`/`solid`, while a no-commit session that thrashed is `stalled`. The discriminator is the *trajectory*, not the artifact count.

## Three coordinated changes

### 1. Rubric — `judge/prompt.ts`
- State the frame: *"You are grading session YIELD — how much meaningful forward progress this session produced. Commits/edits are NOT the signal; many high-yield sessions are pure research with zero commits."*
- Define the four tiers with the wording above, plus **few-shot anchors** including a `thin` middle and a no-commit `high` (to kill commit-anchoring) and a `stalled` loop.
- Output JSON: `{"tier":"high|solid|thin|stalled|unrated","confidence":0.0-1.0,"rationale":"≤14 words, cite the specific work"}`.

### 2. Input — `judge/input.ts` (the rationale-quality lever)
Add the **action-arc**: the *ordered* tool actions with outcomes, so the model can both *see* looping and *name* specifics (ending the boilerplate).
- Format per step: `tool_name` + target file **path** (already allowed for language inference) + outcome (`ok`/`fail`). Example arc: `Read src/auth.ts → Edit src/auth.ts → Bash test:FAIL → Edit src/auth.ts → Bash test:FAIL → Edit src/auth.ts → Bash test:FAIL` — a stall, visible without any code.
- **Privacy line (unchanged):** include tool name, file path, pass/fail, and for `Bash` only a safelisted verb (`test|build|lint|typecheck|git|install|run`) detected by regex — **never raw command text, never code/diffs/output content**. Still confined to `judge/input.ts`, still under the typed opt-in.
- Cap arc length (e.g. last ~40 actions) to bound prompt size.

### 3. Storage — `session_verdicts`
`session_verdicts` is the documented non-deterministic cache, so we **migrate by recreation**: change the CHECK to `tier IN ('high','solid','thin','stalled','unrated')` (rename column `verdict`→`tier`), and on the schema bump **purge** existing rows (they are dogfood throwaways; `mileage judge` re-derives them). No data migration. `mileage rebuild` is unaffected (verdicts were never rebuild-derived).

## Consumers

- **`judge/runner.ts`** `parseVerdict`: accept the four tiers; malformed/empty/timeout → `{tier:'unrated', confidence:0, rationale:'judge unavailable'}`. Clamp confidence.
- **`judge/run_pass.ts`**: `insertVerdict` writes `tier`. Qualification gate (research bucket, ≥250K tokens) unchanged.
- **`mileage judge:list`**: already date-sorted with When/Project; show the tier, colored `high`=green-bold, `solid`=green, `thin`=yellow, `stalled`=red, `unrated`=dim. Legend updated.
- **View (v1 forward, separate task):** the research bucket decomposes into the tiers in `show`; the most expensive `stalled` session surfaces with its rationale — "here's where you actually got stuck."
- **YPT (v2, separate task):** confidence-gated tier credit (table above) feeds `composite_outcomes`/YPT once calibrated. **No YPT change in this work.**

## Model power
The boilerplate + false-spinning are a **prompt + input** problem, not capacity. `llama-3.3-70b` grades this nuance well once the rubric is sharp and it can see the action-arc. Plan: ship rubric + input + schema, re-run `mileage judge --refresh` on the same ~16 sessions, compare before/after. Escalate to a larger model **only if** a strong prompt still underperforms.

## Testing
- `prompt.ts`: buildJudgePrompt contains the no-commit instruction + all four tier names + the JSON schema.
- `input.ts`: action-arc is ordered, includes outcomes, redacts Bash to safelisted verbs, excludes raw commands/content, respects the cap.
- `runner.ts`: each tier parses; malformed → `unrated`; confidence clamped. Transport stubbed.
- `storage`: insert/get/purge round-trip with the new `tier` CHECK; a disallowed value is rejected.

## Out of scope (unchanged phasing)
View decomposition (own task), YPT feed (v2), bias-mitigation (run-twice), duration-based effort gate. This work ends at: **`mileage judge` produces calibrated 4-tier yield verdicts, reviewable in `judge:list`.**
