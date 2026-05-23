import { DatabaseSync } from 'node:sqlite';
import {
  aggregateDay,
  getDistinctProjectDates,
  upsertSnapshot,
} from '../storage/db';
import type { Snapshot } from '../storage/types';

export interface YptInputs {
  direct_attribution_count: number;
  inferred_attribution_count: number;
  total_tokens: number;
}

export interface YptResult {
  score: number;
  provenance: {
    formula: string;
    inputs: YptInputs & {
      outcome_signals: number;
      token_penalty: number;
    };
    academic_source: string;
    version: string;
    notes: string;
  };
}

const DIRECT_WEIGHT = 10;
const INFERRED_WEIGHT = 5;
const PENALTY_COEF = 5;
const TOKEN_DIVISOR = 100_000;

export function yptScore(i: YptInputs): YptResult {
  const outcome_signals =
    DIRECT_WEIGHT * i.direct_attribution_count +
    INFERRED_WEIGHT * i.inferred_attribution_count;
  const tokens = Math.max(i.total_tokens, 1);
  const token_penalty = PENALTY_COEF * Math.log10(tokens / TOKEN_DIVISOR);
  const score = Number((outcome_signals - token_penalty).toFixed(2));

  return {
    score,
    provenance: {
      formula: `YPT = (${DIRECT_WEIGHT}·direct + ${INFERRED_WEIGHT}·inferred) - ${PENALTY_COEF} · log₁₀(tokens / ${TOKEN_DIVISOR.toLocaleString()})`,
      inputs: { ...i, outcome_signals, token_penalty },
      academic_source:
        'Adapted from OckBench (arxiv 2511.05722); divisor and coefficients calibrated for developer-daily token volumes',
      version: 'v0.1.1',
      notes:
        'V0.1.1: outcomes = attributed commits only. Calibrated so a typical productive day hits 10-50, a wasted day goes negative. V0.2 will add code survival and self-tags.',
    },
  };
}

export function computeSnapshotsSince(
  db: DatabaseSync,
  sinceMs: number,
): number {
  const pairs = getDistinctProjectDates(db, sinceMs);
  let written = 0;
  for (const { date, project_hash } of pairs) {
    const agg = aggregateDay(db, date, project_hash);
    const totalTokens = agg.total_tokens_in + agg.total_tokens_out;
    const ypt = yptScore({
      direct_attribution_count: agg.direct_attribution_count,
      inferred_attribution_count: agg.inferred_attribution_count,
      total_tokens: totalTokens,
    });

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
      ypt_score: ypt.score,
      cost_per_ship_tokens:
        agg.attributed_commit_count > 0
          ? totalTokens / agg.attributed_commit_count
          : null,
      cost_per_ship_usd:
        agg.attributed_commit_count > 0
          ? agg.total_cost_usd / agg.attributed_commit_count
          : null,
      provenance: ypt.provenance,
      computed_at: Date.now(),
    };
    upsertSnapshot(db, snap);
    written++;
  }
  return written;
}
