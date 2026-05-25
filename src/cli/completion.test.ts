import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionScript } from './completion';

const cmds = ['show', 'sync', 'judge', 'judge:enable'];

test('pwsh: registers a native completer and includes commands', () => {
  const s = completionScript('pwsh', cmds) ?? '';
  assert.match(s, /Register-ArgumentCompleter/);
  assert.match(s, /judge:enable/);
});

test('bash: defines a completion fn and handles the colon word-break', () => {
  const s = completionScript('bash', cmds) ?? '';
  assert.match(s, /complete -F _mileage_completions mileage/);
  assert.match(s, /judge:enable/);
  assert.match(s, /COMPREPLY/);
});

test('zsh: uses compdef', () => {
  const s = completionScript('zsh', cmds) ?? '';
  assert.match(s, /compdef _mileage mileage/);
  assert.match(s, /judge:enable/);
});

test('unknown shell → null', () => {
  assert.equal(completionScript('fish', cmds), null);
});
