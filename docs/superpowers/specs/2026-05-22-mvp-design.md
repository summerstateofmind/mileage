# Mileage V0.1 MVP — Design Spec

**Date:** 2026-05-22
**Status:** Draft
**Goal:** Ship the smallest version of Mileage that runs on the author's terminal, reads their actual Claude Code JSONL and a local git repo, and prints a real YPT number — proving the core loop works before anything else is added.

---

## User Journey

```
[1: Author runs `npm run build && npm link` once]
  -> `mileage` binary is on PATH
       |
[2: Author runs `mileage sync` from any git repo]
  -> Mileage finds ~/.mileage/metrics.db (creates if missing)
  -> Scans ~/.claude/projects/ for JSONL files modified in last 90d
  -> Parses each: emits session events (tokens, model, timestamps, tool calls)
  -> Reads git log of cwd: emits commit events
  -> Runs three-tier attribution: Direct (from JSONL tool calls) > Inferred (timestamp proximity)
  -> Computes snapshots per day per project (YPT, Cost-per-Ship)
  -> Prints: "Synced 47 sessions, 23 commits, 19 attributions across 3 projects"
       |
[3: Author runs `mileage show`]
  -> Reads snapshots, prints last 7 days summary:
       Last 7 days
         YPT:           47.3  (+5.2 vs prior 7d)
         Cost-per-Ship: 8,400 tokens / commit
         Tokens used:   612,000
         Commits:       28 (22 attributed)
  -> Prints per-project breakdown if >1 project
       |
[4: Author runs `mileage explain ypt`]
  -> Prints formula, inputs from most recent snapshot, arxiv citation
       |
[5: Terminal state — author trusts the number, ready for V0.2]
```

**Key decisions:**

- **CLI-only, no daemon yet.** Manual `mileage sync` is fine for V0.1. The post-commit hook + watcher are V0.2 — they add complexity not needed to prove the core loop.
- **JSONL parsing is the highest-risk component.** It's where 51–55% duplicate entries, placeholder token values, and undocumented field shapes will bite. Build it second (after storage) and write tests against real JSONL samples from the author's machine.
- **Three-tier attribution, but only Direct + Inferred in V0.1.** High-confidence (git hook) is V0.2 — it requires the user to install a hook, which is friction we don't want for the first run.
- **Daily aggregation, not per-session.** YPT is a trend metric; per-session is noise. Snapshots are keyed by (date, project_hash).
- **Project scoping by `project_hash` derived from the cwd's git remote URL.** Single-project users see one breakdown; multi-project users see comparison.
- **No GitHub API in V0.1.** Git-only must work standalone. The whole point of metric tiering is that git-only is the floor, not a degraded mode.
- **Rejected: TUI library (Ink, blessed).** Plain `console.log` + a tiny ANSI helper is enough. TUI adds bundle weight and a maintenance surface for zero V0.1 value.

---

## Database Schema

### New table: `events`

One row per atomic data point. Nullable columns let one table hold heterogeneous event types without a sparse join.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID v4 |
| `timestamp` | INTEGER | Unix ms |
| `type` | TEXT | `session` \| `commit` |
| `source` | TEXT | `claude_code` \| `git` |
| `project_hash` | TEXT | SHA256 of remote URL or abs path. Indexed. |
| `created_at` | INTEGER | Unix ms — when Mileage ingested this row |
| **session-only:** | | |
| `session_id` | TEXT | Claude Code session UUID |
| `tokens_in` | INTEGER | input tokens |
| `tokens_out` | INTEGER | output tokens |
| `cost_usd` | REAL | computed or read from JSONL `cost_usd` field |
| `model_id` | TEXT | e.g. `claude-opus-4-7` |
| `session_end_ms` | INTEGER | Last message timestamp in session |
| **commit-only:** | | |
| `commit_hash` | TEXT | Full 40-char SHA |
| `lines_added` | INTEGER | Sum across files |
| `lines_removed` | INTEGER | Sum across files |
| `files_changed` | INTEGER | |
| `primary_language` | TEXT | Most-changed file's extension |
| `branch` | TEXT | |

**Indexes:**
- `(project_hash, timestamp)` — primary access pattern for snapshot compute
- `(type, timestamp)` — fast type-scoped scans
- `session_id` UNIQUE WHERE type='session' — dedup guard
- `commit_hash` UNIQUE WHERE type='commit' — dedup guard

### New table: `attributions`

Maps sessions → commits with a confidence tier. Many-to-many (a session can produce multiple commits; a commit can have multiple attributed sessions, e.g. when a long debug session is split across two commits).

| Column | Type | Notes |
|---|---|---|
| `session_id` | TEXT | FK events.session_id |
| `commit_hash` | TEXT | FK events.commit_hash |
| `tier` | TEXT | `direct` \| `high` \| `inferred` |
| `confidence` | REAL | 1.0, 0.75, 0.5 for direct/high/inferred respectively |
| `created_at` | INTEGER | Unix ms |

**Constraints:** `PRIMARY KEY (session_id, commit_hash)` — idempotent re-attribution.

### New table: `snapshots`

