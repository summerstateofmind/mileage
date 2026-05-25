import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectReposToSync } from './repo_selection';
import { normalizePath } from '../storage/paths';
import type { ProjectInfo } from '../storage/types';

function proj(hash: string, p: string): ProjectInfo {
  return { project_hash: hash, name: hash, path: p, first_seen: 0, last_seen: 0 };
}

test('selectReposToSync returns all known repos when nothing excluded', () => {
  const out = selectReposToSync([proj('h1', '/a'), proj('h2', '/b')], []);
  assert.deepEqual(out.map((r) => r.project_hash), ['h1', 'h2']);
});

test('selectReposToSync drops excluded repos by normalized path', () => {
  const known = [proj('h1', '/a/Repo'), proj('h2', '/b')];
  const out = selectReposToSync(known, [normalizePath('/a/Repo/')]);
  assert.deepEqual(out.map((r) => r.project_hash), ['h2']);
});

test('selectReposToSync dedups by project hash', () => {
  const out = selectReposToSync([proj('h1', '/a'), proj('h1', '/a')], []);
  assert.equal(out.length, 1);
});
