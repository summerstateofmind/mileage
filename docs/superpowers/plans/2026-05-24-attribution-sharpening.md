# Attribution Sharpening (Concurrency-Aware) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the ~89% of `git commit` commands the direct-attribution detector currently misses, and make time-window attribution safe for a user running multiple Claude Code instances in parallel — by abstaining instead of guessing when concurrent same-repo sessions are ambiguous.

**Architecture:** Three small, isolated changes. (1) A pure `isGitCommitCommand` predicate broadens direct detection in the JSONL parser. (2) A pure `decideAttribution` function plus two project-scoped DB queries (`getSessionsSpanningCommit`, `getPrecedingSessions`) replace the fragile end-anchored 5-minute window with active-span containment that emits the `high` tier and abstains under concurrency. (3) The sync summary is relabeled for honesty. Pure functions are unit-tested with no DB; queries and wiring are integration-tested against an in-memory SQLite DB.

**Tech Stack:** TypeScript (strict), Node ≥18 (dev/test on Node 24), `node:sqlite` (`DatabaseSync`), `node:test` + `node:assert/strict` (built-in, no new dependency). Build with `tsc`; tests run from compiled `dist`.

**Spec:** `docs/superpowers/specs/2026-05-24-attribution-sharpening-design.md`

---

## Conventions for every task

- **Test workflow:** tests are `*.test.ts` co-located in `src/`. `npm test` runs `tsc` then `node --test`. During a "red" step where a test imports a not-yet-created export, `tsc` fails the build with `TS2305: Module … has no exported member …` — that compile error **is** the red signal (no tests run until it compiles).
- **Staging:** the working tree has unrelated V0.3 work-in-progress. **Never `git add -A`.** Each commit stages only the exact paths listed in that task.
- **Commit trailer:** end every commit message with the Co-Authored-By trailer (shown in full in Task 1; include it in all subsequent commits).
- **No-auto-commit:** the executor surfaces each task's diff + test output for the user's OK before committing (per project CLAUDE.md).

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `package.json` | scripts | **Modify** — add `test` script |
| `src/ingest/claude_code.ts` | JSONL parse + commit-hint extraction | **Modify** — add/use `isGitCommitCommand` |
| `src/ingest/claude_code.test.ts` | predicate tests | **Create** |
| `src/ingest/attribution.ts` | session→commit linking | **Modify** — constants, `decideAttribution`, rewrite `attributeInferred`, fix imports |
| `src/ingest/attribution.test.ts` | decision + integration tests | **Create** |
| `src/storage/db.ts` | SQL helpers | **Modify** — add span/preceding queries, remove dead `getSessionsInWindow` |
| `src/storage/db.test.ts` | query tests | **Create** |
| `src/cli.ts` | sync wiring + summary | **Modify** — relabel summary line only |

---

## Task 1: Broaden direct-commit detection + establish test harness

**Files:**
- Modify: `package.json` (scripts)
- Create: `src/ingest/claude_code.test.ts`
- Modify: `src/ingest/claude_code.ts` (add `isGitCommitCommand`; use it at the current line 269 gate)

- [ ] **Step 1: Add the `test` script to `package.json`**

In the `"scripts"` block, add a `test` entry (note the escaped quotes around the glob):

```json
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/cli.js",
    "clean": "rimraf dist",
    "test": "tsc && node --test \"dist/**/*.test.js\""
  },
```

- [ ] **Step 2: Write the failing test**

