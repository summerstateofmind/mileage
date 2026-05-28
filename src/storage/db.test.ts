import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from './schema';
import { insertSession, getSessionsSpanningCommit, getPrecedingSessions, insertVerdict, getVerdict, getVerdictsForSessions, purgeVerdicts } from './db';
import type { SessionEvent } from './types';

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
  db.exec("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')");
  return db;
}

function session(id: string, start: number, end: number, project = 'P'): SessionEvent {
  return {
    id,
    timestamp: start,
    type: 'session',
    source: 'claude_code',
    project_hash: project,
    session_id: id,
    tokens_in: 1,
    tokens_out: 1,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    cost_usd: 0,
    pricing_version: 'test',
    pricing_fallback: false,
    model_id: 'm',
    session_end_ms: end,
  };
}

test('spanning: commit inside [start,end] matches', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000));
  const rows = getSessionsSpanningCommit(db, 3000, 'P', 0, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].session_id, 's1');
});

test('spanning: grace lets a commit just after end match; without grace it does not', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000));
  assert.equal(getSessionsSpanningCommit(db, 6000, 'P', 0, 0).length, 0);
  assert.equal(getSessionsSpanningCommit(db, 6000, 'P', 0, 2000).length, 1);
});

test('spanning: other project is excluded', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000, 'OTHER'));
  assert.equal(getSessionsSpanningCommit(db, 3000, 'P', 0, 0).length, 0);
});

test('preceding: returns same-project sessions ended within the window before the commit', () => {
  const db = memDb();
  insertSession(db, session('old', 100, 1000));
  insertSession(db, session('recent', 2000, 4000));
  const rows = getPrecedingSessions(db, 5000, 'P', 2000); // window end_ms in [3000,5000]
  assert.deepEqual(
    rows.map((r) => r.session_id),
    ['recent'],
  );
});

test('verdict insert/get/getMany/purge round-trips with tier', () => {
  const db = memDb();
  insertVerdict(db, { session_id: 's1', tier: 'stalled', confidence: 0.82, model: 'qwen2.5:3b', rationale: 'looped on regex', judged_at: 100 });
  const v = getVerdict(db, 's1');
  assert.equal(v?.tier, 'stalled');
  assert.equal(v?.confidence, 0.82);
  const m = getVerdictsForSessions(db, ['s1', 's2']);
  assert.equal(m.get('s1')?.model, 'qwen2.5:3b');
  assert.equal(m.has('s2'), false);
  purgeVerdicts(db);
  assert.equal(getVerdict(db, 's1'), null);
});

test('verdict rejects disallowed tier value', () => {
  const db = memDb();
  assert.throws(() => {
    insertVerdict(db, { session_id: 's1', tier: 'productive', confidence: 0.9, model: 'm', rationale: '', judged_at: 100 });
  });
});

test('each valid tier inserts without error', () => {
  const db = memDb();
  for (const tier of ['high', 'solid', 'thin', 'stalled', 'unrated']) {
    insertVerdict(db, { session_id: `s-${tier}`, tier, confidence: 0.5, model: 'm', rationale: '', judged_at: 100 });
    assert.equal(getVerdict(db, `s-${tier}`)?.tier, tier);
  }
});
