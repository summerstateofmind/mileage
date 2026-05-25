import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectRateLimitHit, detectApiErrorRateLimit } from './rate_limits';

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
