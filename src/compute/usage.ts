import { DatabaseSync } from 'node:sqlite';
import { getRateLimitHitsSince } from '../storage/db';
import { clusterRateLimitHits } from '../ingest/rate_limits';
import type { Plan } from '../storage/types';

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Deliberately NO cap-% estimate. Anthropic's real limit accounting is unpublished
// and cache-weighted, so any % Mileage showed would contradict `/usage` — and a low
// estimated % is actively dangerous (it once read "5% — plenty of room" while the
// account was at 97% per /usage). We surface only honest local signals: token volume,
// heavy-day baseline, and ground-truth rate-limit hits. Cap % and reset time → /usage.

export interface WindowUsage {
  window_label: '5h' | '7d';
  tokens_used: number;
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
  recent_rate_limit_hits: number;
  guidance: string;
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

export function computeUsageCheck(db: DatabaseSync, plan: Plan): UsageCheckResult {
  const now = Date.now();
  const fiveHourStart = now - FIVE_HOURS_MS;
  const sevenDayStart = now - SEVEN_DAYS_MS;

  const recentHits = clusterRateLimitHits(
    getRateLimitHitsSince(db, sevenDayStart),
  ).length;

  return {
    plan,
    five_hour: {
      window_label: '5h',
      tokens_used: sumTokensSince(db, fiveHourStart),
    },
    seven_day: {
      window_label: '7d',
      tokens_used: sumTokensSince(db, sevenDayStart),
    },
    baseline: {
      typical_heavy_day_tokens: dailyTokenP90(db, 30),
      heavy_day_p90_window_days: 30,
      today_tokens: todayTokens(db),
    },
    recent_rate_limit_hits: recentHits,
    guidance:
      'Mileage tracks token volume and rate-limit hits, not Anthropic\'s cap %. For exact live cap usage and reset time, run `/usage` inside Claude Code.',
    caveat:
      'Mileage does NOT estimate cap %. Anthropic\'s limits are unpublished and cache-weighted, so any % would be wrong. A non-zero rate_limit_hits count is the ground-truth "you hit the wall" signal; `/usage` is the authority on remaining headroom and reset time.',
  };
}
