import { DatabaseSync } from 'node:sqlite';
import { gatherComposites, type SessionComposite } from './composite_outcomes';
import type { SessionAttribution } from '../storage/db';

export type EffBucket = 'shipped' | 'likely' | 'research';

// A direct/high session whose committed lines mostly disappear is downgraded
// from "shipped" to "likely" — it committed, but the work didn't stick.
const SURVIVAL_SHIPPED_MIN = 0.5;

export function classifySessionBucket(
  composite: SessionComposite,
  attrs: SessionAttribution[],
): EffBucket {
  if (composite.tag === 'shipped') return 'shipped';
  if (composite.tag === 'exploring' || composite.tag === 'dead-end') return 'research';
  if (attrs.length === 0) return 'research';

  const strong = attrs.some((a) => a.tier === 'direct' || a.tier === 'high');
  if (!strong) return 'likely';

  const evaluated = attrs.filter(
    (a) => a.lines_surviving !== null && a.lines_added > 0,
  );
  if (evaluated.length > 0) {
    const added = evaluated.reduce((sum, a) => sum + a.lines_added, 0);
    const surviving = evaluated.reduce((sum, a) => sum + (a.lines_surviving as number), 0);
    if (added > 0 && surviving / added < SURVIVAL_SHIPPED_MIN) return 'likely';
  }
  return 'shipped';
}

export interface EffTally {
  shipped: number;
  likely: number;
  research: number;
  total: number;
}

export function bucketWindow(
  db: DatabaseSync,
  startMs: number,
  endMs: number,
  projectHash?: string,
): EffTally {
  const { composites, attrMap } = gatherComposites(db, startMs, endMs, projectHash);
  const t: EffTally = { shipped: 0, likely: 0, research: 0, total: composites.length };
  for (const c of composites) {
    const bucket = classifySessionBucket(c, attrMap.get(c.session_id) ?? []);
    t[bucket]++;
  }
  return t;
}
