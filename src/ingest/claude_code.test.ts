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
