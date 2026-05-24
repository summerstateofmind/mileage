import { DatabaseSync } from 'node:sqlite';
import { mileageDbPath } from './paths';
import { SCHEMA_SQL } from './schema';
import type {
  SessionEvent,
  CommitEvent,
  Attribution,
  Snapshot,
  TopSession,
  RateLimitHit,
  SessionTag,
  SessionTagRow,
} from './types';

export function openDb(): DatabaseSync {
  const db = new DatabaseSync(mileageDbPath());
  db.exec(SCHEMA_SQL);
  db.exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1')");
  return db;
}

export function insertSession(db: DatabaseSync, ev: SessionEvent): void {
  db.prepare(
    `INSERT OR REPLACE INTO events
     (id, timestamp, type, source, project_hash, created_at,
      session_id, tokens_in, tokens_out, cache_creation_tokens, cache_read_tokens,
      cost_usd, pricing_version, pricing_fallback, model_id, session_end_ms)
     VALUES (?, ?, 'session', 'claude_code', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.id,
    ev.timestamp,
    ev.project_hash,
    Date.now(),
    ev.session_id,
    ev.tokens_in,
    ev.tokens_out,
    ev.cache_creation_tokens,
    ev.cache_read_tokens,
    ev.cost_usd,
    ev.pricing_version,
    ev.pricing_fallback ? 1 : 0,
    ev.model_id,
    ev.session_end_ms,
  );
}

export function insertCommit(db: DatabaseSync, ev: CommitEvent): void {
  db.prepare(
    `INSERT OR REPLACE INTO events
     (id, timestamp, type, source, project_hash, created_at,
      commit_hash, lines_added, lines_removed, files_changed, primary_language, branch)
     VALUES (?, ?, 'commit', 'git', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ev.id,
    ev.timestamp,
    ev.project_hash,
    Date.now(),
    ev.commit_hash,
    ev.lines_added,
    ev.lines_removed,
    ev.files_changed,
    ev.primary_language,
    ev.branch,
  );
}

export function insertAttribution(db: DatabaseSync, attr: Attribution): void {
  db.prepare(
    `INSERT OR REPLACE INTO attributions
     (session_id, commit_hash, tier, confidence, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(attr.session_id, attr.commit_hash, attr.tier, attr.confidence, Date.now());
}

export function upsertSnapshot(db: DatabaseSync, s: Snapshot): void {
  db.prepare(
    `INSERT OR REPLACE INTO snapshots
     (date, project_hash, total_tokens_in, total_tokens_out, total_cost_usd,
      session_count, commit_count, attributed_commit_count,
      direct_attribution_count, inferred_attribution_count,
      ypt_score, cost_per_ship_tokens, cost_per_ship_usd, provenance, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.date,
    s.project_hash,
    s.total_tokens_in,
    s.total_tokens_out,
    s.total_cost_usd,
    s.session_count,
    s.commit_count,
    s.attributed_commit_count,
    s.direct_attribution_count,
    s.inferred_attribution_count,
    s.ypt_score,
    s.cost_per_ship_tokens,
    s.cost_per_ship_usd,
    JSON.stringify(s.provenance),
    s.computed_at,
  );
}

export function getSnapshotsSince(
  db: DatabaseSync,
  sinceDate: string,
  projectHash?: string,
): Snapshot[] {
  const sql = projectHash
    ? `SELECT * FROM snapshots WHERE date >= ? AND project_hash = ? ORDER BY date`
    : `SELECT * FROM snapshots WHERE date >= ? ORDER BY date`;
  const params: unknown[] = projectHash ? [sinceDate, projectHash] : [sinceDate];
  const rows = db.prepare(sql).all(...(params as never[])) as unknown[];
  return rows.map((r: any) => ({
    ...r,
    provenance: r.provenance ? JSON.parse(r.provenance) : {},
  })) as Snapshot[];
}

export function getDistinctProjectDates(
  db: DatabaseSync,
  sinceMs: number,
): { date: string; project_hash: string }[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT
         strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') AS date,
         project_hash
       FROM events
       WHERE timestamp >= ?
       ORDER BY date`,
    )
    .all(sinceMs) as unknown as { date: string; project_hash: string }[];
  return rows;
}

export interface DailyAggregate {
  date: string;
  project_hash: string;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  session_count: number;
  commit_count: number;
  attributed_commit_count: number;
  direct_attribution_count: number;
  inferred_attribution_count: number;
}

export function aggregateDay(
  db: DatabaseSync,
  date: string,
  projectHash: string,
): DailyAggregate {
  const sessionRow = db
    .prepare(
      `SELECT
         COALESCE(SUM(tokens_in),0) AS ti,
         COALESCE(SUM(tokens_out),0) AS toks,
         COALESCE(SUM(cost_usd),0) AS cost,
         COUNT(*) AS n
       FROM events
       WHERE type='session'
         AND project_hash = ?
         AND strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') = ?`,
    )
    .get(projectHash, date) as any;

  const commitRow = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM events
       WHERE type='commit'
         AND project_hash = ?
         AND strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') = ?`,
    )
    .get(projectHash, date) as any;

  const attrRow = db
    .prepare(
      `SELECT
         COUNT(*) AS n,
         SUM(CASE WHEN a.tier='direct' THEN 1 ELSE 0 END) AS direct_n,
         SUM(CASE WHEN a.tier='inferred' THEN 1 ELSE 0 END) AS inferred_n
       FROM attributions a
       JOIN events e ON e.commit_hash = a.commit_hash AND e.type='commit'
       WHERE e.project_hash = ?
         AND strftime('%Y-%m-%d', e.timestamp / 1000, 'unixepoch') = ?`,
    )
    .get(projectHash, date) as any;

  return {
    date,
    project_hash: projectHash,
    total_tokens_in: Number(sessionRow.ti || 0),
    total_tokens_out: Number(sessionRow.toks || 0),
    total_cost_usd: Number(sessionRow.cost || 0),
    session_count: Number(sessionRow.n || 0),
    commit_count: Number(commitRow.n || 0),
    attributed_commit_count: Number(attrRow?.n || 0),
    direct_attribution_count: Number(attrRow?.direct_n || 0),
    inferred_attribution_count: Number(attrRow?.inferred_n || 0),
  };
}

