import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAttribution } from './attribution';

test('decide: exactly one spanning session → high 0.85', () => {
  const d = decideAttribution([{ session_id: 's1', session_end_ms: 100 }], []);
  assert.deepEqual(d, { session_id: 's1', tier: 'high', confidence: 0.85 });
});

test('decide: two spanning sessions → abstain (null)', () => {
  const d = decideAttribution(
    [
      { session_id: 's1', session_end_ms: 100 },
      { session_id: 's2', session_end_ms: 110 },
    ],
    [],
  );
  assert.equal(d, null);
});

test('decide: no spanning, picks nearest preceding → inferred 0.5', () => {
  const d = decideAttribution(
    [],
    [
      { session_id: 'old', session_end_ms: 100 },
      { session_id: 'recent', session_end_ms: 500 },
    ],
  );
  assert.deepEqual(d, { session_id: 'recent', tier: 'inferred', confidence: 0.5 });
});

test('decide: no spanning, no preceding → null', () => {
  assert.equal(decideAttribution([], []), null);
});
