# Session-Intent Judge — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the local session-intent judge *engine* — opt-in gate, hardware-aware model selection, prompt+trajectory extraction, the model call, and a cached `session_verdicts` store — so `mileage judge` produces inspectable verdicts. No view changes (that's the Integration plan); no YPT changes (that's v2).

**Architecture:** A new `src/judge/*` module with sharply separated units: pure decision/parse logic (`chooseModel`, `parseVerdict`, `summarizeTrajectory`, `qualifiesForJudging`) that is fully unit-tested, wrapped by thin IO shells (Ollama/cloud HTTP, JSONL reads) that aren't. The judge **never installs anything** — it detects a user-run Ollama (or a configured cloud endpoint) and degrades to `off`. Content is read only inside `judge/input.ts`, only under the typed opt-in.

**Tech Stack:** TypeScript (strict), `node:sqlite`, global `fetch` (Node 18+), `node:test`. Build `tsc`; tests from compiled `dist`.

**Spec:** `docs/superpowers/specs/2026-05-25-session-intent-judge-design.md`

---

## Conventions for every task
- **Tests:** `npm test` = `tsc` then `node --test "dist/**/*.test.js"`. A missing-export "red" is a `TS2305` build failure — that's the signal.
- **Async:** the model call is async (`fetch`). `runJudge`/`runJudgePass` are `async`; the existing sync `runSync` is untouched — the judge pass runs *after* `runSync` inside the already-async command actions.
- **Staging:** clean tree on `main`. Never `git add -A`. Stage only the listed paths.
- **Commit trailer:** end every message with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` (shown in Task 1).
- **No-auto-commit:** executor surfaces each task's diff + test output for the user's OK before committing.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/storage/types.ts` | `MileageConfig.judge` shape | Modify |
| `src/config/plan.ts` | judge defaults + pure helpers + IO setters | Modify |
| `src/storage/schema.ts` | `session_verdicts` table | Modify |
| `src/storage/db.ts` | verdict helpers | Modify |
| `src/judge/types.ts` | shared judge types | Create |
| `src/judge/detect.ts` | `chooseModel` (pure) + `selectJudgeModel` (probe) | Create |
| `src/ingest/claude_code.ts` | export `findSessionSegmentEntries` | Modify |
| `src/judge/input.ts` | prompts + trajectory extraction | Create |
| `src/judge/prompt.ts` | rubric prompt builder | Create |
| `src/judge/runner.ts` | `parseVerdict` (pure) + `runJudge` + transports | Create |
| `src/judge/run_pass.ts` | `qualifiesForJudging` (pure) + `runJudgePass` | Create |
| `src/cli.ts` | `enable/judge:disable`, `mileage judge`, sync wiring | Modify |
| `src/judge/*.test.ts`, `src/config/plan.test.ts`, `src/storage/db.test.ts` | tests | Create/extend |

---

## Task 1: Judge config

**Files:** Modify `src/storage/types.ts`, `src/config/plan.ts`; extend `src/config/plan.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `src/config/plan.test.ts`:

```ts
import { withJudgeEnabled, withJudgeCloud, DEFAULT_CONFIG as DC2 } from './plan';

test('withJudgeEnabled flips the bit without mutating input', () => {
  const c0 = { ...DC2, judge: { ...DC2.judge } };
  const c1 = withJudgeEnabled(c0, true);
  assert.equal(c1.judge.enabled, true);
  assert.equal(c0.judge.enabled, false);
});

test('withJudgeCloud sets cloud config immutably', () => {
  const c1 = withJudgeCloud({ ...DC2 }, { enabled: true, endpoint: 'https://api.x/v1/chat/completions', model: 'm' });
  assert.equal(c1.judge.cloud.enabled, true);
  assert.equal(c1.judge.cloud.model, 'm');
});
```

- [ ] **Step 2: Run `npm test`** — fails: `TS2305 … has no exported member 'withJudgeEnabled'`.

- [ ] **Step 3: Implement.** In `src/storage/types.ts`, add to `MileageConfig` (after `excluded_repos`):

```ts
  judge: {
    enabled: boolean;
    model_override: string | null;
    cloud: { enabled: boolean; endpoint: string; model: string };
  };
```

In `src/config/plan.ts`: add to `DEFAULT_CONFIG`:

```ts
  judge: {
    enabled: false,
    model_override: null,
    cloud: { enabled: false, endpoint: '', model: '' },
  },
```

In `readConfig`'s returned object, add (so old config files load):

```ts
      judge: {
        ...DEFAULT_CONFIG.judge,
        ...(parsed.judge ?? {}),
        cloud: { ...DEFAULT_CONFIG.judge.cloud, ...(parsed.judge?.cloud ?? {}) },
      },
