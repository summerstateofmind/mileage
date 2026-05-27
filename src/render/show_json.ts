import { DatabaseSync } from 'node:sqlite';
import {
  getSnapshotsSince,
  getTopExpensiveSessions,
  getRateLimitHitsSince,
  getProjectNameMap,
} from '../storage/db';
import { clusterRateLimitHits } from '../ingest/rate_limits';
import { readConfig } from '../config/plan';
import { computeTierFlex } from '../compute/tier_flex';
import { detectPatterns } from '../compute/patterns';
import { getSurvivalSummariesSince } from '../compute/survival';
import { computeUsageCheck } from '../compute/usage';
import type { Snapshot } from '../storage/types';

function isoDateUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function aggregate(snaps: Snapshot[]) {
  let tokens_in = 0,
    tokens_out = 0,
    cost = 0,
    sessions = 0,
    commits = 0,
    attributed = 0,
    weightedYpt = 0,
    yptWeight = 0;
  for (const s of snaps) {
    tokens_in += s.total_tokens_in;
    tokens_out += s.total_tokens_out;
    cost += s.total_cost_usd;
    sessions += s.session_count;
    commits += s.commit_count;
    attributed += s.attributed_commit_count;
    if (s.ypt_score !== null && s.session_count > 0) {
      weightedYpt += s.ypt_score * s.session_count;
      yptWeight += s.session_count;
    }
  }
  return {
    tokens_in,
    tokens_out,
    total_tokens: tokens_in + tokens_out,
    cost_usd: cost,
    session_count: sessions,
    commit_count: commits,
    attributed_commit_count: attributed,
    ypt_score: yptWeight === 0 ? null : weightedYpt / yptWeight,
  };
}

function startOfCalendarWeek(timestamp: number): number {
  const d = new Date(timestamp);
  const day = d.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - daysFromMonday);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function buildShowJson(
  db: DatabaseSync,
  projectHash?: string,
  windowDays: number = 7,
  calendarWeek: boolean = false,
): object {
  const cfg = readConfig();
  const now = Date.now();
  let currStart: number;
  let priorStart: number;
  if (calendarWeek) {
    currStart = startOfCalendarWeek(now);
    priorStart = currStart - 7 * 86400_000;
  } else {
    const windowMs = windowDays * 86400_000;
    currStart = now - windowMs;
    priorStart = now - 2 * windowMs;
  }
  const sinceDate = isoDateUTC(priorStart);
  const all = getSnapshotsSince(db, sinceDate, projectHash);
  const curr = all.filter((s) => s.date >= isoDateUTC(currStart));
  const prior = all.filter(
    (s) => s.date < isoDateUTC(currStart) && s.date >= isoDateUTC(priorStart),
  );
  const currAgg = aggregate(curr);
  const priorAgg = aggregate(prior);
  const topSessions = getTopExpensiveSessions(db, currStart, 5, projectHash);
  const rateHits = clusterRateLimitHits(getRateLimitHitsSince(db, currStart));
  const tierFlex = computeTierFlex(db, now - 30 * 86400_000);
  const patterns = detectPatterns(db, now - 30 * 86400_000);
  const survival = getSurvivalSummariesSince(db, currStart, projectHash);
  const nameMap = getProjectNameMap(db);
  const usage = computeUsageCheck(db, cfg.plan);

  return {
    schema_version: 1,
    generated_at: new Date(now).toISOString(),
    window: {
      start: new Date(currStart).toISOString(),
      end: new Date(now).toISOString(),
      mode: calendarWeek ? 'calendar-week' : 'rolling-days',
      days: calendarWeek ? null : windowDays,
    },
    plan: cfg.plan,
    scope: {
      project_hash: projectHash ?? null,
      project_name: projectHash ? (nameMap.get(projectHash) ?? null) : null,
    },
    current: {
      ...currAgg,
      cost_per_ship_usd:
        currAgg.attributed_commit_count > 0
          ? currAgg.cost_usd / currAgg.attributed_commit_count
          : null,
    },
    prior: {
      ...priorAgg,
      cost_per_ship_usd:
        priorAgg.attributed_commit_count > 0
          ? priorAgg.cost_usd / priorAgg.attributed_commit_count
          : null,
    },
    top_sessions: topSessions.map((s) => ({
      session_id: s.session_id,
      timestamp: new Date(s.timestamp).toISOString(),
      cost_usd: s.cost_usd,
      duration_ms: s.duration_ms,
      attr_count: s.attr_count,
      model_id: s.model_id,
      waste:
        s.attr_count === 0 && s.cost_usd >= cfg.preferences.waste_threshold_usd,
    })),
    rate_limit_hits: rateHits.length,
    tier_flex: {
      rows: tierFlex.rows,
      warning: tierFlex.warning ?? null,
    },
    patterns: patterns.map((p) => ({
      headline: p.headline,
      detail: p.detail ?? null,
      severity: p.severity,
    })),
    survival: {
      windows: survival.windows.map((w) => ({
        window_days: w.window_days,
        rate: w.summary.rate,
        commits_evaluated: w.summary.commits_evaluated,
      })),
    },
    usage,
  };
}
