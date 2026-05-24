import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideAttribution, attributeInferred } from './attribution';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL } from '../storage/schema';
import { insertSession, insertCommit } from '../storage/db';
import type { SessionEvent, CommitEvent } from '../storage/types';

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

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA_SQL);
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

function commit(hash: string, ts: number, project = 'P'): CommitEvent {
  return {
    id: `git:${hash}`,
    timestamp: ts,
    type: 'commit',
    source: 'git',
    project_hash: project,
    commit_hash: hash,
    lines_added: 10,
    lines_removed: 0,
    files_changed: 1,
    primary_language: 'ts',
    branch: 'main',
  };
}

test('attributeInferred: a commit inside one session span gets the high tier', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 10000));
  insertCommit(db, commit('hash1', 5000));
  const n = attributeInferred(db, 0);
  assert.equal(n, 1);
  const row = db
    .prepare(`SELECT session_id, tier, confidence FROM attributions`)
    .get() as { session_id: string; tier: string; confidence: number };
  assert.equal(row.session_id, 's1');
  assert.equal(row.tier, 'high');
  assert.equal(row.confidence, 0.85);
});

test('attributeInferred: two concurrent same-repo sessions → abstain (no row)', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 10000));
  insertSession(db, session('s2', 2000, 11000));
  insertCommit(db, commit('hash1', 5000));
  const n = attributeInferred(db, 0);
  assert.equal(n, 0);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM attributions`).get() as { c: number };
  assert.equal(count.c, 0);
});

test('attributeInferred: gap commit attaches to nearest preceding session as inferred', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 5000));
  insertCommit(db, commit('hash1', 5000 + 10 * 60_000)); // 10 min after end: in 15-min window, outside 5-min grace
  const n = attributeInferred(db, 0);
  assert.equal(n, 1);
  const row = db
    .prepare(`SELECT session_id, tier FROM attributions`)
    .get() as { session_id: string; tier: string };
  assert.equal(row.session_id, 's1');
  assert.equal(row.tier, 'inferred');
});

test('attributeInferred: idempotent — running twice yields one row', () => {
  const db = memDb();
  insertSession(db, session('s1', 1000, 10000));
  insertCommit(db, commit('hash1', 5000));
  attributeInferred(db, 0);
  attributeInferred(db, 0);
  const count = db.prepare(`SELECT COUNT(*) AS c FROM attributions`).get() as { c: number };
  assert.equal(count.c, 1);
});