```

Add helpers:

```ts
export function withJudgeEnabled(cfg: MileageConfig, enabled: boolean): MileageConfig {
  return { ...cfg, judge: { ...cfg.judge, enabled } };
}

export function withJudgeCloud(
  cfg: MileageConfig,
  cloud: { enabled: boolean; endpoint: string; model: string },
): MileageConfig {
  return { ...cfg, judge: { ...cfg.judge, cloud } };
}

export function setJudgeEnabled(enabled: boolean): MileageConfig {
  const c = withJudgeEnabled(readConfig(), enabled);
  writeConfig(c);
  return c;
}

export function setJudgeCloud(cloud: { enabled: boolean; endpoint: string; model: string }): MileageConfig {
  const c = withJudgeCloud(readConfig(), cloud);
  writeConfig(c);
  return c;
}
```

- [ ] **Step 4: Run `npm test`** — all green.
- [ ] **Step 5: Commit**

```bash
git add src/storage/types.ts src/config/plan.ts src/config/plan.test.ts
git commit -m "feat: judge config (enabled, model_override, cloud)" -m "Adds MileageConfig.judge with pure with* helpers + IO setters, default off." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `session_verdicts` storage

**Files:** Modify `src/storage/schema.ts`, `src/storage/db.ts`; extend `src/storage/db.test.ts`.

- [ ] **Step 1: Write the failing test** — append to `src/storage/db.test.ts`:

```ts
import { insertVerdict, getVerdict, getVerdictsForSessions, purgeVerdicts } from './db';

test('verdict insert/get/getMany/purge round-trips', () => {
  const db = memDb(); // helper already defined in this file
  insertVerdict(db, { session_id: 's1', verdict: 'spinning', confidence: 0.82, model: 'qwen2.5:3b', rationale: 'looped on regex', judged_at: 100 });
  const v = getVerdict(db, 's1');
  assert.equal(v?.verdict, 'spinning');
  assert.equal(v?.confidence, 0.82);
  const m = getVerdictsForSessions(db, ['s1', 's2']);
  assert.equal(m.get('s1')?.model, 'qwen2.5:3b');
  assert.equal(m.has('s2'), false);
  purgeVerdicts(db);
  assert.equal(getVerdict(db, 's1'), null);
});
```

- [ ] **Step 2: Run `npm test`** — fails: `TS2305 … 'insertVerdict'`.

- [ ] **Step 3: Implement.** In `src/storage/schema.ts`, add to `SCHEMA_SQL`:

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

In `src/storage/db.ts`:

```ts
export interface SessionVerdictRow {
  session_id: string;
  verdict: string;
  confidence: number;
  model: string;
  rationale: string | null;
  judged_at: number;
}

export function insertVerdict(db: DatabaseSync, v: SessionVerdictRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO session_verdicts
     (session_id, verdict, confidence, model, rationale, judged_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(v.session_id, v.verdict, v.confidence, v.model, v.rationale, v.judged_at);
}

export function getVerdict(db: DatabaseSync, sessionId: string): SessionVerdictRow | null {
  const r = db
    .prepare(`SELECT * FROM session_verdicts WHERE session_id = ?`)
    .get(sessionId) as unknown as SessionVerdictRow | undefined;
  return r ?? null;
}

export function getVerdictsForSessions(
  db: DatabaseSync,
  ids: string[],
): Map<string, SessionVerdictRow> {
  const out = new Map<string, SessionVerdictRow>();
  if (ids.length === 0) return out;
  const qs = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM session_verdicts WHERE session_id IN (${qs})`)
    .all(...ids) as unknown as SessionVerdictRow[];
  for (const r of rows) out.set(r.session_id, r);
  return out;
}

export function getJudgedSessionIds(db: DatabaseSync): Set<string> {
  const rows = db.prepare(`SELECT session_id FROM session_verdicts`).all() as unknown as { session_id: string }[];
  return new Set(rows.map((r) => r.session_id));
}

export function purgeVerdicts(db: DatabaseSync): void {
  db.exec(`DELETE FROM session_verdicts`);
}
```

- [ ] **Step 4: Run `npm test`** — green.
- [ ] **Step 5: Commit**

```bash
git add src/storage/schema.ts src/storage/db.ts src/storage/db.test.ts
git commit -m "feat: session_verdicts cache table + helpers" -m "(include Co-Authored-By trailer)"
```

---

## Task 3: judge types + model detection

**Files:** Create `src/judge/types.ts`, `src/judge/detect.ts`, `src/judge/detect.test.ts`.

- [ ] **Step 1: Write the failing test** — create `src/judge/detect.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel } from './detect';

