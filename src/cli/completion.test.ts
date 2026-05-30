import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  completionScript,
  detectShell,
  normalizeShell,
  sourceLine,
  addBlock,
  removeBlock,
  MARKER_START,
  MARKER_END,
} from './completion';

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

test('detectShell: win32 → pwsh; $SHELL basename → bash/zsh; else null', () => {
  assert.equal(detectShell('win32', undefined), 'pwsh');
  assert.equal(detectShell('linux', '/bin/bash'), 'bash');
  assert.equal(detectShell('darwin', '/usr/bin/zsh'), 'zsh');
  assert.equal(detectShell('linux', '/usr/bin/fish'), null);
  assert.equal(detectShell('linux', undefined), null);
});

test('normalizeShell maps aliases and rejects unknown', () => {
  assert.equal(normalizeShell('powershell'), 'pwsh');
  assert.equal(normalizeShell('pwsh'), 'pwsh');
  assert.equal(normalizeShell('zsh'), 'zsh');
  assert.equal(normalizeShell('fish'), null);
});

test('sourceLine emits the right per-shell command', () => {
  assert.match(sourceLine('pwsh'), /Invoke-Expression/);
  assert.equal(sourceLine('bash'), 'source <(mileage completion bash)');
  assert.equal(sourceLine('zsh'), 'source <(mileage completion zsh)');
});

test('addBlock appends a marked block to an existing profile', () => {
  const before = 'export PATH=/foo\n';
  const { content, changed } = addBlock(before, 'bash');
  assert.equal(changed, true);
  assert.match(content, /export PATH=\/foo/);
  assert.match(content, new RegExp(MARKER_START.replace(/[>]/g, '\\$&')));
  assert.match(content, /source <\(mileage completion bash\)/);
  assert.match(content, new RegExp(MARKER_END.replace(/[<]/g, '\\$&')));
});

test('addBlock is idempotent — second call is a no-op', () => {
  const first = addBlock('', 'zsh');
  const second = addBlock(first.content, 'zsh');
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(second.content, first.content);
  // exactly one marker pair
  assert.equal(second.content.split(MARKER_START).length - 1, 1);
});

test('removeBlock strips the block and reports changed; no-op when absent', () => {
  const installed = addBlock('line1\n', 'bash').content;
  const { content, changed } = removeBlock(installed);
  assert.equal(changed, true);
  assert.equal(content.includes(MARKER_START), false);
  assert.match(content, /line1/);

  const noop = removeBlock('nothing here\n');
  assert.equal(noop.changed, false);
});
