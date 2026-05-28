import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerdict, runJudge } from './runner';
import type { JudgeInput } from './types';

test('parseVerdict reads well-formed tier JSON', () => {
  const r = parseVerdict('{"tier":"stalled","confidence":0.8,"rationale":"looped"}');
  assert.equal(r.tier, 'stalled');
  assert.equal(r.confidence, 0.8);
});
test('parseVerdict tolerates surrounding text', () => {
  const r = parseVerdict('Here: {"tier":"high","confidence":0.6,"rationale":"explored"} done');
  assert.equal(r.tier, 'high');
});
test('parseVerdict parses each valid tier', () => {
  for (const tier of ['high', 'solid', 'thin', 'stalled', 'unrated'] as const) {
    const r = parseVerdict(`{"tier":"${tier}","confidence":0.5,"rationale":"x"}`);
    assert.equal(r.tier, tier);
  }
});
test('parseVerdict on garbage → unrated', () => {
  assert.equal(parseVerdict('not json').tier, 'unrated');
  assert.equal(parseVerdict('').tier, 'unrated');
});
test('parseVerdict clamps confidence and rejects bad tier', () => {
  assert.equal(parseVerdict('{"tier":"banana","confidence":5}').tier, 'unrated');
});
test('parseVerdict rejects old verdict field', () => {
  assert.equal(parseVerdict('{"verdict":"productive","confidence":0.9}').tier, 'unrated');
});

const input: JudgeInput = { prompts: ['x'], trajectory: { tool_counts: {}, error_count: 0, files_touched: 0, max_edits_to_one_file: 0, bash_count: 0 }, action_arc: [] };

test('runJudge uses the injected transport and parses its output', async () => {
  const transport = async () => '{"tier":"solid","confidence":0.9,"rationale":"ok"}';
  const r = await runJudge({ kind: 'ollama', model: 'm', reason: '' }, input, transport);
  assert.equal(r.tier, 'solid');
});
test('runJudge maps a throwing transport to unrated', async () => {
  const transport = async () => { throw new Error('down'); };
  const r = await runJudge({ kind: 'ollama', model: 'm', reason: '' }, input, transport);
  assert.equal(r.tier, 'unrated');
});
test('runJudge on an off model → unrated without calling transport', async () => {
  let called = false;
  const transport = async () => { called = true; return ''; };
  const r = await runJudge({ kind: 'off', model: '', reason: '' }, input, transport);
  assert.equal(r.tier, 'unrated');
  assert.equal(called, false);
});