const base = { freeRamGb: 16, ollamaModels: ['qwen2.5:7b', 'qwen2.5:3b'], override: null as string | null, cloud: { enabled: false, model: '' } };

test('override off → off', () => {
  assert.equal(chooseModel({ ...base, override: 'off' }).kind, 'off');
});
test('override cloud with config → cloud', () => {
  assert.equal(chooseModel({ ...base, override: 'cloud', cloud: { enabled: true, model: 'gpt' } }).kind, 'cloud');
});
test('override cloud without config → off', () => {
  assert.equal(chooseModel({ ...base, override: 'cloud' }).kind, 'off');
});
test('explicit ollama model override', () => {
  const m = chooseModel({ ...base, override: 'llama3.2:3b' });
  assert.equal(m.kind, 'ollama');
  assert.equal(m.model, 'llama3.2:3b');
});
test('auto: cloud opt-in wins when configured', () => {
  assert.equal(chooseModel({ ...base, cloud: { enabled: true, model: 'gpt' } }).kind, 'cloud');
});
test('auto: no ollama models → off', () => {
  assert.equal(chooseModel({ ...base, ollamaModels: [] }).kind, 'off');
});
test('auto: 16GB + 7b available → 7b', () => {
  assert.equal(chooseModel({ ...base }).model, 'qwen2.5:7b');
});
test('auto: 8GB → small model', () => {
  assert.equal(chooseModel({ ...base, freeRamGb: 8 }).model, 'qwen2.5:3b');
});
test('auto: <7GB → off', () => {
  assert.equal(chooseModel({ ...base, freeRamGb: 4 }).kind, 'off');
});
```

- [ ] **Step 2: Run `npm test`** — fails: `TS2307 … './detect'`.

- [ ] **Step 3: Implement.** Create `src/judge/types.ts`:

```ts
export type Verdict = 'productive' | 'spinning' | 'uncertain';

export interface JudgeResult {
  verdict: Verdict;
  confidence: number;
  rationale: string;
}

export type JudgeModelKind = 'off' | 'ollama' | 'cloud';

export interface JudgeModel {
  kind: JudgeModelKind;
  model: string;
  reason: string;
}

export interface TrajectorySummary {
  tool_counts: Record<string, number>;
  error_count: number;
  files_touched: number;
  max_edits_to_one_file: number;
  bash_count: number;
}

export interface JudgeInput {
  prompts: string[];
  trajectory: TrajectorySummary;
}
```

Create `src/judge/detect.ts`:

```ts
import * as os from 'node:os';
import type { JudgeModel } from './types';
import type { MileageConfig } from '../storage/types';

export interface DetectInputs {
  freeRamGb: number;
  ollamaModels: string[];
  override: string | null;
  cloud: { enabled: boolean; model: string };
}

export function chooseModel(i: DetectInputs): JudgeModel {
  if (i.override === 'off') return { kind: 'off', model: '', reason: 'disabled by override' };
  if (i.override === 'cloud') {
    return i.cloud.enabled
      ? { kind: 'cloud', model: i.cloud.model, reason: 'override: cloud' }
      : { kind: 'off', model: '', reason: 'cloud override but cloud not configured' };
  }
  if (i.override) return { kind: 'ollama', model: i.override, reason: `override: ${i.override}` };

  if (i.cloud.enabled) return { kind: 'cloud', model: i.cloud.model, reason: 'cloud opt-in configured' };
  if (i.ollamaModels.length === 0) {
    return { kind: 'off', model: '', reason: 'Ollama not reachable or no models pulled' };
  }
  const big = i.ollamaModels.find((m) => /(7|8|9|13|14)b/i.test(m));
  const small = i.ollamaModels.find((m) => /(1|2|3|4)b|mini|small/i.test(m));
  if (i.freeRamGb >= 14 && big) return { kind: 'ollama', model: big, reason: '>=14GB RAM, 7-8B' };
  if (i.freeRamGb >= 7) return { kind: 'ollama', model: small ?? i.ollamaModels[0], reason: '>=7GB RAM, small model' };
  return { kind: 'off', model: '', reason: 'insufficient RAM (<7GB free)' };
}

