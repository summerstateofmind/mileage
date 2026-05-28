import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPrompts, summarizeTrajectory, extractActionArc } from './input';

const entries = [
  { type: 'user', message: { role: 'user', content: 'fix the auth bug' } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'text', text: 'SECRET ASSISTANT PROSE' },
    { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.ts' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'boom' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'a.ts' } },
    { type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'npm test' } },
  ] } },
  { type: 'user', message: { role: 'user', content: [
    { type: 'tool_result', tool_use_id: 'tu2', is_error: false, content: 'ok' },
    { type: 'tool_result', tool_use_id: 'tu3', is_error: true, content: 'FAIL' },
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
  assert.equal(t.error_count, 2);
  assert.equal(t.files_touched, 1);
  assert.equal(t.max_edits_to_one_file, 2);
});

test('extractActionArc builds ordered tool steps with outcomes', () => {
  const arc = extractActionArc(entries as never);
  assert.equal(arc.length, 3);
  assert.deepEqual(arc[0], { tool: 'Edit', file: 'a.ts', outcome: 'fail' });
  assert.deepEqual(arc[1], { tool: 'Edit', file: 'a.ts', outcome: 'ok' });
  assert.deepEqual(arc[2], { tool: 'Bash test', outcome: 'fail' });
});

test('extractActionArc extracts safelisted Bash verb, not raw command', () => {
  const bashEntries = [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm run build && git push' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'b1', is_error: false, content: 'done' },
    ] } },
  ];
  const arc = extractActionArc(bashEntries as never);
  assert.equal(arc.length, 1);
  assert.equal(arc[0].tool, 'Bash run');
  assert.equal(arc[0].file, undefined);
});

test('extractActionArc respects cap', () => {
  const many: any[] = [];
  for (let i = 0; i < 50; i++) {
    many.push({ type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: `r${i}`, name: 'Read', input: { file_path: `f${i}.ts` } },
    ] } });
    many.push({ type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: `r${i}`, is_error: false, content: '' },
    ] } });
  }
  const arc = extractActionArc(many as never, 10);
  assert.equal(arc.length, 10);
  assert.equal(arc[0].file, 'f40.ts');
});

test('extractActionArc labels Bash without matching verb as plain Bash', () => {
  const bashEntries = [
    { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'b2', name: 'Bash', input: { command: 'ls -la /tmp' } },
    ] } },
    { type: 'user', message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'b2', is_error: false, content: '' },
    ] } },
  ];
  const arc = extractActionArc(bashEntries as never);
  assert.equal(arc[0].tool, 'Bash');
});
