import { DatabaseSync } from 'node:sqlite';
import {
  getSnapshotsSince,
  getTopExpensiveSessions,
  getRateLimitHitsSince,
} from '../storage/db';
import { bold, dim, green, red, cyan, yellow } from './ansi';
import {
  readConfig,
  planDisplayName,
  isSubscriptionPlan,
  isApiPlan,
} from '../config/plan';
import { computeTierFlex, TierFlexResult } from '../compute/tier_flex';
import type {
  Snapshot,
  TopSession,
  RateLimitHit,
  MileageConfig,
} from '../storage/types';

const TOP_SESSIONS_N = 5;

function isoDateUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface WindowAgg {
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  session_count: number;
  commit_count: number;
  attributed_commit_count: number;
  direct_attribution_count: number;
  inferred_attribution_count: number;
  weighted_ypt: number;
  ypt_weight: number;
}

function emptyAgg(): WindowAgg {
  return {
    total_tokens_in: 0,
    total_tokens_out: 0,
    total_cost_usd: 0,
    session_count: 0,
    commit_count: 0,
    attributed_commit_count: 0,
    direct_attribution_count: 0,
    inferred_attribution_count: 0,
    weighted_ypt: 0,
    ypt_weight: 0,
  };
}

function aggregate(snaps: Snapshot[]): WindowAgg {
  const a = emptyAgg();
  for (const s of snaps) {
    a.total_tokens_in += s.total_tokens_in;
    a.total_tokens_out += s.total_tokens_out;
    a.total_cost_usd += s.total_cost_usd;
    a.session_count += s.session_count;
    a.commit_count += s.commit_count;
    a.attributed_commit_count += s.attributed_commit_count;
    a.direct_attribution_count += s.direct_attribution_count;
    a.inferred_attribution_count += s.inferred_attribution_count;
    if (s.ypt_score !== null && s.session_count > 0) {
      a.weighted_ypt += s.ypt_score * s.session_count;
      a.ypt_weight += s.session_count;
    }
  }
  return a;
}

function avgYpt(a: WindowAgg): number | null {
  if (a.ypt_weight === 0) return null;
  return a.weighted_ypt / a.ypt_weight;
}