export async function selectJudgeModel(cfg: MileageConfig): Promise<JudgeModel> {
  const freeRamGb = os.freemem() / 1e9;
  let ollamaModels: string[] = [];
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      ollamaModels = (data.models ?? []).map((m) => m.name);
    }
  } catch {
    /* Ollama not running — leave empty */
  }
  return chooseModel({
    freeRamGb,
    ollamaModels,
    override: cfg.judge.model_override,
    cloud: { enabled: cfg.judge.cloud.enabled, model: cfg.judge.cloud.model },
  });
}
```

- [ ] **Step 4: Run `npm test`** — green.
- [ ] **Step 5: Commit**

```bash
git add src/judge/types.ts src/judge/detect.ts src/judge/detect.test.ts
git commit -m "feat: judge types + hardware-aware model selection" -m "(include Co-Authored-By trailer)"
```

---

## Task 4: session content locator + judge input

**Files:** Modify `src/ingest/claude_code.ts` (export a locator); create `src/judge/input.ts`, `src/judge/input.test.ts`.

- [ ] **Step 1: Write the failing test** — create `src/judge/input.test.ts` (tests the pure extractors; asserts no code/assistant prose leaks):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrompts, summarizeTrajectory } from './input';

const entries = [
  { type: 'user', message: { role: 'user', content: 'fix the auth bug' } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'SECRET ASSISTANT PROSE' },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } },
    { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
  ] } },
];

test('extractPrompts returns only user free-text, never assistant prose', () => {
  const p = extractPrompts(entries as never);
  assert.deepEqual(p, ['fix the auth bug']);
  assert.equal(p.join(' ').includes('SECRET ASSISTANT PROSE'), false);
});

test('summarizeTrajectory counts tools, errors, files, and same-file edit loops', () => {
  const t = summarizeTrajectory(entries as never);
  assert.equal(t.tool_counts.Edit, 2);
  assert.equal(t.tool_counts.Bash, 1);
  assert.equal(t.bash_count, 1);
  assert.equal(t.error_count, 1);
  assert.equal(t.files_touched, 1);
  assert.equal(t.max_edits_to_one_file, 2);
});
```

- [ ] **Step 2: Run `npm test`** — fails: `TS2307 … './input'`.

- [ ] **Step 3a: Export a locator from `src/ingest/claude_code.ts`.** Add (reuses `SESSION_GAP_MS`, `JsonlEntry`, `claudeProjectsDir`, and the existing 10-min-gap segmentation shape). Export the `JsonlEntry` interface (add `export` to its declaration) and add:

```ts
export function findSessionSegmentEntries(sessionId: string, segIdx: number): JsonlEntry[] | null {
  const root = claudeProjectsDir();
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const projectPath = path.join(root, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      let lines: string[];
      try {
        lines = fs.readFileSync(path.join(projectPath, f), 'utf8').split(/\r?\n/);
      } catch {
        continue;
      }
      const entries: JsonlEntry[] = [];
      for (const line of lines) {
        if (!line) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          /* skip */
        }
      }
      const group = entries
        .filter((e) => e.sessionId === sessionId && e.timestamp)
        .map((e) => ({ e, t: Date.parse(e.timestamp as string) }))
        .filter((x) => Number.isFinite(x.t))
        .sort((a, b) => a.t - b.t);
      if (group.length === 0) continue;
      const segments: JsonlEntry[][] = [];
      let current: JsonlEntry[] | null = null;
      let lastT = 0;
      for (const { e, t } of group) {
        if (!current || t - lastT > SESSION_GAP_MS) {
          if (current) segments.push(current);
          current = [e];
        } else {
          current.push(e);
        }
        lastT = t;
      }
      if (current) segments.push(current);
      if (segIdx < segments.length) return segments[segIdx];
    }
  }
  return null;
}
```

- [ ] **Step 3b: Create `src/judge/input.ts`:**

```ts
import { findSessionSegmentEntries } from '../ingest/claude_code';
import type { JsonlEntry } from '../ingest/claude_code';
import type { JudgeInput, TrajectorySummary } from './types';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

// User free-text only. Tool_result blocks (which ride on role:user messages) are skipped.
export function extractPrompts(entries: JsonlEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.message?.role !== 'user') continue;
    const content = e.message?.content;
    if (Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result')) continue;
    const t = textOf(content);
    if (t) out.push(t);
  }
  return out;
}

export function summarizeTrajectory(entries: JsonlEntry[]): TrajectorySummary {
  const tool_counts: Record<string, number> = {};
  const fileEdits: Record<string, number> = {};
  let error_count = 0;
  for (const e of entries) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as any[]) {
      if (c?.type === 'tool_use' && typeof c?.name === 'string') {
        tool_counts[c.name] = (tool_counts[c.name] ?? 0) + 1;
        const fp = c?.input?.file_path;
        if ((c.name === 'Edit' || c.name === 'Write') && typeof fp === 'string') {
          fileEdits[fp] = (fileEdits[fp] ?? 0) + 1;
        }
      } else if (c?.type === 'tool_result' && c?.is_error === true) {
        error_count++;
      }
    }
  }
  const editValues = Object.values(fileEdits);
  return {
    tool_counts,
    error_count,
    files_touched: editValues.length,
    max_edits_to_one_file: editValues.length ? Math.max(...editValues) : 0,
    bash_count: tool_counts.Bash ?? 0,
  };
}

export function buildJudgeInput(sessionId: string, segIdx: number): JudgeInput | null {
  const entries = findSessionSegmentEntries(sessionId, segIdx);
  if (!entries) return null;
  return { prompts: extractPrompts(entries), trajectory: summarizeTrajectory(entries) };
}
```

