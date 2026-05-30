import { DatabaseSync } from 'node:sqlite';

export interface TierFlexRow {
  model_id: string;
  sessions: number;
  sessions_with_outcome: number;
  yield_rate: number;
  avg_cost: number;
  total_cost: number;
}

export interface TierFlexWarning {
  higher_tier_model: string;
  lower_tier_model: string;
  cost_ratio: number;
  yield_high: number;
  yield_low: number;
  message: string;
}

export interface TierFlexResult {
  rows: TierFlexRow[];
  warning?: TierFlexWarning;
}

export function computeTierFlex(
  db: DatabaseSync,
  sinceMs: number,
  projectHash?: string,
): TierFlexResult {
  const projectClause = projectHash ? 'AND project_hash = ?' : '';
  const params: unknown[] = projectHash ? [sinceMs, projectHash] : [sinceMs];
  const rows = db
    .prepare(
      `SELECT
         model_id,
         COUNT(*) AS sessions,
         SUM(CASE WHEN session_id IN (SELECT session_id FROM attributions) THEN 1 ELSE 0 END) AS sessions_with_outcome,
         AVG(cost_usd) AS avg_cost,
         SUM(cost_usd) AS total_cost
       FROM events
       WHERE type = 'session'
         AND timestamp >= ?
         ${projectClause}
         AND model_id IS NOT NULL
         AND model_id <> 'unknown'
       GROUP BY model_id
       HAVING COUNT(*) >= 5
       ORDER BY total_cost DESC`,
    )
    .all(...(params as never[])) as any[];

  const tierFlexRows: TierFlexRow[] = rows.map((r) => ({
    model_id: String(r.model_id),
    sessions: Number(r.sessions),
    sessions_with_outcome: Number(r.sessions_with_outcome),
    yield_rate:
      Number(r.sessions) > 0
        ? Number(r.sessions_with_outcome) / Number(r.sessions)
        : 0,
    avg_cost: Number(r.avg_cost ?? 0),
    total_cost: Number(r.total_cost ?? 0),
  }));

  return { rows: tierFlexRows, warning: detectTierFlexWarning(tierFlexRows) };
}

type Tier = 'opus' | 'sonnet' | 'haiku' | 'other';

function tier(modelId: string): Tier {
  const m = modelId.toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  return 'other';
}

function detectTierFlexWarning(rows: TierFlexRow[]): TierFlexWarning | undefined {
  const byTier: Partial<Record<Tier, TierFlexRow>> = {};
  for (const r of rows) {
    const t = tier(r.model_id);
    if (t === 'other') continue;
    const cur = byTier[t];
    if (!cur || r.sessions > cur.sessions) byTier[t] = r;
  }

  const pairs: [Tier, Tier][] = [
    ['opus', 'sonnet'],
    ['sonnet', 'haiku'],
  ];
  for (const [hi, lo] of pairs) {
    const high = byTier[hi];
    const low = byTier[lo];
    if (!high || !low) continue;
    const costRatio = low.avg_cost > 0 ? high.avg_cost / low.avg_cost : Infinity;
    if (costRatio < 3) continue;
    if (high.yield_rate >= low.yield_rate) continue;
    if (low.yield_rate < high.yield_rate * 1.2) continue;

    return {
      higher_tier_model: high.model_id,
      lower_tier_model: low.model_id,
      cost_ratio: costRatio,
      yield_high: high.yield_rate,
      yield_low: low.yield_rate,
      message:
        `${high.model_id} costs ~${costRatio.toFixed(1)}× ${low.model_id} per session but ships outcomes only ${(high.yield_rate * 100).toFixed(0)}% of the time vs ${(low.yield_rate * 100).toFixed(0)}% for ${low.model_id}. ` +
        `Try ${low.model_id} first; reserve ${high.model_id} for when ${low.model_id} stalls.`,
    };
  }
  return undefined;
}
