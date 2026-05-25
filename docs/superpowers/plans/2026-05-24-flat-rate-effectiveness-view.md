# Flat-Rate Effectiveness View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `mileage show`'s subscription (flat-rate) view lead with a cap-headroom + Shipped/Likely/Research front-door block, and retire the `⚠ waste` label in favor of neutral per-session bucket labels.

**Architecture:** One new pure-ish compute unit (`effectiveness.ts`) buckets a window's sessions by reusing the existing `composite_outcomes` machinery. The render layer (`show.ts` `renderSubscriptionView`) gains a front-door block fed by that unit plus the existing `computeUsageCheck`; the shared top-session row swaps its waste flag for a bucket label. No schema or snapshot changes — everything is computed live and stays replayable.

**Tech Stack:** TypeScript (strict), `node:sqlite`, `node:test` + `node:assert/strict`, ANSI helpers in `src/render/ansi.ts`. Build with `tsc`; tests run from compiled `dist`.

**Spec:** `docs/superpowers/specs/2026-05-24-flat-rate-effectiveness-view-design.md`

---

## Conventions for every task
- **Test workflow:** `npm test` runs `tsc` then `node --test "dist/**/*.test.js"`. A "red" step where a test imports a missing export fails at the `tsc` build with `TS2305` — that compile error IS the red signal.
- **Staging:** the tree is clean on `main`. Never `git add -A` (there is untracked `.claude/`). Each commit stages only the listed paths.
- **Commit trailer:** end every commit message with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` (shown in Task 1; include it in all).
- **No-auto-commit:** the executor surfaces each task's diff + test output for the user's OK before committing.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/compute/effectiveness.ts` | classify a session → bucket; tally a window | **Create** |
| `src/compute/effectiveness.test.ts` | classifier rule-table + tally tests | **Create** |
| `src/render/show.ts` | terminal render; front-door block, headroom bars, bucket labels | **Modify** |
| `src/render/show.test.ts` | `fillBar` unit tests | **Create** |

---

## Task 1: `effectiveness.ts` — session classifier + window tally

**Files:**
- Create: `src/compute/effectiveness.ts`
- Create: `src/compute/effectiveness.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/compute/effectiveness.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { classifySessionBucket, bucketWindow } from './effectiveness';
import type { SessionComposite } from './composite_outcomes';
import { SCHEMA_SQL } from '../storage/schema';
import { insertSession, insertCommit, insertAttribution } from '../storage/db';
import type {
  SessionAttribution,
} from '../storage/db';
import type {
  SessionTag,
  AttributionTier,
  SessionEvent,
  CommitEvent,
} from '../storage/types';

function comp(tag: SessionTag | null): SessionComposite {
  return {
    session_id: 's',
    timestamp: 0,
    project_hash: 'P',
    tokens: 1000,
    model_id: 'm',
    tag,
    composite_outcomes: 0,
    scorable: true,
  };
}

function attr(
  tier: AttributionTier,
  lines_added = 10,
  lines_surviving: number | null = null,
): SessionAttribution {
  return {
    session_id: 's',
    tier,
    commit_hash: 'h',
    lines_added,
    lines_surviving,
    survival_window_days: lines_surviving === null ? null : 7,
  };
}

test('classify: tagged shipped → shipped (even with no attrs)', () => {
  assert.equal(classifySessionBucket(comp('shipped'), []), 'shipped');
});

test('classify: tagged exploring → research', () => {
  assert.equal(classifySessionBucket(comp('exploring'), [attr('direct')]), 'research');
});

test('classify: tagged dead-end → research', () => {
  assert.equal(classifySessionBucket(comp('dead-end'), [attr('direct')]), 'research');
});

test('classify: untagged, no attrs → research', () => {
  assert.equal(classifySessionBucket(comp(null), []), 'research');
});

test('classify: inferred-only → likely', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('inferred')]), 'likely');
});

test('classify: direct + surviving → shipped', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('direct', 10, 10)]), 'shipped');
});

test('classify: direct + survival unknown → shipped', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('high', 10, null)]), 'shipped');
});

test('classify: direct but mostly reverted (<50% survive) → likely', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('direct', 10, 2)]), 'likely');
});

test('classify: debugging tag falls through to attribution → shipped', () => {
  assert.equal(classifySessionBucket(comp('debugging'), [attr('direct', 10, 10)]), 'shipped');
});

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

test('bucketWindow tallies sessions into shipped/likely/research', () => {
  const db = memDb();
  insertSession(db, session('s_ship', 1000, 2000));
  insertSession(db, session('s_research', 1100, 2100));
  insertSession(db, session('s_likely', 1200, 2200));
  insertCommit(db, commit('hship', 1500));
  insertCommit(db, commit('hlikely', 1700));
  insertAttribution(db, { session_id: 's_ship', commit_hash: 'hship', tier: 'direct', confidence: 1 });
  insertAttribution(db, { session_id: 's_likely', commit_hash: 'hlikely', tier: 'inferred', confidence: 0.5 });

  const t = bucketWindow(db, 0, 10000, undefined);
  assert.equal(t.total, 3);
  assert.equal(t.shipped, 1);
  assert.equal(t.likely, 1);
  assert.equal(t.research, 1);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: build fails with `error TS2305: Module '"./effectiveness"' has no exported member 'classifySessionBucket'.`

- [ ] **Step 3: Implement `effectiveness.ts`**

Create `src/compute/effectiveness.ts`:

```ts
import { DatabaseSync } from 'node:sqlite';
import { gatherComposites, type SessionComposite } from './composite_outcomes';
import type { SessionAttribution } from '../storage/db';