- [ ] **Step 4: Run `npm test`** — green.
- [ ] **Step 5: Commit**

```bash
git add src/ingest/claude_code.ts src/judge/input.ts src/judge/input.test.ts
git commit -m "feat: session-segment locator + judge input (prompts + trajectory)" -m "Content-reading is confined to judge/input.ts; extracts user prompts + a tool-action trajectory summary, never assistant prose or diffs." -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: rubric prompt + the model call

**Files:** Create `src/judge/prompt.ts`, `src/judge/runner.ts`, `src/judge/runner.test.ts`.

- [ ] **Step 1: Write the failing test** — create `src/judge/runner.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, runJudge } from './runner';
import type { JudgeInput } from './types';

test('parseVerdict reads well-formed JSON', () => {
  const r = parseVerdict('{"verdict":"spinning","confidence":0.8,"rationale":"looped"}');
  assert.equal(r.verdict, 'spinning');
  assert.equal(r.confidence, 0.8);
});
test('parseVerdict tolerates surrounding text', () => {
  const r = parseVerdict('Here: {"verdict":"productive","confidence":0.6,"rationale":"explored"} done');
  assert.equal(r.verdict, 'productive');
});
test('parseVerdict on garbage → uncertain', () => {
  assert.equal(parseVerdict('not json').verdict, 'uncertain');
  assert.equal(parseVerdict('').verdict, 'uncertain');
});
test('parseVerdict clamps confidence and rejects bad verdict', () => {
  assert.equal(parseVerdict('{"verdict":"banana","confidence":5}').verdict, 'uncertain');
});

test('runJudge uses the injected transport and parses its output', async () => {
  const input: JudgeInput = { prompts: ['x'], trajectory: { tool_counts: {}, error_count: 0, files_touched: 0, max_edits_to_one_file: 0, bash_count: 0 } };
  const transport = async () => '{"verdict":"productive","confidence":0.9,"rationale":"ok"}';
  const r = await runJudge({ kind: 'ollama', model: 'm', reason: '' }, input, transport);
  assert.equal(r.verdict, 'productive');
});
test('runJudge maps a throwing transport to uncertain', async () => {
  const input: JudgeInput = { prompts: ['x'], trajectory: { tool_counts: {}, error_count: 0, files_touched: 0, max_edits_to_one_file: 0, bash_count: 0 } };
  const transport = async () => { throw new Error('down'); };
  const r = await runJudge({ kind: 'ollama', model: 'm', reason: '' }, input, transport);
  assert.equal(r.verdict, 'uncertain');
});
```

- [ ] **Step 2: Run `npm test`** — fails: `TS2307 … './runner'`.

- [ ] **Step 3a: Create `src/judge/prompt.ts`:**

```ts
import type { JudgeInput } from './types';

export function buildJudgePrompt(input: JudgeInput): string {
  const t = input.trajectory;
  const tools = Object.entries(t.tool_counts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
  return [
    'You judge whether an AI coding session that produced NO git commit was still worthwhile.',
    'productive = explored options, researched, localized a bug, made a real decision, or correctly abandoned a bad approach after learning.',
    'spinning = repeated near-identical failed attempts, no convergence, thrashing the same file, confidently-wrong loops.',
    'If genuinely unclear, answer uncertain.',
    '',
    `User intent (prompts):\n${input.prompts.map((p) => `- ${p}`).join('\n') || '- (none captured)'}`,
    '',
    `Behavioral trajectory: tools={${tools}}; errors=${t.error_count}; files_edited=${t.files_touched}; max_edits_to_one_file=${t.max_edits_to_one_file}; bash=${t.bash_count}.`,
    '',
    'Respond with ONLY this JSON, no prose: {"verdict":"productive"|"spinning"|"uncertain","confidence":0.0-1.0,"rationale":"<=12 words"}',
  ].join('\n');
}
```

- [ ] **Step 3b: Create `src/judge/runner.ts`:**

```ts
import type { JudgeInput, JudgeModel, JudgeResult, Verdict } from './types';
import { buildJudgePrompt } from './prompt';

const UNCERTAIN: JudgeResult = { verdict: 'uncertain', confidence: 0, rationale: 'judge unavailable' };
const VERDICTS: Verdict[] = ['productive', 'spinning', 'uncertain'];

export function parseVerdict(text: string): JudgeResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return UNCERTAIN;
  let obj: any;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return UNCERTAIN;
  }
  if (!VERDICTS.includes(obj.verdict)) return UNCERTAIN;
  const conf = Number(obj.confidence);
  return {
    verdict: obj.verdict,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 120) : '',
  };
}