Create `src/ingest/claude_code.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGitCommitCommand } from './claude_code';

test('isGitCommitCommand: plain commit', () => {
  assert.equal(isGitCommitCommand('git commit -m "x"'), true);
});

test('isGitCommitCommand: add && commit (the common shape)', () => {
  assert.equal(isGitCommitCommand('git add -A && git commit -m "x"'), true);
});

test('isGitCommitCommand: cd into repo && commit', () => {
  assert.equal(isGitCommitCommand('cd "C:/Users/x/p" && git commit -m "x"'), true);
});

test('isGitCommitCommand: heredoc commit message', () => {
  const cmd = 'git add . && git commit -m "$(cat <<\'EOF\'\nmsg line\nEOF\n)"';
  assert.equal(isGitCommitCommand(cmd), true);
});

test('isGitCommitCommand: decoy inside echo is NOT a commit', () => {
  assert.equal(isGitCommitCommand('echo "fix the git commit bug"'), false);
});

test('isGitCommitCommand: other git subcommands are NOT commits', () => {
  assert.equal(isGitCommitCommand('git add -A'), false);
  assert.equal(isGitCommitCommand('git status'), false);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: build fails with `error TS2305: Module '"./claude_code"' has no exported member 'isGitCommitCommand'.`

- [ ] **Step 4: Implement `isGitCommitCommand` and use it**

In `src/ingest/claude_code.ts`, add this exported function near the top (e.g., directly below the `COMMIT_HASH_RE` constant on line 14):

```ts
// Matches `git commit` as a sub-command: at string start or after a shell
// separator (&& ; | newline). This catches `git add -A && git commit …`,
// `cd "p" && git commit …`, and heredoc messages — the 89% of real commit
// commands the old start-anchored test missed. A literal inside an argument
// (e.g. echo "git commit") is not preceded by a separator, so it won't match.
export function isGitCommitCommand(cmd: string): boolean {
  return /(?:^|&&|;|\||\n)\s*git\s+commit\b/.test(cmd);
}
```

Then replace the gate inside `extractCommitHintsFromSegment` (currently line 269):

```ts
        if (isGitCommitCommand(cmd) && typeof c.id === 'string') {
```

(was `if (/^\s*git\s+commit\b/.test(cmd) && typeof c.id === 'string') {`)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: `tests 6 … pass 6 … fail 0`.

- [ ] **Step 6: Commit**

```bash
git add package.json src/ingest/claude_code.ts src/ingest/claude_code.test.ts
git commit -m "feat: detect git commit in compound commands (direct attribution)" -m "Old detector only matched commands starting with 'git commit', missing ~89% (git add && git commit, cd && commit). Adds isGitCommitCommand + node:test harness." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Pure attribution decision function + span constants

**Files:**
- Modify: `src/ingest/attribution.ts` (add constants + `decideAttribution`)
- Modify: `src/ingest/attribution.test.ts` → **Create** (decision-only tests; integration tests added in Task 4)

- [ ] **Step 1: Write the failing test**

Create `src/ingest/attribution.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAttribution } from './attribution';

test('decide: exactly one spanning session → high 0.85', () => {
  const d = decideAttribution([{ session_id: 's1', session_end_ms: 100 }], []);
  assert.deepEqual(d, { session_id: 's1', tier: 'high', confidence: 0.85 });
});

test('decide: two spanning sessions → abstain (null)', () => {
  const d = decideAttribution(
    [
      { session_id: 's1', session_end_ms: 100 },
      { session_id: 's2', session_end_ms: 110 },
    ],
    [],
  );
  assert.equal(d, null);
});

test('decide: no spanning, picks nearest preceding → inferred 0.5', () => {
  const d = decideAttribution(
    [],
    [
      { session_id: 'old', session_end_ms: 100 },
      { session_id: 'recent', session_end_ms: 500 },
    ],
  );
  assert.deepEqual(d, { session_id: 'recent', tier: 'inferred', confidence: 0.5 });
});

test('decide: no spanning, no preceding → null', () => {
  assert.equal(decideAttribution([], []), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: build fails with `error TS2305: Module '"./attribution"' has no exported member 'decideAttribution'.`

- [ ] **Step 3: Implement the constants, types, and function**

In `src/ingest/attribution.ts`, **insert** the following block immediately above the existing `const INFERRED_WINDOW_MS = 5 * 60_000;` line (line 10). **Leave `INFERRED_WINDOW_MS` in place** — Task 4 removes it when `attributeInferred` is rewritten. Change nothing else in this task:

```ts
export const SPAN_LEAD_MS = 2 * 60_000; // clock-skew lead before first recorded activity
export const SPAN_GRACE_MS = 5 * 60_000; // commit issued just after a session's last activity
export const PRECEDING_WINDOW_MS = 15 * 60_000; // gap-commit → nearest prior session

export interface AttrCandidate {
  session_id: string;
  session_end_ms: number;
}

export interface AttrDecision {
  session_id: string;
  tier: 'high' | 'inferred';
  confidence: number;
}

// Pure resolution policy. `spanning` and `preceding` are same-project candidates
// already filtered by the caller. Honesty over coverage: abstain (null) when two+
// sessions span the commit, because concurrent instances make the link a coin flip.
export function decideAttribution(
  spanning: AttrCandidate[],
  preceding: AttrCandidate[],
): AttrDecision | null {
  if (spanning.length === 1) {
    return { session_id: spanning[0].session_id, tier: 'high', confidence: 0.85 };
  }
  if (spanning.length >= 2) {
    return null;
  }
  if (preceding.length === 0) return null;
  let best = preceding[0];
  for (const s of preceding) {
    if (s.session_end_ms > best.session_end_ms) best = s;
  }
  return { session_id: best.session_id, tier: 'inferred', confidence: 0.5 };
}
```

`attributeInferred` still uses `INFERRED_WINDOW_MS` until Task 4, so the project keeps compiling.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `tests 10 … pass 10 … fail 0` (6 from Task 1 + 4 here).

- [ ] **Step 5: Commit**

```bash
git add src/ingest/attribution.ts src/ingest/attribution.test.ts
git commit -m "feat: add concurrency-aware decideAttribution policy + span constants" -m "(include Co-Authored-By trailer)"
```

---

## Task 3: Active-span + preceding DB queries

**Files:**
- Modify: `src/storage/db.ts` (add two queries; keep `getSessionsInWindow` for now)
- Create: `src/storage/db.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/storage/db.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';
import { insertSession, getSessionsSpanningCommit, getPrecedingSessions } from './db';
import type { SessionEvent } from './types';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function session(id: string, start: number, end: number, project = 'P'): SessionEvent {
  return {
    id,
    timestamp: start,
    type: 'session',
    source: 'claude_code',
    project_hash: project,
    session_id: id,
    tokens_in: 1,
    tokens_out: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    pricing_version: 'test',
    pricing_fallback: false,
    model_id: 'm',
    session_end_ms: end,
  };
}

test('spanning: commit inside [start,end] matches', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000));
  const rows = getSessionsSpanningCommit(db, 3000, 'P', 0, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 's1');
});