function fmtNum(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtUsd(n: number, decimals = 2): string {
  return (
    '$' +
    n.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

function fmtWeekdayTime(ms: number): string {
  const d = new Date(ms);
  const weekday = d.toLocaleDateString('en-US', { weekday: 'short' });
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${weekday} ${hours}:${mins}`;
}

function fmtDateRange(startMs: number, endMs: number): string {
  const start = new Date(startMs);
  const end = new Date(endMs);
  const m = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${m(start)} – ${m(end)}`;
}

function pctDelta(curr: number, prev: number, badIsHigher: boolean = true): string {
  if (prev <= 0) return curr > 0 ? green('new') : dim('—');
  const pct = ((curr - prev) / prev) * 100;
  const direction = pct > 0;
  const arrowColor = badIsHigher ? (direction ? red : green) : (direction ? green : red);
  const arrow = pct === 0 ? dim('=') : arrowColor(direction ? '▲' : '▼');
  const sign = pct > 0 ? '+' : '';
  return `${arrow} ${sign}${pct.toFixed(0)}% vs prior week`;
}

function commitsLine(s: TopSession): string {
  if (s.attr_count === 0) return dim('0 commits');
  if (s.attr_count === 1) return '1 commit';
  return `${s.attr_count} commits`;
}

function shortModel(modelId: string): string {
  return modelId.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

function renderRateLimitLine(hits: RateLimitHit[]): string {
  if (hits.length === 0) {
    return `  Rate-limit hits   ${green('0')} this week ${dim('✓')}`;
  }
  const examples = hits
    .slice(0, 3)
    .map((h) => fmtWeekdayTime(h.timestamp))
    .join(', ');
  const more = hits.length > 3 ? '...' : '';
  return `  Rate-limit hits   ${yellow('⚠ ' + hits.length)} this week  ${dim(`(${examples}${more})`)}`;
}

function renderTierFlexBlock(tier: TierFlexResult): string[] {
  const lines: string[] = [];
  if (tier.rows.length < 2 && !tier.warning) return lines;

  lines.push('');
  lines.push(dim('  Tier-flex audit (last 30 days):'));
  for (const r of tier.rows) {
    const label = shortModel(r.model_id).padEnd(22);
    const yieldPct = (r.yield_rate * 100).toFixed(0).padStart(3) + '%';
    const cost = ('$' + r.avg_cost.toFixed(2)).padStart(7);
    lines.push(
      `    ${label}  ${String(r.sessions).padStart(3)} sessions   yield ${yieldPct}   avg ${cost}/session`,
    );
  }
  if (tier.warning) {
    lines.push('');
    lines.push('  ' + yellow('⚠ ' + tier.warning.message));
  }
  return lines;
}

function renderProjectBreakdown(
  last7: Snapshot[],
  showDollars: boolean,
): string[] {
  const byProject = new Map<string, Snapshot[]>();
  for (const s of last7) {
    const arr = byProject.get(s.project_hash) ?? [];
    arr.push(s);
    byProject.set(s.project_hash, arr);
  }
  if (byProject.size <= 1) return [];

  const lines: string[] = [];
  lines.push('');
  lines.push(dim('  By project:'));
  const rows: { hash: string; cost: number; tokens: number; commits: number }[] = [];
  for (const [hash, snaps] of byProject) {
    const a = aggregate(snaps);
    rows.push({
      hash,
      cost: a.total_cost_usd,
      tokens: a.total_tokens_in + a.total_tokens_out,
      commits: a.attributed_commit_count,
    });
  }
  rows.sort((a, b) => b.cost - a.cost);
  for (const r of rows.slice(0, 5)) {
    const cps =
      r.commits > 0
        ? showDollars
          ? fmtUsd(r.cost / r.commits) + '/commit'
          : `${Math.round(r.tokens / r.commits / 1000)}K tok/commit`
        : dim('no commits');
    const headline = showDollars
      ? fmtUsd(r.cost).padStart(8)
      : `${fmtNum(r.tokens)} tok`.padStart(14);
    lines.push(`    ${dim(r.hash.slice(0, 10))}   ${headline}   ${cps}`);
  }
  return lines;
}

export function renderLast7Days(
  db: DatabaseSync,
  projectHash?: string,
): string {
  const cfg = readConfig();
  const now = Date.now();
  const last7Start = now - 7 * 86400_000;
  const prior7Start = now - 14 * 86400_000;

  const sinceDate = isoDateUTC(prior7Start);
  const all = getSnapshotsSince(db, sinceDate, projectHash);
  const last7 = all.filter((s) => s.date >= isoDateUTC(last7Start));
  const prior7 = all.filter(
    (s) => s.date < isoDateUTC(last7Start) && s.date >= isoDateUTC(prior7Start),
  );

  const curr = aggregate(last7);
  const prev = aggregate(prior7);
  const topSessions = getTopExpensiveSessions(
    db,
    last7Start,
    TOP_SESSIONS_N,
    projectHash,
  );
  const rateHits = getRateLimitHitsSince(db, last7Start);
  const tierFlex = computeTierFlex(db, now - 30 * 86400_000);

  if (isApiPlan(cfg.plan)) {
    return renderApiView(cfg, last7Start, now, curr, prev, topSessions, rateHits, tierFlex, last7);
  }
  if (isSubscriptionPlan(cfg.plan)) {
    return renderSubscriptionView(cfg, last7Start, now, curr, prev, topSessions, rateHits, tierFlex, last7);
  }
  return renderUnknownView(cfg, last7Start, now, curr, prev, topSessions, rateHits, tierFlex, last7);
}

function renderApiView(
  cfg: MileageConfig,
  last7Start: number,
  now: number,
  curr: WindowAgg,
  prev: WindowAgg,
  topSessions: TopSession[],
  rateHits: RateLimitHit[],
  tierFlex: TierFlexResult,
  last7: Snapshot[],
): string {
  const lines: string[] = [];
  const totalTokens = curr.total_tokens_in + curr.total_tokens_out;

  lines.push('');
  lines.push(
    bold('Mileage') +
      dim('  ·  this week  ·  ' + fmtDateRange(last7Start, now)),
  );
  lines.push(dim('  Plan: ' + planDisplayName(cfg.plan)));
  lines.push('');

  const spendStr = bold(fmtUsd(curr.total_cost_usd));
  const spendDelta =
    prev.total_cost_usd > 0
      ? '  ' +
        pctDelta(curr.total_cost_usd, prev.total_cost_usd) +
        dim(` (${fmtUsd(prev.total_cost_usd)})`)
      : '';
  lines.push(`  Spend             ${spendStr}${spendDelta}`);

  const outcomesStr =
    curr.attributed_commit_count === 0
      ? dim('— (no attributed commits this week)')
      : `${fmtNum(curr.attributed_commit_count)} commit${curr.attributed_commit_count === 1 ? '' : 's'} shipped`;
  const outcomesDelta =
    prev.attributed_commit_count > 0
      ? '  ' + dim(`(vs ${fmtNum(prev.attributed_commit_count)} prior week)`)
      : '';
  lines.push(`  Outcomes          ${outcomesStr}${outcomesDelta}`);

  const currCpsUsd =
    curr.attributed_commit_count > 0
      ? curr.total_cost_usd / curr.attributed_commit_count
      : null;
  if (currCpsUsd === null) {
    lines.push(`  Cost-per-Ship     ${dim('— (no attributed commits to divide by)')}`);
  } else {
    const cpsStr = bold(fmtUsd(currCpsUsd));
    lines.push(`  Cost-per-Ship     ${cpsStr} / commit`);
  }

  lines.push(renderRateLimitLine(rateHits));

  if (topSessions.length > 0) {
    lines.push('');
    lines.push(dim(`  Where it went (top ${topSessions.length} sessions this week):`));
    for (const s of topSessions) {
      const dollar = fmtUsd(s.cost_usd, s.cost_usd >= 10 ? 0 : 2).padStart(6);
      const when = fmtWeekdayTime(s.timestamp);
      const dur = fmtDuration(s.duration_ms);
      const cm = commitsLine(s);
      const model = shortModel(s.model_id);
      const waste =
        s.cost_usd >= cfg.preferences.waste_threshold_usd && s.attr_count === 0
          ? '  ' + yellow('⚠ waste session')
          : '';
      lines.push(`    ${dollar}  ${when} · ${model} · ${dim(dur)} · ${cm}${waste}`);
    }
  }

  lines.push(...renderTierFlexBlock(tierFlex));
  lines.push(...renderProjectBreakdown(last7, true));

  if (curr.session_count === 0 && curr.commit_count === 0) {
    lines.push('');
    lines.push(
      yellow(
        '  No data in this window. Run `mileage sync` from a git repo where you have used Claude Code recently.',
      ),
    );
  }

  const yptCurr = avgYpt(curr);
  if (yptCurr !== null) {
    lines.push('');
    lines.push(dim(`  YPT ${yptCurr.toFixed(1)} — see \`mileage explain ypt\``));
  }
  lines.push('');
  return lines.join('\n');
}

function renderSubscriptionView(
  cfg: MileageConfig,
  last7Start: number,
  now: number,
  curr: WindowAgg,
  prev: WindowAgg,
  topSessions: TopSession[],
  rateHits: RateLimitHit[],
  tierFlex: TierFlexResult,
  last7: Snapshot[],
): string {
  const lines: string[] = [];
  const totalTokens = curr.total_tokens_in + curr.total_tokens_out;
  const prevTokens = prev.total_tokens_in + prev.total_tokens_out;

  lines.push('');
  lines.push(
    bold('Mileage') +
      dim('  ·  this week  ·  ' + fmtDateRange(last7Start, now)),
  );
  lines.push(dim('  Plan: ' + planDisplayName(cfg.plan)));
  lines.push('');

  const tokenStr = bold(fmtNum(totalTokens));
  const tokenDelta =
    prevTokens > 0
      ? '  ' +
        pctDelta(totalTokens, prevTokens, false) +
        dim(` (${fmtNum(prevTokens)})`)
      : '';
  lines.push(`  Tokens used       ${tokenStr}${tokenDelta}`);

  const outcomesStr =
    curr.attributed_commit_count === 0
      ? dim('— (no attributed commits this week)')
      : `${fmtNum(curr.attributed_commit_count)} commit${curr.attributed_commit_count === 1 ? '' : 's'} shipped`;
  const outcomesDelta =
    prev.attributed_commit_count > 0
      ? '  ' + dim(`(vs ${fmtNum(prev.attributed_commit_count)} prior week)`)
      : '';
  lines.push(`  Outcomes          ${outcomesStr}${outcomesDelta}`);

  lines.push(renderRateLimitLine(rateHits));

  if (curr.total_cost_usd > 0) {
    lines.push(
      dim(
        `  Cost-equivalent   ${fmtUsd(curr.total_cost_usd)} (informational — your plan is flat-rate)`,
      ),
    );
  }

  if (topSessions.length > 0 && totalTokens > 0) {
    lines.push('');
    lines.push(dim(`  Top sessions this week (by usage):`));
    for (const s of topSessions) {
      const sessionTok =
        curr.total_tokens_in + curr.total_tokens_out > 0
          ? `${((s.cost_usd / curr.total_cost_usd) * 100).toFixed(0).padStart(2)}%`
          : '  -';
      const when = fmtWeekdayTime(s.timestamp);
      const dur = fmtDuration(s.duration_ms);
      const cm = commitsLine(s);
      const model = shortModel(s.model_id);
      const waste =
        s.attr_count === 0 && s.cost_usd >= cfg.preferences.waste_threshold_usd
          ? '  ' + yellow('⚠ waste')
          : '';
      lines.push(`    ${sessionTok}  ${when} · ${model} · ${dim(dur)} · ${cm}${waste}`);
    }
  }

  lines.push(...renderTierFlexBlock(tierFlex));
  lines.push(...renderProjectBreakdown(last7, false));

  if (curr.session_count === 0 && curr.commit_count === 0) {
    lines.push('');
    lines.push(
      yellow(
        '  No data in this window. Run `mileage sync` from a git repo where you have used Claude Code recently.',
      ),
    );
  }

  lines.push('');
  lines.push(dim('  For live cap %, run `/usage` in Claude Code.'));

  const yptCurr = avgYpt(curr);
  if (yptCurr !== null) {
    lines.push(dim(`  YPT ${yptCurr.toFixed(1)} — see \`mileage explain ypt\``));
  }
  lines.push('');
  return lines.join('\n');
}

function renderUnknownView(
  cfg: MileageConfig,
  last7Start: number,
  now: number,
  curr: WindowAgg,
  prev: WindowAgg,
  topSessions: TopSession[],
  rateHits: RateLimitHit[],
  tierFlex: TierFlexResult,
  last7: Snapshot[],
): string {
  const apiOut = renderApiView(cfg, last7Start, now, curr, prev, topSessions, rateHits, tierFlex, last7);
  const banner =
    '\n' +
    yellow(
      '  ⚙ Declare your plan for better-tailored output: `mileage config:set-plan <plan>` (api | pro | max-100 | max-200 | cursor-pro | copilot)',
    ) +
    '\n';
  return banner + apiOut;
}

export function renderExplain(db: DatabaseSync, metric: string): string {
  if (metric !== 'ypt') {
    return `Unknown metric: ${metric}. Known: ypt`;
  }
  const rows = getSnapshotsSince(db, '0000-01-01');
  if (rows.length === 0) {
    return 'No snapshots yet. Run `mileage sync` first.';
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = rows[0];
  const prov: any = latest.provenance ?? {};

  const lines: string[] = [];
  lines.push('');
  lines.push(bold('YPT') + dim(' — Yield Per Token (' + (prov.version || 'v?') + ')'));
  lines.push('');
  lines.push('  Formula:');
  lines.push('    ' + (prov.formula ?? 'unknown'));
  lines.push('');
  lines.push(
    '  Most recent snapshot (' +
      latest.date +
      ', project ' +
      latest.project_hash.slice(0, 8) +
      '):',
  );
  const i = prov.inputs ?? {};
  lines.push(`    Direct-attributed commits:   ${fmtNum(i.direct_attribution_count ?? 0)}`);
  lines.push(`    Inferred-attributed commits: ${fmtNum(i.inferred_attribution_count ?? 0)}`);
  lines.push(`    → outcome_signals:           ${(i.outcome_signals ?? 0).toFixed(2)}`);
  lines.push(`    → total_tokens:              ${fmtNum(i.total_tokens ?? 0)}`);
  lines.push(`    → token_penalty:             ${(i.token_penalty ?? 0).toFixed(2)}`);
  const score = latest.ypt_score === null ? '—' : latest.ypt_score.toFixed(2);
  lines.push(`    → YPT score:                 ${bold(score)}`);
  lines.push('');
  lines.push('  Source: ' + (prov.academic_source ?? 'n/a'));
  if (prov.notes) {
    lines.push('');
    lines.push(dim('  ' + prov.notes));
  }
  lines.push('');
  lines.push(
    dim(
      '  Note: YPT v0.1.1 uses a log-penalty formula that produces negative numbers for normal use. V0.3 will replace it with a log-normal CDF approach. For now, focus on Cost-per-Ship (API users) or token-usage (subscription users) in `mileage show`.',
    ),
  );
  lines.push('');
  return lines.join('\n');
}