export type JudgeTransport = (model: string, prompt: string) => Promise<string>;

export async function ollamaTransport(model: string, prompt: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json()) as { response?: string };
  return data.response ?? '';
}

export function cloudTransport(endpoint: string, apiKey: string): JudgeTransport {
  return async (model, prompt) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  };
}

export async function runJudge(
  model: JudgeModel,
  input: JudgeInput,
  transport: JudgeTransport,
): Promise<JudgeResult> {
  if (model.kind === 'off') return UNCERTAIN;
  try {
    const text = await transport(model.model, buildJudgePrompt(input));
    return parseVerdict(text);
  } catch {
    return UNCERTAIN;
  }
}
```

- [ ] **Step 4: Run `npm test`** — green.
- [ ] **Step 5: Commit**

```bash
git add src/judge/prompt.ts src/judge/runner.ts src/judge/runner.test.ts
git commit -m "feat: judge rubric prompt + model call (Ollama/cloud transports, robust parse)" -m "(include Co-Authored-By trailer)"
```

---

## Task 6: judging pass orchestration

**Files:** Create `src/judge/run_pass.ts`, `src/judge/run_pass.test.ts`. (No change to Part 2's outcomes types — see the tokens-only note below.)

- [ ] **Step 1: Write the failing test** — create `src/judge/run_pass.test.ts` (tests the pure predicate):

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { qualifiesForJudging } from './run_pass';

test('research + high tokens qualifies', () => {
  assert.equal(qualifiesForJudging('research', 300_000), true);
});
test('research but low tokens does not qualify', () => {
  assert.equal(qualifiesForJudging('research', 50_000), false);
});
test('non-research bucket never qualifies, even at high tokens', () => {
  assert.equal(qualifiesForJudging('shipped', 9_000_000), false);
});
```

- [ ] **Step 2: Run `npm test`** — fails: `TS2307 … './run_pass'`.

- [ ] **Step 3: Create `src/judge/run_pass.ts`:**

```ts
import { DatabaseSync } from 'node:sqlite';
import { gatherComposites } from '../compute/composite_outcomes';
import { classifySessionBucket, type EffBucket } from '../compute/effectiveness';
import { getJudgedSessionIds, insertVerdict } from '../storage/db';
import type { MileageConfig } from '../storage/types';
import { selectJudgeModel } from './detect';
import { buildJudgeInput } from './input';
import { runJudge, ollamaTransport, cloudTransport, type JudgeTransport } from './runner';

const JUDGE_EFFORT_TOKENS = 250_000;
const JUDGE_MAX_PER_PASS = 8;

// v1 uses a tokens-only effort proxy (research sessions are reliably high-token;
// see the dogfood data). Duration is a noted v1.1 refinement — it would require
// threading session_end_ms through SessionOutcomeRow/SessionComposite, which we
// avoid here to keep Part 2's tested types untouched.
export function qualifiesForJudging(bucket: EffBucket, tokens: number): boolean {
  return bucket === 'research' && tokens >= JUDGE_EFFORT_TOKENS;
}

export interface JudgePassResult {
  model: string;
  judged: number;
  skipped_unavailable: boolean;
}

export async function runJudgePass(
  db: DatabaseSync,
  cfg: MileageConfig,
  startMs: number,
  endMs: number,
  refresh = false,
): Promise<JudgePassResult> {
  const model = await selectJudgeModel(cfg);
  if (model.kind === 'off') return { model: model.reason, judged: 0, skipped_unavailable: true };

  let transport: JudgeTransport;
  if (model.kind === 'cloud') {
    const key = process.env.MILEAGE_JUDGE_API_KEY ?? '';
    transport = cloudTransport(cfg.judge.cloud.endpoint, key);
  } else {
    transport = ollamaTransport;
  }

  const { composites, attrMap } = gatherComposites(db, startMs, endMs);
  const alreadyJudged = refresh ? new Set<string>() : getJudgedSessionIds(db);

  const candidates = composites.filter((c) => {
    const bucket = classifySessionBucket(c, attrMap.get(c.session_id) ?? []);
    return qualifiesForJudging(bucket, c.tokens) && !alreadyJudged.has(c.session_id);
  });

  let judged = 0;
  for (const c of candidates.slice(0, JUDGE_MAX_PER_PASS)) {
    const [origId, idxStr] = c.session_id.split(':');
    const input = buildJudgeInput(origId, Number(idxStr));
    if (!input) continue;
    const result = await runJudge(model, input, transport);
    insertVerdict(db, {
      session_id: c.session_id,
      verdict: result.verdict,
      confidence: result.confidence,
      model: model.model || model.kind,
      rationale: result.rationale,
      judged_at: Date.now(),
    });
    judged++;
  }
  return { model: model.model || model.kind, judged, skipped_unavailable: false };
}
```