Computed daily aggregates. Recomputable from events + attributions.

| Column | Type | Notes |
|---|---|---|
| `date` | TEXT | `YYYY-MM-DD` (UTC) |
| `project_hash` | TEXT | |
| `total_tokens_in` | INTEGER | |
| `total_tokens_out` | INTEGER | |
| `total_cost_usd` | REAL | |
| `session_count` | INTEGER | |
| `commit_count` | INTEGER | |
| `attributed_commit_count` | INTEGER | direct + inferred |
| `direct_attribution_count` | INTEGER | |
| `inferred_attribution_count` | INTEGER | |
| `ypt_score` | REAL | the hero number |
| `cost_per_ship_tokens` | REAL | total_tokens / attributed_commit_count |
| `cost_per_ship_usd` | REAL | total_cost_usd / attributed_commit_count |
| `provenance` | TEXT | JSON: formula, inputs, source |
| `computed_at` | INTEGER | Unix ms |

**Constraints:** `PRIMARY KEY (date, project_hash)` — one row per project per day.

### Migrations

Single SQL file at `src/storage/schema.sql`. V0.1 = schema v1. Track schema version in a tiny `meta` table (`key`, `value`). Migration logic is "if no schema version, run schema.sql; else error" for V0.1. Real migrations land when V0.2 changes the shape.

---

## Module Surfaces

### `src/storage/db.ts`

- `openDb(): Database` — opens/creates `~/.mileage/metrics.db`, applies schema if needed
- `insertEvent(db, event): void` — INSERT OR IGNORE (idempotency via UNIQUE indexes)
- `insertAttribution(db, attr): void` — INSERT OR REPLACE (re-attribution updates tier)
- `upsertSnapshot(db, snap): void`
- `getSnapshots(db, { since, projectHash? }): Snapshot[]`
- `getRecentSessions(db, { hours }): SessionEvent[]` — used by attribution
- `getRecentCommits(db, { hours, projectHash }): CommitEvent[]` — used by attribution

### `src/storage/paths.ts`

- `mileageDir(): string` — `~/.mileage/` (creates if missing)
- `mileageDbPath(): string`
- `claudeProjectsDir(): string` — `~/.claude/projects/`
- `projectHashFromCwd(): string` — `git config --get remote.origin.url` fallback to `process.cwd()`, SHA256

### `src/ingest/claude_code.ts`

- `parseJsonlFile(path: string): SessionEvent[]` — full file → list of session events
- `findJsonlFilesModifiedSince(ts: number): string[]` — scans `~/.claude/projects/`
- `ingestClaudeCode(db: Database, since: number): { sessionCount: number; jsonlToolCommits: ToolCommitHint[] }`

**JSONL parser details:**
- Read line-by-line (streaming), skip empty lines, `JSON.parse` each
- Dedup by `messageId` (some entries are streaming chunks repeating the same id)
- Detect session boundaries: gap >10min between entries within the same `sessionId` = new logical session (rare but happens — log file may have multiple sessions if Claude Code restarted)
- Token extraction: prefer `message.usage.input_tokens` / `output_tokens` from assistant turns; ignore zero/null values
- Cost extraction: prefer `costUSD` field if present; else compute from tokens × model price table (V0.1: hardcoded for current Anthropic models)
- Tool-call extraction: for entries with `type: "tool_use"` and `name: "Bash"` whose input matches `^git commit`, capture the tool_result's stdout and regex `^\[(\S+)\s+([a-f0-9]{7,40})\]` for branch + commit hash → emit `ToolCommitHint { sessionId, commitHash, timestamp }`

### `src/ingest/git.ts`

- `gitLogSince(cwd: string, since: number): CommitEvent[]` — runs `git log --numstat --pretty=format:'COMMIT|%H|%ct|%P|%D' --since=@<unix> HEAD`
- Parses the custom format (custom delimiters survive arbitrary commit messages we never read)
- Aggregates `--numstat` lines per commit; computes total +/-, file count, primary language from extensions
- `gitRemoteHash(cwd: string): string` — for project_hash

### `src/ingest/attribution.ts`

- `attributeDirect(db, toolCommitHints): number` — writes tier=`direct`, conf=1.0
- `attributeInferred(db, windowMinutes=5): number` — for unattributed commits, find sessions whose `session_end_ms` is within `windowMinutes` of commit timestamp on same project; writes tier=`inferred`, conf=0.5
- Returns counts for the sync summary line

### `src/compute/ypt.ts`

- `computeSnapshotsSince(db, since: number): number` — for each (date, project_hash) in range, compute snapshot row
- `yptScore(inputs): { score: number; provenance: object }` — pure function, easy to test

**YPT V0.1 formula (minimal, git-only):**
```
outcome_signals = Σ over attributed commits of:
  1.0 if direct, 0.5 if inferred

token_penalty = 10 * log10(max(total_tokens, 1) / 10000)

ypt_score = outcome_signals - token_penalty
```

Code-survival, PR merge, CI, self-tag terms are stubbed in the provenance with `value: 0, reason: "v0.1 not computed"` so the schema doesn't change when V0.2 adds them.

