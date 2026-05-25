import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { classifySessionBucket, bucketWindow } from './effectiveness';
import type { SessionComposite } from './composite_outcomes';
import { SCHEMA_SQL } from '../storage/schema';
import { insertSession, insertCommit, insertAttribution } from '../storage/db';
import type { SessionAttribution } from '../storage/db';
import type {
  SessionTag,
  AttributionTier,
  SessionEvent,
  CommitEvent,
} from '../storage/types';

function comp(tag: SessionTag | null): SessionComposite {
  return {
    session_id: 's',
    timestamp: 0,
    project_hash: 'P',
    tokens: 1000,
    model_id: 'm',
    tag,
    composite_outcomes: 0,
    scorable: true,
  };
}

function attr(
  tier: AttributionTier,
  lines_added = 10,
  lines_surviving: number | null = null,
): SessionAttribution {
  return {
    session_id: 's',
    tier,
    commit_hash: 'h',
    lines_added,
    lines_surviving,
    survival_window_days: lines_surviving === null ? null : 7,
  };
}

test('classify: tagged shipped → shipped (even with no attrs)', () => {
  assert.equal(classifySessionBucket(comp('shipped'), []), 'shipped');
});

test('classify: tagged exploring → research', () => {
  assert.equal(classifySessionBucket(comp('exploring'), [attr('direct')]), 'research');
});

test('classify: tagged dead-end → research', () => {
  assert.equal(classifySessionBucket(comp('dead-end'), [attr('direct')]), 'research');
});

test('classify: untagged, no attrs → research', () => {
  assert.equal(classifySessionBucket(comp(null), []), 'research');
});

test('classify: inferred-only → likely', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('inferred')]), 'likely');
});

test('classify: direct + surviving → shipped', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('direct', 10, 10)]), 'shipped');
});

test('classify: direct + survival unknown → shipped', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('high', 10, null)]), 'shipped');
});

test('classify: direct but mostly reverted (<50% survive) → likely', () => {
  assert.equal(classifySessionBucket(comp(null), [attr('direct', 10, 2)]), 'likely');
});

test('classify: debugging tag falls through to attribution → shipped', () => {
  assert.equal(classifySessionBucket(comp('debugging'), [attr('direct', 10, 10)]), 'shipped');
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

test('bucketWindow tallies sessions into shipped/likely/research', () => {
  const db = memDb();
  insertSession(db, session('s_ship', 1000, 2000));
  insertSession(db, session('s_research', 1100, 2100));
  insertSession(db, session('s_likely', 1200, 2200));
  insertCommit(db, commit('hship', 1500));
  insertCommit(db, commit('hlikely', 1700));
  insertAttribution(db, { session_id: 's_ship', commit_hash: 'hship', tier: 'direct', confidence: 1 });
  insertAttribution(db, { session_id: 's_likely', commit_hash: 'hlikely', tier: 'inferred', confidence: 0.5 });

  const t = bucketWindow(db, 0, 10000, undefined);
  assert.equal(t.total, 3);
  assert.equal(t.shipped, 1);
  assert.equal(t.likely, 1);
  assert.equal(t.research, 1);
});