- [ ] **Step 4: Run `npm test`** — green (the predicate tests; the orchestration is verified manually in Task 7).
- [ ] **Step 5: Commit**

```bash
git add src/judge/run_pass.ts src/judge/run_pass.test.ts
git commit -m "feat: judging pass — select high-effort research sessions, judge, cache verdicts" -m "(include Co-Authored-By trailer)"
```

---

## Task 7: CLI — opt-in gate, `mileage judge`, sync wiring

**Files:** Modify `src/cli.ts`. (No new unit tests — CLI wiring; verified by build + manual run.)

- [ ] **Step 1: Add imports** to `src/cli.ts`:

```ts
import { setJudgeEnabled, setJudgeCloud } from './config/plan';
import { runJudgePass } from './judge/run_pass';
import { selectJudgeModel } from './judge/detect';
import { purgeVerdicts } from './storage/db';
import * as readline from 'node:readline';
```

- [ ] **Step 2: Add the opt-in gate + `mileage judge`.** Add these commands near `config:set-plan`:

```ts
program
  .command('judge:enable')
  .description('Turn on the local session-intent judge (opt-in; reads prompts + trajectory)')
  .action(async () => {
    const db = openDb();
    try {
      const cfg = readConfig();
      const model = await selectJudgeModel({ ...cfg, judge: { ...cfg.judge, enabled: true } });
      console.log(
        '\n' + bold('Enabling the session-intent judge') + '\n' +
        '  Reads: your PROMPTS + tool-action metadata (counts, file paths, errors) for\n' +
        '         high-effort no-commit "research" sessions only. NOT code, diffs, or\n' +
        '         assistant prose.\n' +
        `  Runs:  ${model.kind === 'off' ? red('no model available — ' + model.reason) : model.kind + ' (' + model.model + ')'}\n` +
        '  Stores: verdict + confidence + a short reason, on THIS machine only.\n' +
        '  Leaves machine: nothing (local). Cloud opt-in (if you set it) sends prompts+trajectory only.\n',
      );
      if (model.kind === 'off') {
        console.log(dim('  To use a local model: install Ollama (https://ollama.com), then `ollama pull qwen2.5:3b`.'));
        console.log(dim('  Or configure cloud: `mileage judge:set-cloud <endpoint> <model>` and set MILEAGE_JUDGE_API_KEY.\n'));
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>((res) => rl.question('Type `yes I read this` to enable: ', res));
      rl.close();
      if (answer.trim() !== 'yes I read this') {
        console.log('Not enabled.');
        return;
      }
      setJudgeEnabled(true);
      console.log(green('Judge enabled.') + ' Run `mileage judge` or it will run during sync.');
    } finally {
      db.close();
    }
  });

program
  .command('judge:disable')
  .description('Turn off the judge and purge all cached verdicts')
  .action(() => {
    const db = openDb();
    try {
      setJudgeEnabled(false);
      purgeVerdicts(db);
      console.log('Judge disabled; cached verdicts purged.');
    } finally {
      db.close();
    }
  });

program
  .command('judge:set-cloud <endpoint> <model>')
  .description('Configure (and enable) the cloud judge opt-in; API key from MILEAGE_JUDGE_API_KEY')
  .action((endpoint: string, model: string) => {
    setJudgeCloud({ enabled: true, endpoint, model });
    console.log(`Cloud judge set: ${model} @ ${endpoint}. Set MILEAGE_JUDGE_API_KEY in your env.`);
  });

program
  .command('judge')
  .description('Run a judging pass over high-effort no-commit sessions (last 30 days)')
  .option('--refresh', 're-judge sessions even if already cached', false)
  .action(async (opts) => {
    const db = openDb();
    try {
      const cfg = readConfig();
      if (!cfg.judge.enabled) {
        console.log('Judge is off. Enable it with `mileage judge:enable`.');
        return;
      }
      const now = Date.now();
      const r = await runJudgePass(db, cfg, now - 30 * 86400_000, now, !!opts.refresh);
      if (r.skipped_unavailable) {
        console.log(yellow('No model available: ') + r.model);
      } else {
        console.log(`Judged ${r.judged} session(s) with ${r.model}.`);
      }
    } finally {
      db.close();
    }
  });
```