export type EffBucket = 'shipped' | 'likely' | 'research';

// A direct/high session whose committed lines mostly disappear is downgraded
// from "shipped" to "likely" — it committed, but the work didn't stick.
const SURVIVAL_SHIPPED_MIN = 0.5;

export function classifySessionBucket(
  composite: SessionComposite,
  attrs: SessionAttribution[],
): EffBucket {
  if (composite.tag === 'shipped') return 'shipped';
  if (composite.tag === 'exploring' || composite.tag === 'dead-end') return 'research';
  if (attrs.length === 0) return 'research';

  const strong = attrs.some((a) => a.tier === 'direct' || a.tier === 'high');
  if (!strong) return 'likely';

  const evaluated = attrs.filter(
    (a) => a.lines_surviving !== null && a.lines_added > 0,
  );
  if (evaluated.length > 0) {
    const added = evaluated.reduce((sum, a) => sum + a.lines_added, 0);
    const surviving = evaluated.reduce((sum, a) => sum + (a.lines_surviving as number), 0);
    if (added > 0 && surviving / added < SURVIVAL_SHIPPED_MIN) return 'likely';
  }
  return 'shipped';
}

export interface EffTally {
  shipped: number;
  likely: number;
  research: number;
  total: number;
}

export function bucketWindow(
  db: DatabaseSync,
  startMs: number,
  endMs: number,
  projectHash?: string,
): EffTally {
  const { composites, attrMap } = gatherComposites(db, startMs, endMs, projectHash);
  const t: EffTally = { shipped: 0, likely: 0, research: 0, total: composites.length };
  for (const c of composites) {
    const bucket = classifySessionBucket(c, attrMap.get(c.session_id) ?? []);
    t[bucket]++;
  }
  return t;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: all pass — `tests 34 … pass 34 … fail 0` (24 prior + 10 new). Slight count variance is fine as long as the new `classify:`/`bucketWindow` tests pass and nothing fails.

- [ ] **Step 5: Commit**

```bash
git add src/compute/effectiveness.ts src/compute/effectiveness.test.ts
git commit -m "feat: session effectiveness classifier + window tally" -m "classifySessionBucket reuses tags + attribution x survival (shipped/likely/research); bucketWindow tallies a window via gatherComposites. Pure classifier, no schema change." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Front-door block (cap headroom + effectiveness) in the subscription view

**Files:**
- Modify: `src/render/show.ts`
- Create: `src/render/show.test.ts`

- [ ] **Step 1: Write the failing test for `fillBar`**

Create `src/render/show.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillBar } from './show';

test('fillBar: null → em dash', () => {
  assert.equal(fillBar(null), '—');
});

test('fillBar: 0% → empty bar', () => {
  assert.equal(fillBar(0), '░░░░░░░░');
});

test('fillBar: 50% → half full', () => {
  assert.equal(fillBar(50), '▓▓▓▓░░░░');
});

test('fillBar: 100% → full', () => {
  assert.equal(fillBar(100), '▓▓▓▓▓▓▓▓');
});

