import { DatabaseSync } from 'node:sqlite';
import {
  getSnapshotsSince,
  getTopExpensiveSessions,
  getRateLimitHitsSince,
} from '../storage/db';
import { computeTierFlex } from '../compute/tier_flex';
import { detectPatterns } from '../compute/patterns';
import { getSurvivalSummarySince } from '../compute/survival';
import { readConfig, planDisplayName, isApiPlan } from '../config/plan';
import type { Snapshot } from '../storage/types';

const MS_PER_DAY = 86_400_000;

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtUsd(n: number, decimals = 2): string {
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}m`;
}

function fmtWeekdayTime(ms: number): string {
  const d = new Date(ms);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${weekday} ${hh}:${mm}`;
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

function aggregateCost(snaps: Snapshot[]): number {
  return snaps.reduce((a, s) => a + s.total_cost_usd, 0);
}

function aggregateTokens(snaps: Snapshot[]): number {
  return snaps.reduce((a, s) => a + s.total_tokens_in + s.total_tokens_out, 0);
}

function aggregateCommits(snaps: Snapshot[]): number {
  return snaps.reduce((a, s) => a + s.attributed_commit_count, 0);
}

export function renderWeeklyReport(db: DatabaseSync, days: number = 7): string {
  const now = Date.now();
  const start = now - days * MS_PER_DAY;
  const priorStart = now - 2 * days * MS_PER_DAY;
  const cfg = readConfig();

  const all = getSnapshotsSince(db, isoDate(priorStart));
  const curr = all.filter((s) => s.date >= isoDate(start));
  const prev = all.filter((s) => s.date < isoDate(start) && s.date >= isoDate(priorStart));

  const currCost = aggregateCost(curr);
  const prevCost = aggregateCost(prev);
  const currTokens = aggregateTokens(curr);
  const prevTokens = aggregateTokens(prev);
  const currCommits = aggregateCommits(curr);
  const prevCommits = aggregateCommits(prev);

  const top = getTopExpensiveSessions(db, start, 5);
  const rateHits = getRateLimitHitsSince(db, start);
  const tierFlex = computeTierFlex(db, now - 30 * MS_PER_DAY);
  const patterns = detectPatterns(db, now - 30 * MS_PER_DAY);
  const survival = getSurvivalSummarySince(db, start);

  const modelTotals = new Map<string, number>();
  for (const s of curr) {
    // V0.2: we don't store per-model totals at snapshot level; use top sessions heuristic
  }
  for (const t of top) {
    const key = shortModel(t.model_id);
    modelTotals.set(key, (modelTotals.get(key) ?? 0) + t.cost_usd);
  }

  const lines: string[] = [];
  const startStr = new Date(start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr = new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  lines.push(`# My Mileage Week — ${startStr} – ${endStr}`);
  lines.push('');
  lines.push(`**Plan:** ${planDisplayName(cfg.plan)}`);
  lines.push('');

  if (isApiPlan(cfg.plan)) {
    lines.push(`**Spend:** ${fmtUsd(currCost)}` + (prevCost > 0 ? ` (vs ${fmtUsd(prevCost)} prior week)` : ''));
    if (currCommits > 0) {
      lines.push(`**Cost-per-Ship:** ${fmtUsd(currCost / currCommits)}` + (prevCommits > 0 && prevCost > 0 ? ` (vs ${fmtUsd(prevCost / prevCommits)} prior week)` : ''));
    }
  } else {
    lines.push(`**Tokens used:** ${fmtNum(currTokens)}` + (prevTokens > 0 ? ` (vs ${fmtNum(prevTokens)} prior week)` : ''));
    lines.push(`**Cost-equivalent:** ${fmtUsd(currCost)} (informational — flat-rate plan)`);
  }
  lines.push(`**Outcomes shipped:** ${currCommits} commit${currCommits === 1 ? '' : 's'}` + (prevCommits > 0 ? ` (vs ${prevCommits} prior week)` : ''));
  lines.push(`**Rate-limit hits:** ${rateHits.length === 0 ? '0 ✓' : `⚠ ${rateHits.length}`}`);

  if (survival.commits_evaluated > 0 && survival.rate !== null) {
    lines.push(`**Code survival (7d):** ${(survival.rate * 100).toFixed(0)}% of AI-attributed lines still alive at 7 days  *(over ${survival.commits_evaluated} eligible commits)*`);
  }

  lines.push('');

  if (top.length > 0) {
    lines.push('## Top sessions this week');
    lines.push('');
    for (const s of top) {
      const cm = s.attr_count === 0 ? '0 commits' : `${s.attr_count} commit${s.attr_count === 1 ? '' : 's'}`;
      const waste = s.attr_count === 0 && s.cost_usd >= cfg.preferences.waste_threshold_usd ? ' ⚠ waste' : '';
      lines.push(`- ${fmtUsd(s.cost_usd)} · ${fmtWeekdayTime(s.timestamp)} · ${shortModel(s.model_id)} · ${fmtDuration(s.duration_ms)} · ${cm}${waste}`);
    }
    lines.push('');
  }

  if (tierFlex.warning) {
    lines.push('## Tier-flex audit');
    lines.push('');
    lines.push(`⚠ ${tierFlex.warning.message}`);
    lines.push('');
  }

  if (patterns.length > 0) {
    lines.push('## Patterns I noticed');
    lines.push('');
    for (const p of patterns.slice(0, 3)) {
      lines.push(`- **${p.headline}** ${p.detail}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('[mileage 0.2 · github.com/summerstateofmind/mileage]');
  return lines.join('\n');
}
