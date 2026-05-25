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