test('spanning: grace lets a commit just after end match; without grace it does not', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000));
  assert.equal(getSessionsSpanningCommit(db, 6000, 'P', 0, 0).length, 0);
  assert.equal(getSessionsSpanningCommit(db, 6000, 'P', 0, 2000).length, 1);
});

test('spanning: other project is excluded', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000, 'OTHER'));
  assert.equal(getSessionsSpanningCommit(db, 3000, 'P', 0, 0).length, 0);
});

test('preceding: returns same-project sessions ended within the window before the commit', () => {
  const db = memDb();
  insertSession(db, session('old', 100, 1000));
  insertSession(db, session('recent', 2000, 4000));
  const rows = getPrecedingSessions(db, 5000, 'P', 2000); // window end_ms in [3000,5000]
  assert.deepEqual(
    rows.map((r) => r.session_id),
    ['recent'],
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: build fails with `error TS2305: Module '"./db"' has no exported member 'getSessionsSpanningCommit'.`

- [ ] **Step 3: Implement the two queries**

In `src/storage/db.ts`, add near the other session queries:

```ts
export interface SessionSpanRow {
  session_id: string;
  session_end_ms: number;
}

// Sessions whose active span [timestamp - leadMs, session_end_ms + graceMs]
// contains commitTs, restricted to one project. Used for the `high` tier and
// the concurrency-abstain check.
export function getSessionsSpanningCommit(
  db: DatabaseSync,
  commitTs: number,
  projectHash: string,
  leadMs: number,
  graceMs: number,
): SessionSpanRow[] {
  return db
    .prepare(
      `SELECT session_id, session_end_ms FROM events
       WHERE type = 'session'
         AND project_hash = ?
         AND (timestamp - ?) <= ?
         AND ? <= (session_end_ms + ?)`,
    )
    .all(projectHash, leadMs, commitTs, commitTs, graceMs) as unknown as SessionSpanRow[];
}

// Same-project sessions that ended within windowMs before commitTs (gap-commit
// fallback). Used only when no session spans the commit.
export function getPrecedingSessions(
  db: DatabaseSync,
  commitTs: number,
  projectHash: string,
  windowMs: number,
): SessionSpanRow[] {
  return db
    .prepare(
      `SELECT session_id, session_end_ms FROM events
       WHERE type = 'session'
         AND project_hash = ?
         AND session_end_ms <= ?
         AND session_end_ms >= (? - ?)`,
    )
    .all(projectHash, commitTs, commitTs, windowMs) as unknown as SessionSpanRow[];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test`
Expected: `tests 14 … pass 14 … fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/storage/db.ts src/storage/db.test.ts
git commit -m "feat: add active-span and preceding-session attribution queries" -m "(include Co-Authored-By trailer)"
```

---

## Task 4: Rewire `attributeInferred` to span-based, concurrency-aware logic

**Files:**
- Modify: `src/ingest/attribution.ts` (rewrite `attributeInferred`, fix imports, remove `INFERRED_WINDOW_MS`)
- Modify: `src/storage/db.ts` (remove now-dead `getSessionsInWindow`)
- Modify: `src/ingest/attribution.test.ts` (add integration tests)

- [ ] **Step 1: Write the failing integration tests**

Append to `src/ingest/attribution.test.ts` (add these imports at the top of the file, after the existing ones):

```ts
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../storage/schema';
import { insertSession, insertCommit } from '../storage/db';
import { attributeInferred } from './attribution';
import type { SessionEvent, CommitEvent } from '../storage/types';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

function session(id: string, start: number, end: number, project = 'P'): SessionEvent {
  return {
    id,
    timestamp: start,
    type: 'session',
    source: 'claude_code',
    project_hash: project,
    session_id: id,
    tokens_in: 1,
    tokens_out: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    pricing_version: 'test',
    pricing_fallback: false,
    model_id: 'm',
    session_end_ms: end,
  };
}

function commit(hash: string, ts: number, project = 'P'): CommitEvent {
  return {
    id: `git:${hash}`,
    timestamp: ts,
    type: 'commit',
    source: 'git',
    project_hash: project,
    commit_hash: hash,
    lines_added: 10,
    lines_removed: 0,
    files_changed: 1,
    primary_language: 'ts',
    branch: 'main',
  };
}

test('attributeInferred: a commit inside one session span gets the high tier', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 10000));
  insertCommit(db, commit('hash1', 5000));
  const n = attributeInferred(db, 0);
  assert.equal(n, 1);
  const row = db
    .prepare(`SELECT session_id, tier, confidence FROM attributions`)
    .get() as { session_id: string; tier: string; confidence: number };
  assert.equal(row.session_id, 's1');
  assert.equal(row.tier, 'high');
  assert.equal(row.confidence, 0.85);
});

test('attributeInferred: two concurrent same-repo sessions → abstain (no row)', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 10000));
  insertSession(db, session('s2', 2000, 11000));
  insertCommit(db, commit('hash1', 5000));
  const n = attributeInferred(db, 0);
  assert.equal(n, 0);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM attributions`).get() as { c: number };
  assert.equal(count.c, 0);
});

