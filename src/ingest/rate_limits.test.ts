import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectRateLimitHit,
  detectApiErrorRateLimit,
  clusterRateLimitHits,
  RATE_LIMIT_CLUSTER_GAP_MS,
} from './rate_limits';
import type { RateLimitHit } from '../storage/types';

const hit = (timestamp: number, session_id: string | null = 's'): RateLimitHit => ({
  id: `${timestamp}-${session_id}`,
  timestamp,
  session_id,
  window: '5h',
  raw_message: '',
});
const MIN = 60_000;

test('detectApiErrorRateLimit: isApiErrorMessage + error rate_limit → hit, 5h from "session limit"', () => {
  const hit = detectApiErrorRateLimit(
    { isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429 },
    "You've hit your session limit · resets 2pm (America/Los_Angeles)",
    1000,
    's1',
  );
  assert.notEqual(hit, null);
  assert.equal(hit?.window, '5h');
});

test('detectApiErrorRateLimit: 429 status alone qualifies; weekly → 7d', () => {
  const hit = detectApiErrorRateLimit({ isApiErrorMessage: true, apiErrorStatus: 429 }, 'weekly limit reached', 1, null);
  assert.equal(hit?.window, '7d');
});

test('detectApiErrorRateLimit: not an api error → null', () => {
  assert.equal(detectApiErrorRateLimit({ isApiErrorMessage: false }, 'session limit', 1, null), null);
  assert.equal(detectApiErrorRateLimit({}, 'anything', 1, null), null);
});

test('detectRateLimitHit still matches genuine rate_limit_error text', () => {
  assert.notEqual(detectRateLimitHit('{"type":"rate_limit_error"}', 1, null), null);
});

test('detectRateLimitHit ignores ordinary conversation about rate limits', () => {
  assert.equal(detectRateLimitHit('just discussing rate limits in a prompt', 1, null), null);
});

test('clusterRateLimitHits: a retry storm in one window collapses to ONE event', () => {
  const base = 100 * MIN;
  const storm = [0, 1, 2, 3, 5].map((m) => hit(base + m * MIN)); // five 429s over 5 min
  const events = clusterRateLimitHits(storm);
  assert.equal(events.length, 1);
});

test('clusterRateLimitHits: simultaneous 429s from different instances = ONE event', () => {
  const base = 100 * MIN;
  // three concurrent instances all 429 within a minute — one account-level wall hit
  const events = clusterRateLimitHits([hit(base, 'a'), hit(base + 5_000, 'b'), hit(base + 20_000, 'c')]);
  assert.equal(events.length, 1);
});

test('clusterRateLimitHits: hits hours apart are distinct events', () => {
  const base = 100 * MIN;
  const events = clusterRateLimitHits([hit(base), hit(base + 4 * 60 * MIN)]); // 4 hours apart
  assert.equal(events.length, 2);
});

test('clusterRateLimitHits: representative timestamp is the earliest of the cluster, result DESC', () => {
  const base = 100 * MIN;
  const events = clusterRateLimitHits([hit(base + 2 * MIN), hit(base), hit(base + 1 * MIN), hit(base + 90 * MIN)]);
  assert.equal(events.length, 2);
  assert.equal(events[0].timestamp, base + 90 * MIN); // newest first (DESC)
  assert.equal(events[1].timestamp, base); // earliest of the first cluster
});

test('clusterRateLimitHits: empty and single pass through', () => {
  assert.deepEqual(clusterRateLimitHits([]), []);
  assert.equal(clusterRateLimitHits([hit(5)]).length, 1);
  assert.ok(RATE_LIMIT_CLUSTER_GAP_MS > 0);
});
