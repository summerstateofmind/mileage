import { DatabaseSync } from 'node:sqlite';
import {
  getSessionsInRangeForOutcomes,
  getAttributionsForSessions,
  type SessionAttribution,
  type SessionOutcomeRow,
} from '../storage/db';
import type { AttributionTier, SessionTag } from '../storage/types';

const ATTR_WEIGHTS: Record<AttributionTier, number> = {
  direct: 1.0,
  high: 0.85,
  inferred: 0.5,
};

const SURVIVAL_FLOOR = 0.1;

export interface SessionComposite {
  session_id: string;
  timestamp: number;
  project_hash: string;
  tokens: number;
  model_id: string;
  tag: SessionTag | null;
  composite_outcomes: number;
  scorable: boolean;
  excluded_reason?: 'exploring';
}

export interface CompositeRollup {
  tokens: number;
  composite_outcomes: number;
  scorable_sessions: number;
  unscorable_sessions: number;
  excluded_sessions: number;
  attribution_breakdown: Record<AttributionTier, number>;
  self_tag_breakdown: Record<SessionTag, number>;
  survival_weight_applied: boolean;
}

function survivalWeight(a: SessionAttribution): number {
  if (a.survival_window_days === null || a.lines_surviving === null) return 1.0;
  if (a.lines_added <= 0) return 1.0;
  const raw = a.lines_surviving / a.lines_added;
  return Math.max(SURVIVAL_FLOOR, Math.min(1, raw));
}

export function computeSessionComposite(
  session: SessionOutcomeRow,
  attrs: SessionAttribution[],
): SessionComposite {
  if (session.tag === 'exploring') {
    return {
      ...session,
      composite_outcomes: 0,
      scorable: false,
      excluded_reason: 'exploring',
    };
  }

  if (session.tag === 'dead-end') {
    return {
      ...session,
      composite_outcomes: 0,
      scorable: true,
    };
  }

  let composite = 0;
  for (const a of attrs) {
    const w = ATTR_WEIGHTS[a.tier];
    const s = survivalWeight(a);
    composite += w * s;
  }

  if (session.tag === 'shipped' && composite < 1.0) {
    composite = 1.0;
  }

  const scorable =
    composite > 0 || session.tag === 'shipped' || session.tag === 'debugging';

  return {
    ...session,
    composite_outcomes: composite,
    scorable,
  };
}

export function rollupComposite(
  composites: SessionComposite[],
  allAttrs: Map<string, SessionAttribution[]>,
): CompositeRollup {
  let tokens = 0;
  let outcomes = 0;
  let scorable = 0;
  let unscorable = 0;
  let excluded = 0;
  let survivalApplied = false;
  const attrBreakdown: Record<AttributionTier, number> = {
    direct: 0,
    high: 0,
    inferred: 0,
  };
  const tagBreakdown: Record<SessionTag, number> = {
    shipped: 0,
    exploring: 0,
    debugging: 0,
    'dead-end': 0,
  };

  for (const c of composites) {
    if (c.excluded_reason === 'exploring') {
      excluded++;
      tagBreakdown.exploring++;
      continue;
    }
    tokens += c.tokens;
    outcomes += c.composite_outcomes;
    if (c.scorable) scorable++;
    else unscorable++;
    if (c.tag) tagBreakdown[c.tag]++;
    const attrs = allAttrs.get(c.session_id) ?? [];
    for (const a of attrs) {
      attrBreakdown[a.tier]++;
      if (a.survival_window_days !== null) survivalApplied = true;
    }
  }

  return {
    tokens,
    composite_outcomes: outcomes,
    scorable_sessions: scorable,
    unscorable_sessions: unscorable,
    excluded_sessions: excluded,
    attribution_breakdown: attrBreakdown,
    self_tag_breakdown: tagBreakdown,
    survival_weight_applied: survivalApplied,
  };
}

export function gatherComposites(
  db: DatabaseSync,
  startMs: number,
  endMs: number,
  projectHash?: string,
): { composites: SessionComposite[]; attrMap: Map<string, SessionAttribution[]> } {
  const sessions = getSessionsInRangeForOutcomes(
    db,
    startMs,
    endMs,
    projectHash,
  );
  const attrs = getAttributionsForSessions(
    db,
    sessions.map((s) => s.session_id),
  );
  const attrMap = new Map<string, SessionAttribution[]>();
  for (const a of attrs) {
    const arr = attrMap.get(a.session_id) ?? [];
    arr.push(a);
    attrMap.set(a.session_id, arr);
  }
  const composites = sessions.map((s) =>
    computeSessionComposite(s, attrMap.get(s.session_id) ?? []),
  );
  return { composites, attrMap };
}