test('attributeInferred: gap commit attaches to nearest preceding session as inferred', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000));
  insertCommit(db, commit('hash1', 5000 + 10 * 60_000)); // 10 min after end → in 15-min window, outside 5-min grace
  const n = attributeInferred(db, 0);
  assert.equal(n, 1);
  const row = db
    .prepare(`SELECT session_id, tier FROM attributions`)
    .get() as { session_id: string; tier: string };
  assert.equal(row.session_id, 's1');
  assert.equal(row.tier, 'inferred');
});

test('attributeInferred: idempotent — running twice yields one row', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 10000));
  insertCommit(db, commit('hash1', 5000));
  attributeInferred(db, 0);
  attributeInferred(db, 0);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM attributions`).get() as { c: number };
  assert.equal(count.c, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the four new tests FAIL on assertions — the old logic writes `tier: 'inferred'` / `confidence: 0.5` where `high` / `0.85` is expected, and writes a row for the concurrent case where `0` is expected. (e.g. `Expected values to be equal: 'inferred' !== 'high'`.)

- [ ] **Step 3: Rewrite `attributeInferred` and fix imports**

In `src/ingest/attribution.ts`, update the import block at the top to drop `getSessionsInWindow` and add the new queries:

```ts
import {
  insertAttribution,
  resolveFullCommitHash,
  getUnattributedCommitsSince,
  getSessionsSpanningCommit,
  getPrecedingSessions,
} from '../storage/db';
```

Remove the now-unused `const INFERRED_WINDOW_MS = 5 * 60_000;` line. Replace the entire `attributeInferred` function body with:

```ts
// Emits `high` (unique same-repo session spanning the commit) or `inferred`
// (gap commit → nearest preceding same-repo session), and abstains when two+
// same-repo sessions span the commit. `direct` hints are applied separately.
export function attributeInferred(db: DatabaseSync, sinceMs: number): number {
  const commits = getUnattributedCommitsSince(db, sinceMs);
  let written = 0;
  for (const c of commits) {
    const spanning = getSessionsSpanningCommit(
      db,
      c.timestamp,
      c.project_hash,
      SPAN_LEAD_MS,
      SPAN_GRACE_MS,
    );
    const preceding =
      spanning.length === 0
        ? getPrecedingSessions(db, c.timestamp, c.project_hash, PRECEDING_WINDOW_MS)
        : [];
    const decision = decideAttribution(spanning, preceding);
    if (!decision) continue;
    insertAttribution(db, {
      session_id: decision.session_id,
      commit_hash: c.commit_hash,
      tier: decision.tier,
      confidence: decision.confidence,
    });
    written++;
  }
  return written;
}
```

- [ ] **Step 4: Remove the dead `getSessionsInWindow` from `src/storage/db.ts`**

Delete the entire `getSessionsInWindow` function (the `export function getSessionsInWindow(...) { … }` block, ~lines 245–260). Its only caller was the line just rewritten.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: `tests 18 … pass 18 … fail 0`.

- [ ] **Step 6: Commit**

```bash
git add src/ingest/attribution.ts src/ingest/attribution.test.ts src/storage/db.ts
git commit -m "feat: span-based, concurrency-aware commit attribution (high tier + abstain)" -m "Replaces the end-anchored 5-min window. A commit inside exactly one same-repo session span -> high (0.85); two+ spanning sessions -> abstain; gap commits -> nearest preceding session (inferred). Removes dead getSessionsInWindow." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Honest sync summary label + empirical verification