- [ ] **Step 3: Wire a capped pass into sync.** In the async `sync` command action (and the bare command's auto-sync path in `runBareCommand`), after `runSync(...)` returns, add:

```ts
      const cfgJudge = readConfig();
      if (cfgJudge.judge.enabled) {
        const now = Date.now();
        await runJudgePass(db, cfgJudge, now - 30 * 86400_000, now, false);
      }
```

(Place it inside the existing `try` blocks, before `db.close()`. The `sync` action must be `async` — it already returns nothing; change its `.action((opts) => {` to `.action(async (opts) => {`.)

- [ ] **Step 4: Build + manual verify.**

Run: `npm run build`
Expected: no TS errors.

Then exercise it (you'll need Ollama + a model, or the cloud opt-in):
```bash
node dist/cli.js judge:enable          # read disclosure, type the phrase
node dist/cli.js judge                 # runs a pass
node dist/cli.js judge:disable         # confirm verdicts purge
```
Inspect cached verdicts directly:
```bash
node -e "const{DatabaseSync}=require('node:sqlite');const os=require('os'),p=require('path');const db=new DatabaseSync(p.join(os.homedir(),'.mileage','metrics.db'));console.table(db.prepare('SELECT session_id,verdict,confidence,rationale FROM session_verdicts').all())"
```

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: judge CLI — enable/disable gate, judge:set-cloud, mileage judge, sync wiring" -m "(include Co-Authored-By trailer)"
```

---

## Self-Review

**Spec coverage:**
- Opt-in gate w/ disclosure + typed confirm + purge-on-disable (spec §Opt-in gate) → Task 7. ✓
- Model selection tiers + override + cloud + key-from-env (spec §Model selection) → Task 3 + Task 7 `judge:set-cloud` + `MILEAGE_JUDGE_API_KEY`. ✓
- Prompts + trajectory, content confined to one module (spec §Judge input) → Task 4 (`judge/input.ts` is the only content reader). ✓
- Rubric + JSON verdict + robust parse + uncertain fallback (spec §Prompt/verdict) → Task 5. ✓
- Confidence captured (gate at 0.7 is applied in the *Integration* plan's view, per phasing) → stored in Task 2/6; threshold consumption deferred to Integration. ✓
- Which sessions / effort threshold / cap / cache / refresh (spec §Which sessions & when) → Task 6 (`qualifiesForJudging`, `JUDGE_MAX_PER_PASS`, `getJudgedSessionIds`, `--refresh`). ✓
- `session_verdicts` cache, purgeable (spec §Storage) → Task 2. ✓
- Never installs; detect + guide (clarified) → Task 3 (detect only) + Task 7 (prints setup guidance). ✓
- No YPT change; no view change → none of these tasks touch `compute/ypt.ts` or render. ✓

**Deviations (intentional):** (1) v1 uses a **tokens-only** effort threshold (`≥ 250K`), not the spec's "duration OR tokens" — duration would mean threading `session_end_ms` through Part 2's `SessionOutcomeRow`/`SessionComposite` and their test fixtures, so it's deferred to v1.1; research sessions are reliably high-token in the dogfood data, so the proxy is sound. (2) The 0.7 confidence gate lives in the Integration plan (a view concern), not Foundation — Foundation stores raw confidence. (3) Commands use the colon style (`judge:enable` / `judge:disable` / `judge:set-cloud`) to match `config:set-plan` and commander's single-token command names, rather than the spec's prose `enable judge`.

**Placeholder scan:** none — every code step is complete; manual-verify steps give exact commands.

**Type consistency:** `JudgeModel`/`JudgeResult`/`JudgeInput`/`TrajectorySummary`/`Verdict` defined in Task 3 (`judge/types.ts`), consumed by Tasks 4–6. `SessionVerdictRow` (Task 2) is what `insertVerdict` writes in Task 6. `EffBucket` + `classifySessionBucket` + `gatherComposites` (Part 2) are reused unchanged in Task 6. `findSessionSegmentEntries`/`JsonlEntry` exported in Task 4, imported by `judge/input.ts`. `qualifiesForJudging(bucket, tokens, durationMs)` signature matches its call site and tests.

**Ordering safety:** each task compiles independently — Task 4's locator is additive to `claude_code.ts`; Task 6's `session_end_ms` addition is additive; the CLI (Task 7) only references symbols created in Tasks 1–6.
