import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExcludedRepo, withoutExcludedRepo, DEFAULT_CONFIG } from './plan';
import { normalizePath } from '../storage/paths';

test('withExcludedRepo adds a normalized path and dedups', () => {
  const c0 = { ...DEFAULT_CONFIG, excluded_repos: [] as string[] };
  const c1 = withExcludedRepo(c0, '/Users/x/Repo/');
  assert.equal(c1.excluded_repos.length, 1);
  assert.equal(c1.excluded_repos[0], normalizePath('/Users/x/Repo/'));
  const c2 = withExcludedRepo(c1, '/Users/x/Repo'); // same path after normalization
  assert.equal(c2.excluded_repos.length, 1);
});

test('withoutExcludedRepo removes by normalized path', () => {
  const c0 = { ...DEFAULT_CONFIG, excluded_repos: [normalizePath('/Users/x/Repo')] };
  const c1 = withoutExcludedRepo(c0, '/Users/x/Repo/');
  assert.equal(c1.excluded_repos.length, 0);
});

test('withExcludedRepo does not mutate the input config', () => {
  const c0 = { ...DEFAULT_CONFIG, excluded_repos: [] as string[] };
  withExcludedRepo(c0, '/a/b');
  assert.equal(c0.excluded_repos.length, 0);
});