export function getUnattributedCommitsSince(
  db: DatabaseSync,
  sinceMs: number,
): CommitEvent[] {
  const rows = db
    .prepare(
      `SELECT e.* FROM events e
       LEFT JOIN attributions a ON a.commit_hash = e.commit_hash
       WHERE e.type = 'commit'
         AND e.timestamp >= ?
         AND a.commit_hash IS NULL`,
    )
    .all(sinceMs) as unknown as CommitEvent[];
  return rows;
}

export function getSessionsInWindow(
  db: DatabaseSync,
  startMs: number,
  endMs: number,
  projectHash: string,
): SessionEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM events
       WHERE type = 'session'
         AND project_hash = ?
         AND session_end_ms BETWEEN ? AND ?`,
    )
    .all(projectHash, startMs, endMs) as unknown as SessionEvent[];
  return rows;
}

export function getTopExpensiveSessions(
  db: DatabaseSync,
  fromMs: number,
  n: number,
  projectHash?: string,
): TopSession[] {
  const projFilter = projectHash ? `AND e.project_hash = ?` : '';
  const params: unknown[] = projectHash ? [fromMs, projectHash, n] : [fromMs, n];
  const rows = db
    .prepare(
      `SELECT
         e.session_id        AS session_id,
         e.timestamp         AS timestamp,
         e.cost_usd          AS cost_usd,
         (e.session_end_ms - e.timestamp) AS duration_ms,
         COALESCE(e.model_id, 'unknown') AS model_id,
         (SELECT COUNT(*) FROM attributions a WHERE a.session_id = e.session_id) AS attr_count
       FROM events e
       WHERE e.type = 'session'
         AND e.timestamp >= ?
         ${projFilter}
       ORDER BY e.cost_usd DESC
       LIMIT ?`,
    )
    .all(...(params as never[])) as unknown as TopSession[];
  return rows;
}

export function setSessionTag(
  db: DatabaseSync,
  sessionId: string,
  tag: SessionTag,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO session_tags (session_id, tag, tagged_at)
     VALUES (?, ?, ?)`,
  ).run(sessionId, tag, Date.now());
}

export function getSessionTag(
  db: DatabaseSync,
  sessionId: string,
): SessionTagRow | null {
  const row = db
    .prepare(`SELECT session_id, tag, tagged_at FROM session_tags WHERE session_id = ?`)
    .get(sessionId) as unknown as SessionTagRow | undefined;
  return row ?? null;
}

export function getAllTagsSince(
  db: DatabaseSync,
  sinceMs: number,
): Map<string, SessionTag> {
  const rows = db
    .prepare(
      `SELECT st.session_id, st.tag
       FROM session_tags st
       JOIN events e ON e.session_id = st.session_id
       WHERE e.timestamp >= ?`,
    )
    .all(sinceMs) as unknown as { session_id: string; tag: SessionTag }[];
  const out = new Map<string, SessionTag>();
  for (const r of rows) out.set(r.session_id, r.tag);
  return out;
}

export interface UntaggedSession {
  session_id: string;
  timestamp: number;
  cost_usd: number;
  duration_ms: number;
  model_id: string;
  attr_count: number;
}

export function getUntaggedSessionsSince(
  db: DatabaseSync,
  sinceMs: number,
  minCostUsd: number = 1,
  limit: number = 20,
): UntaggedSession[] {
  const rows = db
    .prepare(
      `SELECT
         e.session_id,
         e.timestamp,
         e.cost_usd,
         (e.session_end_ms - e.timestamp) AS duration_ms,
         COALESCE(e.model_id, 'unknown') AS model_id,
         (SELECT COUNT(*) FROM attributions a WHERE a.session_id = e.session_id) AS attr_count
       FROM events e
       LEFT JOIN session_tags st ON st.session_id = e.session_id
       WHERE e.type = 'session'
         AND e.timestamp >= ?
         AND e.cost_usd >= ?
         AND st.session_id IS NULL
       ORDER BY e.cost_usd DESC
       LIMIT ?`,
    )
    .all(sinceMs, minCostUsd, limit) as unknown as UntaggedSession[];
  return rows;
}

export function insertRateLimitHit(db: DatabaseSync, h: RateLimitHit): void {
  db.prepare(
    `INSERT OR IGNORE INTO rate_limit_hits
     (id, timestamp, session_id, window, raw_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(h.id, h.timestamp, h.session_id, h.window, h.raw_message, Date.now());
}

export function getRateLimitHitsSince(
  db: DatabaseSync,
  sinceMs: number,
): RateLimitHit[] {
  const rows = db
    .prepare(
      `SELECT id, timestamp, session_id, window, raw_message
       FROM rate_limit_hits
       WHERE timestamp >= ?
       ORDER BY timestamp DESC`,
    )
    .all(sinceMs) as unknown as RateLimitHit[];
  return rows;
}

export function resolveFullCommitHash(
  db: DatabaseSync,
  prefix: string,
): string | null {
  const rows = db
    .prepare(
      `SELECT commit_hash FROM events
       WHERE type='commit' AND commit_hash LIKE ? || '%'
       LIMIT 2`,
    )
    .all(prefix) as unknown as { commit_hash: string }[];
  if (rows.length === 1) return rows[0].commit_hash;
  return null;
}
