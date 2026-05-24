# Mileage — Attribution Sharpening (Concurrency-Aware) Design Spec

**Date:** 2026-05-24
**Status:** Draft
**Goal:** Raise session→commit attribution coverage by leaning on the concurrency-safe in-session signal that is currently being discarded ~9 times out of 10, while making the time-window fallback safe for a user who runs **multiple Claude Code instances in parallel**. Honest under-attribution beats confident mis-attribution.

This is **Part 1 of 3** in the effectiveness work. It is the deterministic foundation; the other two get their own specs:

1. **Attribution sharpening (this spec)** — the data foundation. Improves both Cost-per-Ship and the future effectiveness view.
2. **Flat-rate effectiveness view** — headroom + honest confidence buckets ("shipped / likely / can't-tell"), with no-commit sessions framed as neutral, not waste.
3. **Targeted local LLM judge** — intent-reading for the small slice of ambiguous high-effort sessions. Seam defined here, built later.

---

## Why now — the empirical motivation

Measured against the user's own data (214 sessions, 2026-05-08→24):

- **Attribution coverage is the bottleneck:** only **16 / 214 sessions (7.5%)** have an attributed commit, despite **104 commits** in the DB.
- **The direct detector is starved by its own regex.** Of **253** `git commit` Bash commands in the JSONL, only **27 (10%)** *start with* `git commit` — the only shape the current detector matches. **226 (89%)** are compound (`git add … && git commit`, `cd "…" && git commit`, heredoc messages) and are silently missed, dropping to the fragile 5-minute time-window guess.
- **Self-tags are unused** (212/214 untagged), so attribution cannot lean on them.

The single highest-leverage, model-free fix is recovering the compound-command direct signal. It is also **concurrency-safe**: the commit hash comes from *that session's own* tool output, so parallel instances cannot steal each other's commits.

---

## Scope

### What we ARE building

- **Broadened direct-commit detection** in `claude_code.ts` — catch `git commit` as a sub-command, not just at string start.
- **Activation of the unused `high` tier** in `attribution.ts` — the schema already allows `direct|high|inferred`, but only two are ever written.
- **Concurrency-aware inferred/high logic** keyed on a session's *active span*, project-scoped, that **abstains** rather than guesses when concurrent same-repo sessions are ambiguous.
- **Tests** against the real command shapes and a concurrent-sessions scenario.

### What we are NOT building (defers)

- **Effectiveness view / confidence buckets** — Part 2.
- **Local LLM judge** — Part 3.
- **Commit-file-path ↔ session-touched-path matching** (a privacy-safe `high+` booster). Strong future signal; adds complexity. Noted under *Future levers*.
- **Ingesting commits from repos Mileage was never pointed at** — a direct hint whose hash is not in `events` is still dropped (see *Known limitations*).

### What changes for users

Internal accuracy change, no new UI surface. Cost-per-Ship and attributed-commit counts become materially more complete and more honest. `mileage rebuild` continues to reproduce identical snapshots.

---

## The design

### Change 1 — Broaden direct detection (`src/ingest/claude_code.ts`)

`extractCommitHintsFromSegment` currently gates on:

```js
if (/^\s*git\s+commit\b/.test(cmd) && typeof c.id === 'string')
```

Replace the start-anchored test with a **sub-command scan**. Split the Bash command on top-level separators (`&&`, `;`, newline, `|`) and treat a fragment as a commit invocation if it matches `^\s*git\s+commit\b` after trimming. Equivalent regex form:

```js
/(?:^|&&|;|\n|\|)\s*git\s+commit\b/
```

This catches `git add -A && git commit …`, `cd "…" && git commit …`, and heredoc-message commits (the `git commit -m "$(cat <<'EOF'` fragment still begins a sub-command). It rejects decoys like `echo "fix the git commit bug"` because the literal is not preceded by a command separator. Hash extraction from the tool result (`COMMIT_HASH_RE`) is unchanged and already handles the `[branch hash]` line regardless of any `cd` prefix.

**Stored fields unchanged:** `ToolCommitHint` remains `{ session_id, commit_hash, timestamp }`. Command strings are read transiently and never persisted.

### Change 2 — Active-span candidates + the `high` tier (`src/ingest/attribution.ts`)

