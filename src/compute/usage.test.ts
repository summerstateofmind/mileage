import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../storage/schema';
import { insertSession, insertRateLimitHit } from '../storage/db';
import { computeUsageCheck } from './usage';
import type { SessionEvent, RateLimitHit } from '../storage/types';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
  return db;
}

function session(id: string, ts: number, tin: number, tout: number): SessionEvent {
  return {
    id,
    timestamp: ts,
    type: 'session',
    source: 'claude_code',
    project_hash: 'P',
    session_id: id,
    tokens_in: tin,
    tokens_out: tout,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    pricing_version: 'test',
    pricing_fallback: false,
    model_id: 'm',
    session_end_ms: ts + 1000,
  };
}

function hit(ts: number): RateLimitHit {
  return { id: `h-${ts}`, timestamp: ts, session_id: null, window: '5h', raw_message: '429' };
}

test('computeUsageCheck reports token volume without any cap %, warning level, or reset time', () => {
  const db = memDb();
  const now = Date.now();
  insertSession(db, session('s1', now - 60_000, 10_000, 5_000));
  const u = computeUsageCheck(db, 'max-100');

  assert.equal(u.five_hour.tokens_used, 15_000);
  assert.equal(u.seven_day.tokens_used, 15_000);
  // The misleading fields are gone entirely.
  assert.equal('cap_estimate' in u.five_hour, false);
  assert.equal('percent_used' in u.five_hour, false);
  assert.equal('warning_level' in u.five_hour, false);
  assert.equal('ms_until_reset' in u.five_hour, false);
  assert.equal('recommended_action' in u, false);
  // /usage is surfaced as the authority.
  assert.match(u.guidance, /\/usage/);
});

test('computeUsageCheck clusters rate-limit hits within the 10-min gap into one event', () => {
  const db = memDb();
  const now = Date.now();
  // Three 429s in a 2-minute burst = one cap-exhaustion event.
  insertRateLimitHit(db, hit(now - 5 * 60_000));
  insertRateLimitHit(db, hit(now - 5 * 60_000 + 30_000));
  insertRateLimitHit(db, hit(now - 5 * 60_000 + 90_000));
  // A separate event > 10 min later.
  insertRateLimitHit(db, hit(now - 60 * 60_000));

  const u = computeUsageCheck(db, 'max-100');
  assert.equal(u.recent_rate_limit_hits, 2);
});