### `src/render/show.ts`

- `renderLast7Days(db, projectHash?): string` — composes the summary block
- `renderExplain(db, metric: 'ypt'): string` — reads most recent snapshot's provenance, pretty-prints
- ANSI color helpers minimal — just `bold`, `dim`, `green`, `red` for delta arrows. Skip if `process.stdout.isTTY` is false.

### `src/cli.ts`

Subcommands:
- `mileage sync [--since 7d]` — runs full ingest + compute pipeline
- `mileage show [--project <hash>] [--days 7]` — renders the summary
- `mileage explain <metric>` — formula + provenance dump
- `mileage --version`

Hidden / V0.1 only:
- `mileage debug list-projects` — dumps known project_hashes with their git remote URLs (for the author's first-run sanity check)

---

## Edge Cases

- **Empty `~/.claude/projects/`** — `sync` prints "No Claude Code JSONL found in ~/.claude/projects/" and exits 0. Not an error.
- **Not in a git repo when `sync` runs** — sync the JSONL anyway (it's project-keyed by *Claude project*, not cwd), but emit a warning that no git events will be ingested for cwd.
- **Multiple JSONL files for one session_id** — last-write-wins on token totals (re-ingestion is allowed; UNIQUE on session_id with `INSERT OR REPLACE` semantics handled at app level: delete + insert).
- **Commit with no AI session within window** — attributed to nobody; counts toward `commit_count` but not `attributed_commit_count`. Ratio is itself a useful signal (high % unattributed = lots of manual work).
- **AI session with no commit** — counts in `session_count` and `total_tokens` but not `attributed_commit_count`. Will drag YPT down (no outcomes, all penalty). This is correct behavior — those are exploratory/wasted sessions. V0.2 self-tags will let the user mark them `exploring` to exclude.
- **Clock skew / timezone bugs** — store all timestamps as UTC unix ms. Snapshot `date` is computed in UTC. The author can re-derive local dates at render time if needed.
- **DB locked** — `better-sqlite3` is synchronous and single-process; `mileage` invocations don't compete with anything. If a future daemon (V0.2) needs concurrent reads, enable WAL mode then.
- **Huge JSONL files (>100MB)** — line-streaming parser handles this without loading into memory. Time the ingest on the author's own data during verification; if >5s, add a progress indicator.
- **Token field is `0` or missing** — skip the session entirely if both `tokens_in` and `tokens_out` are unusable. Log a count of skipped sessions in the sync summary so the author notices if it's a high fraction.
- **Negative or zero `cost_per_ship`** — guard against divide-by-zero; render as `—` when `attributed_commit_count == 0`.
- **Re-running `sync` is idempotent** — UNIQUE indexes on session_id and commit_hash prevent duplicates. Snapshot upsert overwrites with latest computation.

---

## Out of Scope (V0.1)

Explicit cuts. Captured to prevent scope creep during implementation.

- **Heatmap rendering** — V0.2. Plain summary text is enough to prove the loop.
- **Git post-commit hook installer + High-tier attribution** — V0.2.
- **Self-tag system (`mileage tag`)** — V0.2.
- **Cursor / Copilot ingestion** — V0.3. Claude Code only for now.
- **GitHub PR / CI enrichment** — V0.3.
- **Code Survival Rate, Waste Ratio computation** — V0.2 (need historical data to be meaningful anyway).
- **Quality Mode (diff static analysis)** — V0.3.
- **Web dashboard, cloud sync, multi-user** — never (see ROADMAP "Deprioritized").
- **Schema migrations beyond v1** — V0.2 when shape actually changes.
- **Cross-platform install testing** — Windows-only for V0.1 (author's machine). Verify Linux/macOS path resolution before V1.0.
- **Test coverage suite** — write tests *only* for the YPT pure function and the JSONL parser dedup logic. The rest is verifiable manually on real data.
- **NPM publish** — V1.0. `npm link` for local install.

---

## Verification Plan

End-to-end happy path the author should walk through after Phase 1 implementation:

1. `npm install && npm run build && npm link` — binary on PATH
2. `cd <a real git repo with recent commits>` 
3. `mileage debug list-projects` — confirm the author's known Claude Code projects appear
4. `mileage sync --since 7d` — should complete in <10s, print sync summary with non-zero session count
5. `mileage show` — should print a YPT number that's not NaN, not zero, not negative-infinity
6. `mileage explain ypt` — should print the formula and the actual inputs from today's snapshot
7. Spot-check: pick one commit the author remembers, confirm it appears in events table (`sqlite3 ~/.mileage/metrics.db 'select * from events where commit_hash like "abc%"'`)
8. Spot-check: pick one Claude Code session the author remembers, confirm the token count in the DB matches what the author saw in the Claude Code statusline
9. Re-run `mileage sync` immediately; confirm idempotency (counts in summary should be 0 new sessions, 0 new commits)
10. Sanity-check the YPT number: does it move in the direction the author expects when they think about their recent work? (subjective but critical — if YPT says "great day" on a day the author knows was wasted, the formula is wrong)
