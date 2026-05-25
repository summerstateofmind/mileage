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