**Files:**
- Modify: `src/cli.ts` (summary string only)

- [ ] **Step 1: Relabel the summary**

`attributeInferred` now also produces `high`-tier links, so "inferred" in the summary is no longer accurate. In `src/cli.ts`, in the `console.log` inside `runSync` (around line 74), change:

```ts
      `${direct + inferred} attributions (${direct} direct, ${inferred} inferred), ` +
```
to:
```ts
      `${direct + inferred} attributions (${direct} direct, ${inferred} by time-window), ` +
```

- [ ] **Step 2: Build and spot-run the CLI**

Run: `npm run build`
Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "chore: relabel sync summary (time-window covers high + inferred)" -m "(include Co-Authored-By trailer)"
```

- [ ] **Step 4: Empirical verification on the real DB (manual; user-run)**

These confirm the spec's acceptance criteria. Run and record results — do not commit anything.

1. **Detection rate ≥95%** (spec criterion 1). Re-run the temp command scan, but swap its predicate to the shipped one. Quick check:

```bash
node -e "const {isGitCommitCommand}=require('./dist/ingest/claude_code'); const fs=require('fs'),path=require('path'),os=require('os'); let total=0,hit=0; (function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p); else if(e.name.endsWith('.jsonl')){for(const line of fs.readFileSync(p,'utf8').split(/\r?\n/)){if(!line||line.indexOf('git commit')<0)continue; let j;try{j=JSON.parse(line)}catch{continue} const c=j?.message?.content; if(!Array.isArray(c))continue; for(const x of c){if(x?.type==='tool_use'&&x?.name==='Bash'&&typeof x?.input?.command==='string'&&/git\s+commit\b/.test(x.input.command)){total++; if(isGitCommitCommand(x.input.command))hit++;}}}}}})(path.join(os.homedir(),'.claude','projects')); console.log('detected',hit,'/',total, total?(100*hit/total|0)+'%':'');"
```
Expected: ≥95% (baseline was 10%).

2. **Coverage jump** (spec criterion 2). Run `mileage sync` then check attribution counts:

```bash
node dist/cli.js sync --since 30d
```
Expected: the summary's attribution count is materially higher than before (baseline: 16 attributed sessions / ~21 attributions). Optionally compare `SELECT tier, COUNT(*) FROM attributions GROUP BY tier`.

3. **No cross-repo / no concurrent-guess** (criteria 3–4): covered by the Task 3 and Task 4 tests. Idempotency (criterion 5) is covered by the Task 4 "running twice" test — note there is **no `mileage rebuild` command**; idempotency holds via the `attributions` primary key + `INSERT OR REPLACE`, exercised by re-running `sync`.

---

## Self-Review

**Spec coverage:**
- Change 1 (broaden direct detection) → Task 1. ✓
- Change 2 (`high` tier + active-span) → Tasks 2–4. ✓
- Change 3 (concurrency-aware inferred, abstain) → Tasks 2 (policy) + 4 (wiring). ✓
- Tier/confidence table (direct 1.0 / high 0.85 / inferred 0.5) → Task 2 values + Task 4 assertions. ✓
- Privacy (store only 4 fields; read command strings transiently) → unchanged; `ToolCommitHint` and `insertAttribution` untouched. ✓
- Dead `getSessionsInWindow` removed → Task 4 Step 4. ✓
- Acceptance criteria 1–2 → Task 5 Step 4 (manual). Criteria 3–5 → automated tests. ✓
- **Deviation from spec:** criterion 5 referenced `mileage rebuild`, which does not exist in the CLI. Idempotency is instead verified at the attribution-function level (Task 4) and via re-running `sync`. No rebuild command is built (out of scope). Flagged to the user.

**Placeholder scan:** none — every code step shows complete code; every run step shows the exact command and expected output.

**Type consistency:** `AttrCandidate { session_id, session_end_ms }` (Task 2) is structurally satisfied by `SessionSpanRow { session_id, session_end_ms }` (Task 3) returned from the queries and passed into `decideAttribution` (Task 4). `attributeInferred(db, sinceMs): number` signature is unchanged, so `cli.ts:64` needs no edit. `decideAttribution(spanning, preceding)` arity matches its single call site.

**Ordering safety:** `INFERRED_WINDOW_MS` and `getSessionsInWindow` are removed only in Task 4, after the rewrite stops referencing them — every intermediate task compiles.
