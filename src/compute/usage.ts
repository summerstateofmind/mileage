import { DatabaseSync } from 'node:sqlite';
import type { Plan } from '../storage/types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Community-approximated 5-hour cap estimates (Anthropic does not publish exact
 * numbers and they shift). Used only as a coarse warning signal. For live exact
 * cap use, run `/usage` inside Claude Code.
 */
export const PLAN_5H_CAP_ESTIMATE_TOKENS: Record<Plan, number | null> = {
  api: null,
  pro: 5_000_000,
  'max-100': 25_000_000,
  'max-200': 100_000_000,
  'cursor-pro': null,
  copilot: null,
  unknown: null,
};

export const PLAN_7D_CAP_ESTIMATE_TOKENS: Record<Plan, number | null> = {
  api: null,
  pro: 150_000_000,
  'max-100': 1_000_000_000,
  'max-200': 4_000_000_000,
  'cursor-pro': null,
  copilot: null,
  unknown: null,
};

export type WarningLevel = 'ok' | 'soft' | 'strong' | 'over';

export interface WindowUsage {
  window_label: '5h' | '7d';
  tokens_used: number;
  cap_estimate: number | null;
  percent_used: number | null;
  warning_level: WarningLevel;
  ms_until_reset: number | null;
}

export interface UsageCheckResult {
  plan: Plan;
  five_hour: WindowUsage;
  seven_day: WindowUsage;
  baseline: {
    typical_heavy_day_tokens: number | null;
    heavy_day_p90_window_days: number;
    today_tokens: number;
  };
  recommended_action: string;
  caveat: string;
}

function sumTokensSince(db: DatabaseSync, sinceMs: number): number {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(tokens_in), 0) + COALESCE(SUM(tokens_out), 0) AS total
       FROM events
       WHERE type = 'session'
         AND timestamp >= ?`,
    )
    .get(sinceMs) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

function earliestSessionAfter(db: DatabaseSync, sinceMs: number): number | null {
  const row = db
    .prepare(
      `SELECT MIN(timestamp) AS first_ts
       FROM events
       WHERE type = 'session'
         AND timestamp >= ?`,
    )
    .get(sinceMs) as { first_ts: number | null } | undefined;
  return row?.first_ts ?? null;
}

function dailyTokenP90(db: DatabaseSync, windowDays: number = 30): number | null {
  const sinceMs = Date.now() - windowDays * 86_400_000;
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') AS day,
         SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS total
       FROM events
       WHERE type = 'session'
         AND timestamp >= ?
       GROUP BY day
       HAVING total > 0
       ORDER BY total`,
    )
    .all(sinceMs) as { day: string; total: number }[];
  if (rows.length === 0) return null;
  const idx = Math.max(0, Math.min(rows.length - 1, Math.floor(rows.length * 0.9)));
  return Number(rows[idx].total);
}

function todayTokens(db: DatabaseSync): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return sumTokensSince(db, start.getTime());
}

function classifyLevel(pct: number | null): WarningLevel {
  if (pct === null) return 'ok';
  if (pct >= 100) return 'over';
  if (pct >= 75) return 'strong';
  if (pct >= 50) return 'soft';
  return 'ok';
}

function buildRecommendedAction(
  fiveHour: WindowUsage,
  sevenDay: WindowUsage,
): string {
  const peak: WindowUsage =
    (fiveHour.percent_used ?? 0) >= (sevenDay.percent_used ?? 0)
      ? fiveHour
      : sevenDay;
  switch (peak.warning_level) {
    case 'over':
      return `Past the estimated ${peak.window_label} cap. New requests likely to fail or queue. Stop the heavy work; resume after the window resets.`;
    case 'strong':
      return `${(peak.percent_used ?? 0).toFixed(0)}% of estimated ${peak.window_label} cap. Switch to Sonnet, batch remaining requests, or pause for a few hours.`;
    case 'soft':
      return `${(peak.percent_used ?? 0).toFixed(0)}% of estimated ${peak.window_label} cap. Consider Sonnet for the next session if it's a tractable task.`;
    case 'ok':
    default:
      return 'Plenty of room. No action needed.';
  }
}

export function computeUsageCheck(db: DatabaseSync, plan: Plan): UsageCheckResult {
  const now = Date.now();
  const fiveHourStart = now - FIVE_HOURS_MS;
  const sevenDayStart = now - SEVEN_DAYS_MS;

  const fiveHourTokens = sumTokensSince(db, fiveHourStart);
  const sevenDayTokens = sumTokensSince(db, sevenDayStart);

  const fiveHourCap = PLAN_5H_CAP_ESTIMATE_TOKENS[plan];
  const sevenDayCap = PLAN_7D_CAP_ESTIMATE_TOKENS[plan];

  const fiveHourPct =
    fiveHourCap && fiveHourCap > 0 ? (fiveHourTokens / fiveHourCap) * 100 : null;
  const sevenDayPct =
    sevenDayCap && sevenDayCap > 0 ? (sevenDayTokens / sevenDayCap) * 100 : null;

  const fiveHourFirst = earliestSessionAfter(db, fiveHourStart);
  const fiveHourReset =
    fiveHourFirst !== null
      ? Math.max(0, fiveHourFirst + FIVE_HOURS_MS - now)
      : null;
  const sevenDayFirst = earliestSessionAfter(db, sevenDayStart);
  const sevenDayReset =
    sevenDayFirst !== null
      ? Math.max(0, sevenDayFirst + SEVEN_DAYS_MS - now)
      : null;

  const fiveHour: WindowUsage = {
    window_label: '5h',
    tokens_used: fiveHourTokens,
    cap_estimate: fiveHourCap,
    percent_used: fiveHourPct,
    warning_level: classifyLevel(fiveHourPct),
    ms_until_reset: fiveHourReset,
  };
  const sevenDay: WindowUsage = {
    window_label: '7d',
    tokens_used: sevenDayTokens,
    cap_estimate: sevenDayCap,
    percent_used: sevenDayPct,
    warning_level: classifyLevel(sevenDayPct),
    ms_until_reset: sevenDayReset,
  };

  return {
    plan,
    five_hour: fiveHour,
    seven_day: sevenDay,
    baseline: {
      typical_heavy_day_tokens: dailyTokenP90(db, 30),
      heavy_day_p90_window_days: 30,
      today_tokens: todayTokens(db),
    },
    recommended_action: buildRecommendedAction(fiveHour, sevenDay),
    caveat:
      'Cap estimates are community-approximated; Anthropic does not publish exact numbers. For live exact cap usage, run `/usage` inside Claude Code.',
  };
}

export function fmtMsDuration(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h${m > 0 ? m + 'm' : ''}`;
}
