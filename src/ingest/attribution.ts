import { DatabaseSync } from 'node:sqlite';
import {
  insertAttribution,
  resolveFullCommitHash,
  getUnattributedCommitsSince,
  getSessionsInWindow,
} from '../storage/db';
import type { ToolCommitHint } from '../storage/types';

const INFERRED_WINDOW_MS = 5 * 60_000;

export function attributeDirect(
  db: DatabaseSync,
  hints: ToolCommitHint[],
): number {
  let written = 0;
  for (const h of hints) {
    const full =
      h.commit_hash.length >= 40
        ? h.commit_hash
        : resolveFullCommitHash(db, h.commit_hash);
    if (!full) continue;
    insertAttribution(db, {
      session_id: h.session_id,
      commit_hash: full,
      tier: 'direct',
      confidence: 1.0,
    });
    written++;
  }
  return written;
}

export function attributeInferred(db: DatabaseSync, sinceMs: number): number {
  const commits = getUnattributedCommitsSince(db, sinceMs);
  let written = 0;
  for (const c of commits) {
    const start = c.timestamp - INFERRED_WINDOW_MS;
    const end = c.timestamp + INFERRED_WINDOW_MS;
    const candidates = getSessionsInWindow(db, start, end, c.project_hash);
    if (candidates.length === 0) continue;

    let best = candidates[0];
    let bestDiff = Math.abs(best.session_end_ms - c.timestamp);
    for (let i = 1; i < candidates.length; i++) {
      const diff = Math.abs(candidates[i].session_end_ms - c.timestamp);
      if (diff < bestDiff) {
        best = candidates[i];
        bestDiff = diff;
      }
    }

    insertAttribution(db, {
      session_id: best.session_id,
      commit_hash: c.commit_hash,
      tier: 'inferred',
      confidence: 0.5,
    });
    written++;
  }
  return written;
}