`attributeInferred` currently selects sessions whose `session_end_ms` lands within `±5 min` of the commit, then picks the nearest end. This misses commits made *mid-session* (a long session's end is far from the commit) and is anchored on the wrong instant.

Replace with **active-span containment**, project-scoped (the existing `project_hash` filter is correct and stays):

> A session *spans* a commit at time `t` if `session.timestamp − LEAD ≤ t ≤ session.session_end_ms + GRACE`.

- `LEAD = 2 min` (clock skew before first recorded activity)
- `GRACE = 5 min` (commit issued just after the session's last activity)

Add a new query `getSessionsSpanningCommit(db, t, projectHash)` in `db.ts` returning spanning sessions. This replaces the end-anchored `getSessionsInWindow`, whose only caller is the line being changed — so that helper becomes dead code and should be removed.

### Change 3 — Resolution order (abstain over guess)

For each unattributed commit `C` (timestamp `t`, project `P`), after direct hints are applied:

1. **`direct` (conf 1.0)** — already written from a same-session commit-hint. Concurrency-safe. Skip C if present.
2. Compute `spanning = getSessionsSpanningCommit(t, P)`.
3. **`high` (conf 0.85)** — `spanning.length === 1`. The commit occurred inside exactly one same-repo session's active span; unique and strong. Concurrency-safe by uniqueness. (0.85 matches the existing `composite_outcomes.ts` weight for the tier.)
4. **Abstain** — `spanning.length ≥ 2`. Genuine concurrency: two+ same-repo sessions were active. **Leave C unattributed.** Increment a diagnostics counter (`unattributed_concurrent_ambiguous`) for reporting; write nothing. *(Approved decision: honesty over coverage.)*
5. **`inferred` (conf 0.5)** — `spanning.length === 0` (commit in a gap with no active session). Attribute to the nearest **preceding** same-repo session whose `session_end_ms` is within `PRECEDING_WINDOW = 15 min` before `t`. If none, leave unattributed.

Cross-repo links are never created by `high`/`inferred` (project-scoped). `direct` may legitimately cross repos (hash-based), subject to *Known limitations*.

### Tier / confidence semantics

| Tier | Trigger | Conf | Concurrency-safe |
|---|---|---|---|
| `direct` | commit hash found in the session's own `git commit` tool result | 1.0 | yes (in-session) |
| `high` | commit within **exactly one** same-repo session's active span, no direct hint | 0.85 | yes (unique span) |
| `inferred` | gap-time commit → nearest preceding same-repo session within 15 min | 0.5 | n/a (no overlap) |
| *(abstain)* | ≥2 same-repo sessions span the commit, no direct hint | — | leave unattributed |

---

## Contracts upheld

- **Privacy.** Only `(session_id, commit_hash, tier, confidence)` is stored. Bash command strings are read transiently for hash detection and never persisted. No diff content, no `git show`/`blame`. Unchanged from today.
- **Recomputability.** Attribution is a pure function of `events` + tool-commit hints (themselves re-derived from JSONL on ingest). `mileage rebuild` from a clean DB must produce **identical** attributions. No fix-up columns.
- **Provenance.** The `tier` + `confidence` pair *is* the attribution's provenance; downstream metrics already weight by it (`composite_outcomes.ts` uses `direct:1.0 / high:0.85 / inferred:0.5`).

---

## Error handling & edge cases

- **Unresolvable direct hash** (commit in a repo never git-ingested): `resolveFullCommitHash` returns null → skip, as today. Counted in diagnostics. See *Known limitations*.
- **Heredoc commit messages containing separators**: harmless. Spurious fragments simply fail the `^git\s+commit` test; the real fragment still matches.
- **Segmentation**: logical sessions from one `sessionId` are split by 10-min gaps and never overlap, so intra-`sessionId` concurrency cannot occur — concurrency is strictly across distinct instances.
- **Commit retries** (a failed then re-run commit): each successful `[branch hash]` line yields a hint; duplicate hints for the same `(session_id, commit_hash)` are idempotent via `INSERT OR REPLACE`.

---

## Acceptance criteria (measured against the real DB)

1. **Detection:** ≥95% of `git commit` Bash commands produce a hint (re-run the command scan; today 10%).
2. **Coverage:** attributed sessions rise materially from 16/214; `direct`-tier attributions multiply (measure post-fix, before/after on the existing DB).
3. **No cross-repo inferred/high attributions.**
4. **No conf-0.5 attribution written** when ≥2 same-repo sessions span a commit (abstain verified).
5. **Idempotent rebuild:** two `mileage rebuild` runs yield byte-identical `attributions` rows.

---

## Testing strategy

- **Unit — command detection:** `git add -A && git commit -m x`, `cd "p" && git commit …`, heredoc `git commit -m "$(cat <<'EOF' …`, plain `git commit`, and decoy `echo "git commit"` (must NOT match).
- **Unit — resolution order:** single spanning session → `high`; two concurrent same-repo spanning sessions → abstain (zero rows written); gap commit → nearest preceding `inferred`; cross-repo candidates excluded.
- **Integration — rebuild idempotency** on a fixture DB.
- **Empirical check:** re-run the temp coverage scan; record before/after attributed-session counts in the plan's verification step.

---

## Known limitations

- Direct hints for commits in repos Mileage has never ingested are dropped (no commit metadata to attach). A future enhancement could persist "pending" session→hash links and resolve them if/when that repo is ingested.
- `high`/`inferred` are blind to user-typed terminal commits in a repo with concurrent same-repo sessions — by design, these abstain.

## Future levers (out of scope)

- **`high+` via path matching:** match a commit's changed file *paths* (already parsed, privacy-safe) against the file paths a session touched in its tool calls. Would rescue many abstained/gap commits without an LLM. Candidate for a later iteration.
