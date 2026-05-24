import { DatabaseSync } from 'node:sqlite';
import {
  aggregateDay,
  getDistinctProjectDates,
  upsertSnapshot,
} from '../storage/db';
import type { Snapshot } from '../storage/types';
import {
  CURRENT_VERSION,
  ensureCalibration,
  scoreYieldRate,
} from './calibration';
import {
  gatherComposites,
  rollupComposite,
  type CompositeRollup,
  type SessionComposite,
} from './composite_outcomes';

const TOKENS_PER_UNIT = 100_000;

export function yptScoreV1(i: {
  direct_attribution_count: number;
  inferred_attribution_count: number;
  total_tokens: number;
}): number {
  const outcome =
    10 * i.direct_attribution_count + 5 * i.inferred_attribution_count;
  const tokens = Math.max(i.total_tokens, 1);
  const penalty = 5 * Math.log10(tokens / TOKENS_PER_UNIT);
  return Number((outcome - penalty).toFixed(2));
}

export interface PerModelStats {
  tokens: number;
  outcomes: number;
  sessions: number;
}

export interface YptV2Inputs {
  tokens: number;
  composite_outcomes: number;
  scorable_sessions: number;
  unscorable_sessions: number;
  by_model_sessions: Map<string, PerModelStats>;
}

export interface PerModelScore {
  sessions: number;
  outcomes: number;
  yield_rate: number;
  score: number;
}

export interface YptV2Result {
  score: number | null;
  yield_rate: number | null;
  by_model: Record<string, PerModelScore>;
}

export function yptScoreV2(
  inputs: YptV2Inputs,
  cal: { mu: number; sigma: number },
): YptV2Result {
  const byModel: Record<string, PerModelScore> = {};
  let weightedScore = 0;
  let weight = 0;

  for (const [model, m] of inputs.by_model_sessions) {
    if (m.tokens <= 0 || m.sessions === 0) continue;
    const rate = m.outcomes / (m.tokens / TOKENS_PER_UNIT);
    const score = scoreYieldRate(rate, cal.mu, cal.sigma);
    byModel[model] = {
      sessions: m.sessions,
      outcomes: Number(m.outcomes.toFixed(3)),
      yield_rate: Number(rate.toFixed(3)),
      score: Number(score.toFixed(2)),
    };
    weightedScore += score * m.sessions;
    weight += m.sessions;
  }

  if (inputs.scorable_sessions === 0 || inputs.tokens <= 0) {
    return { score: null, yield_rate: null, by_model: byModel };
  }

  const overallRate =
    inputs.composite_outcomes / (inputs.tokens / TOKENS_PER_UNIT);
  const overall =
    weight > 0
      ? weightedScore / weight
      : scoreYieldRate(overallRate, cal.mu, cal.sigma);
  return {
    score: Number(overall.toFixed(2)),
    yield_rate: Number(overallRate.toFixed(3)),
    by_model: byModel,
  };
}

function dayBoundsUtc(dateIso: string): { startMs: number; endMs: number } {
  const startMs = Date.parse(dateIso + 'T00:00:00Z');
  const endMs = startMs + 86_400_000;
  return { startMs, endMs };
}

function perModelMap(composites: SessionComposite[]): Map<string, PerModelStats> {
  const map = new Map<string, PerModelStats>();
  for (const c of composites) {
    if (c.excluded_reason === 'exploring') continue;
    if (!c.scorable) continue;
    const cur = map.get(c.model_id) ?? { tokens: 0, outcomes: 0, sessions: 0 };
    cur.tokens += c.tokens;
    cur.outcomes += c.composite_outcomes;
    cur.sessions += 1;
    map.set(c.model_id, cur);
  }
  return map;
}

function buildProvenance(
  cal: ReturnType<typeof ensureCalibration>,
  rollup: CompositeRollup,
  v2: YptV2Result,
): object {
  return {
    version: CURRENT_VERSION,
    formula: '100 × Φ((ln yield_rate − ln μ) / σ)',
    calibration: {
      mu: cal.mu,
      sigma: cal.sigma,
      n_prior: cal.n_prior,
      anchor: cal.anchor,
      source: cal.source,
    },
    inputs: {
      tokens: rollup.tokens,
      composite_outcomes: Number(rollup.composite_outcomes.toFixed(3)),
      yield_rate: v2.yield_rate,
      attribution_breakdown: rollup.attribution_breakdown,
      self_tag_breakdown: rollup.self_tag_breakdown,
      survival_weight_applied: rollup.survival_weight_applied,
      scorable_sessions: rollup.scorable_sessions,
      unscorable_sessions: rollup.unscorable_sessions,
      excluded_sessions: rollup.excluded_sessions,
    },
    by_model: v2.by_model,
    academic_source:
      'Log-normal CDF over composite outcomes (Lighthouse pattern). Composite: attribution-tier weight × survival weight × self-tag overlay. v0 literature prior; expect change.',
    citations: [
      'arxiv:2511.05722 (OckBench — what V0.1.1 was; replaced)',
      "arxiv:2510.09738 (Judge's Verdict — Phase 3, deferred)",
      'GitClear AI Code Quality 2025 (rework rate)',
      'DORA 2025 (Rework Rate as 5th metric)',
      'Limpert 2001 BioScience 51:341 (log-normal in multiplicative processes)',
    ],
    notes:
      "V0.3 ships v0 calibration. As empirical data accumulates Bayesian shrinkage will move (μ, σ) toward the user's realized distribution. Days with only unscorable sessions report score=null.",
  };
}

export function computeSnapshotsSince(
  db: DatabaseSync,
  sinceMs: number,
): number {
  const cal = ensureCalibration(db);
  const pairs = getDistinctProjectDates(db, sinceMs);
  let written = 0;

  for (const { date, project_hash } of pairs) {
    const { startMs, endMs } = dayBoundsUtc(date);
    const agg = aggregateDay(db, date, project_hash);
    const totalTokens = agg.total_tokens_in + agg.total_tokens_out;

    const { composites, attrMap } = gatherComposites(
      db,
      startMs,
      endMs,
      project_hash,
    );
    const rollup = rollupComposite(composites, attrMap);

    const byModelMap = perModelMap(composites);
    const v2 = yptScoreV2(
      {
        tokens: rollup.tokens,
        composite_outcomes: rollup.composite_outcomes,
        scorable_sessions: rollup.scorable_sessions,
        unscorable_sessions: rollup.unscorable_sessions,
        by_model_sessions: byModelMap,
      },
      cal,
    );

    const snap: Snapshot = {
      date,
      project_hash,
      total_tokens_in: agg.total_tokens_in,
      total_tokens_out: agg.total_tokens_out,
      total_cost_usd: agg.total_cost_usd,
      session_count: agg.session_count,
      commit_count: agg.commit_count,
      attributed_commit_count: agg.attributed_commit_count,
      direct_attribution_count: agg.direct_attribution_count,
      inferred_attribution_count: agg.inferred_attribution_count,
      ypt_score: v2.score,
      cost_per_ship_tokens:
        agg.attributed_commit_count > 0
          ? totalTokens / agg.attributed_commit_count
          : null,
      cost_per_ship_usd:
        agg.attributed_commit_count > 0
          ? agg.total_cost_usd / agg.attributed_commit_count
          : null,
      provenance: buildProvenance(cal, rollup, v2),
      computed_at: Date.now(),
    };
    upsertSnapshot(db, snap);
    written++;
  }
  return written;
}
