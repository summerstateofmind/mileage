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

const input: JudgeInput = { prompts: ['x'], trajectory: { tool_counts: {}, error_count: 0, files_touched: 0, max_edits_to_one_file: 0, bash_count: 0 } };

test('runJudge uses the injected transport and parses its output', async () => {
  const transport = async () => '{"verdict":"productive","confidence":0.9,"rationale":"ok"}';
  const r = await runJudge({ kind: 'ollama', model: 'm', reason: '' }, input, transport);
  assert.equal(r.verdict, 'productive');
});
test('runJudge maps a throwing transport to uncertain', async () => {
  const transport = async () => { throw new Error('down'); };
  const r = await runJudge({ kind: 'ollama', model: 'm', reason: '' }, input, transport);
  assert.equal(r.verdict, 'uncertain');
});
test('runJudge on an off model → uncertain without calling transport', async () => {
  let called = false;
  const transport = async () => { called = true; return ''; };
  const r = await runJudge({ kind: 'off', model: '', reason: '' }, input, transport);
  assert.equal(r.verdict, 'uncertain');
  assert.equal(called, false);
});