test('fillBar: over 100% clamps to full', () => {
  assert.equal(fillBar(130), '▓▓▓▓▓▓▓▓');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test`
Expected: build fails with `error TS2305: Module '"./show"' has no exported member 'fillBar'.`

- [ ] **Step 3: Implement the front-door block in `show.ts`**

Apply all of the following edits to `src/render/show.ts`.

**(a) Add imports** after the existing import block (alongside the other `../compute/*` imports):

```ts
import { computeUsageCheck, type UsageCheckResult } from '../compute/usage';
import { bucketWindow, type EffTally } from '../compute/effectiveness';
```

**(b) Add the front-door render helpers** near the other render helpers (e.g., just above `renderHeaderBar`):

```ts
export function fillBar(pct: number | null): string {
  if (pct === null) return '—';
  const filled = Math.max(0, Math.min(8, Math.round((pct / 100) * 8)));
  return '▓'.repeat(filled) + '░'.repeat(8 - filled);
}

function capBar(w: { percent_used: number | null; warning_level: string }): string {
  const bar = fillBar(w.percent_used);
  if (w.percent_used === null) return dim(bar);
  const color =
    w.warning_level === 'over' || w.warning_level === 'strong'
      ? red
      : w.warning_level === 'soft'
        ? yellow
        : green;
  return color(`${bar} ${w.percent_used.toFixed(0)}%`);
}

function renderHeadroomLine(usage: UsageCheckResult): string {
  const clear =
    usage.five_hour.warning_level === 'ok' && usage.seven_day.warning_level === 'ok';
  const glyph = clear ? dim('✓') : yellow('⚠');
  return `  Cap   5h ${capBar(usage.five_hour)}   7d ${capBar(usage.seven_day)}   ${glyph}`;
}

function survival7dRate(m: MultiWindowSurvival): number | null {
  const w = m.windows.find((x) => x.window_days === 7);
  if (!w || w.summary.commits_evaluated === 0 || w.summary.rate === null) return null;
  return w.summary.rate;
}

function renderShipLine(tally: EffTally, survival7d: number | null): string[] {
  const buckets =
    green(`${tally.shipped} shipped`) +
    dim(' · ') +
    cyan(`${tally.likely} likely`) +
    dim(' · ') +
    dim(`${tally.research} research`);
  const sub =
    survival7d !== null
      ? `        ${tally.total} sessions · ${(survival7d * 100).toFixed(0)}% alive @7d`
      : `        ${tally.total} sessions`;
  return [`  Ship  ${buckets}`, dim(sub)];
}
```

**(c) Add two fields to the `RenderCtx` interface:**

```ts
  usage: UsageCheckResult;
  effTally: EffTally;
```

**(d) Compute them in `renderLast7Days`** — add these two lines just after `const nameMap = getProjectNameMap(db);`:

```ts
  const usage = computeUsageCheck(db, cfg.plan);
  const effTally = bucketWindow(db, currStart, now, projectHash);
```

and add `usage, effTally,` into the `ctx` object literal (the `const ctx: RenderCtx = { ... }`).

**(e) Render the block in `renderSubscriptionView`** — immediately after the `lines.push(...renderHeaderBar(...));` call, insert:

```ts
  lines.push(renderHeadroomLine(ctx.usage));
  lines.push(...renderShipLine(ctx.effTally, survival7dRate(ctx.survival)));
  lines.push('  ' + dim('─'.repeat(44)));
```

- [ ] **Step 4: Run tests + build**

Run: `npm test`
Expected: `fillBar` tests pass; all green (`tests 39 … pass 39 … fail 0`).

- [ ] **Step 5: Manually verify the rendered view**

Ensure the plan is a subscription plan so the subscription view renders (check `node dist/cli.js config`; if `plan` is `unknown`, set it: `node dist/cli.js config:set-plan max-100`). Then:

Run: `node dist/cli.js show`
Expected: output begins with the header bar, then a `Cap   5h … 7d …` line with bars, then a `Ship  N shipped · N likely · N research` line and a `N sessions · NN% alive @7d` sub-line, then a `────` divider, then the existing Tokens/Outcomes/Rate-limit/Cost-equivalent lines. (Note: the standalone "Code health" survival block still appears lower down — Task 3 removes that duplication.)

- [ ] **Step 6: Commit**

```bash
git add src/render/show.ts src/render/show.test.ts
git commit -m "feat: cap-headroom + effectiveness front-door block in subscription view" -m "(include Co-Authored-By trailer)"
```

---

## Task 3: Retire the `⚠ waste` label + drop the now-duplicated survival block

**Files:**
- Modify: `src/render/show.ts`

- [ ] **Step 1: Replace the `TopRowFormatted` interface and `fmtTopRow`**

In `src/render/show.ts`, replace the existing `TopRowFormatted` interface and `fmtTopRow` function with:

```ts
interface TopRowFormatted {
  lead: string;
  when: string;
  model: string;
  dur: string;
  label: string;
}

function fmtTopRow(r: TopRowFormatted): string {
  const lead = r.lead.padStart(5);
  const when = r.when.padEnd(9);
  const model = r.model.padEnd(14);
  const dur = r.dur.padStart(6);
  const isResearch = r.label === 'research';
  const label = isResearch ? dim(r.label.padEnd(10)) : r.label.padEnd(10);
  return `    ${lead}  ${when}  ${model}  ${dim(dur)}  ${label}`;
}
```

- [ ] **Step 2: Update the API-view call site**

In `renderApiView`, replace the `commits:` and `waste:` properties in the `fmtTopRow({ ... })` call with a single `label:`:

```ts
          label:
            s.attr_count === 0
              ? 'research'
              : s.attr_count === 1
                ? '1 commit'
                : `${s.attr_count} commits`,
```

(Remove the old `commits: …` and `waste: …` lines entirely.)

- [ ] **Step 3: Update the subscription-view call site**

In `renderSubscriptionView`, make the identical replacement in its `fmtTopRow({ ... })` call — remove the `commits: …` and `waste: …` lines and add:

```ts
          label:
            s.attr_count === 0
              ? 'research'
              : s.attr_count === 1
                ? '1 commit'
                : `${s.attr_count} commits`,
```

- [ ] **Step 4: Drop the duplicated survival block in the subscription view**

In `renderSubscriptionView`, delete the line:

```ts
  lines.push(...renderSurvivalBlock(survival));
```

(The 7-day survival figure now lives in the front-door Ship sub-line. Leave `renderSurvivalBlock` defined and still called in `renderApiView`.)

- [ ] **Step 5: Run tests + build**

Run: `npm test`
Expected: all green (`tests 39 … pass 39 … fail 0`). No new tests; this verifies the refactor compiles and nothing regressed.

- [ ] **Step 6: Manually verify**

Run: `node dist/cli.js show`
Expected: top-session rows now end in a neutral label (`research` dimmed, or `N commits`) with **no** `⚠ waste` anywhere; the standalone "Code health" line no longer appears (its 7d figure is in the Ship sub-line). Confirm with: `node dist/cli.js show | grep -i waste` → no output.

- [ ] **Step 7: Commit**

```bash
git add src/render/show.ts
git commit -m "refactor: retire the waste label for neutral session buckets; de-dup survival" -m "Top-session rows show research / N commits instead of an accusatory waste flag (no-commit != waste). The subscription view's 7d survival now lives in the front-door Ship line, so the standalone Code health block is dropped there." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- `effectiveness.ts` classifier + `bucketWindow` (spec §The design) → Task 1. ✓
- Bucket rule table (tagged-shipped, exploring/dead-end→research, no-attr→research, inferred→likely, direct+surviving→shipped, direct+reverted→likely, debugging falls through) → Task 1 tests. ✓
- Front-door block: cap headroom bars + Ship buckets + folded 7d survival + divider, Tokens/Cost demoted (spec §Front-door block) → Task 2. ✓
- Headroom from `computeUsageCheck`, bars colored by `warning_level`, `—` when `percent_used` null → Task 2 `capBar`/`fillBar`. ✓
- Neutral top-session label replacing `⚠ waste`, both views (spec §Top-session labels, scope call #1) → Task 3. ✓
- Drop separate survival block in subscription view only → Task 3 Step 4. ✓
- Recomputable / no schema change → no migration or snapshot writes in any task. ✓
- Acceptance criteria 1–5 → Task 2/3 manual-verify steps + `npm test`. ✓

**Placeholder scan:** none — every code step shows complete code; run steps show the exact command + expected output.

**Type consistency:** `EffTally` / `EffBucket` defined in Task 1, consumed in Task 2 (`renderShipLine`, `RenderCtx.effTally`). `UsageCheckResult` imported from `usage.ts` (verified shape: `five_hour`/`seven_day: WindowUsage{percent_used, warning_level}`). `MultiWindowSurvival` already imported in `show.ts` (used by `survival7dRate`). `SessionComposite` (from `composite_outcomes.ts`) and `SessionAttribution` (from `db.ts`) match `classifySessionBucket`'s parameters. `fmtTopRow`'s new `label` field is set at both call sites in Task 3; the old `commits`/`waste` fields are removed from the interface and both call sites in the same task, so the build stays consistent.

**Ordering safety:** Task 2 leaves `renderSurvivalBlock` called in both views (temporary 7d duplication in the subscription view, noted) and leaves `fmtTopRow`'s `waste` intact, so it compiles and runs. Task 3 then changes `fmtTopRow` + both call sites together and removes the subscription survival call — each task compiles independently.
