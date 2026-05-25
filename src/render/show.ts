import { DatabaseSync } from 'node:sqlite';
import {
  getSnapshotsSince,
  getTopExpensiveSessions,
  getRateLimitHitsSince,
  getProjectNameMap,
} from '../storage/db';
import {
  bold,
  dim,
  green,
  red,
  cyan,
  yellow,
  magenta,
  brightCyan,
} from './ansi';
import {
  readConfig,
  planDisplayName,
  isSubscriptionPlan,
  isApiPlan,
} from '../config/plan';
import { computeTierFlex, TierFlexResult } from '../compute/tier_flex';
import { detectPatterns, PatternFinding } from '../compute/patterns';
import { computeUsageCheck, type UsageCheckResult } from '../compute/usage';
import { bucketWindow, type EffTally } from '../compute/effectiveness';
import {
  getSurvivalSummariesSince,
  MultiWindowSurvival,
} from '../compute/survival';
import { sparkline } from './charts';
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
  return `${arrow} ${sign}${pct.toFixed(0)}% vs prior period`;
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

function renderPatternsBlock(patterns: PatternFinding[]): string[] {
  if (patterns.length === 0) return [];
  const lines: string[] = [];
  lines.push('');
  lines.push(cyan('  Patterns I noticed') + dim(' (last 30 days)'));
  for (const p of patterns.slice(0, 2)) {
    lines.push('  ' + yellow('→ ') + p.headline);
    if (p.detail) lines.push('    ' + dim(p.detail));
  }
  return lines;
}

function renderSurvivalBlock(m: MultiWindowSurvival): string[] {
  const withData = m.windows.filter(
    (w) => w.summary.commits_evaluated > 0 && w.summary.rate !== null,
  );
  if (withData.length === 0) return [];

  const segments = withData.map((w) => {
    const rate = w.summary.rate as number;
    const pct = (rate * 100).toFixed(0);
    const color = rate >= 0.9 ? green : rate >= 0.7 ? yellow : red;
    return `${color(pct + '%')} alive at ${w.window_days}d`;
  });
  const counts = withData
    .map((w) => `${w.summary.commits_evaluated} @ ${w.window_days}d`)
    .join(', ');
  return [
    '',
    `  Code health       ${segments.join('  ·  ')}   ${dim('(' + counts + ' commit evaluations)')}`,
  ];
}

function yptScoreColor(ypt: number): (s: string) => string {
  if (ypt >= 70) return green;
  if (ypt >= 40) return yellow;
  return red;
}

function renderYptFooter(
  ypt: number | null,
  hasSessions: boolean,
  scope: string | undefined,
): string {
  if (ypt === null) {
    if (!hasSessions) return '';
    const hint = scope
      ? `  ${dim('Try')} ${cyan('mileage --all')} ${dim('for a cross-project score.')}`
      : `  ${dim('Tag a session with')} ${cyan('mileage tag')} ${dim('to make this window scorable.')}`;
    return (
      '  ' +
      magenta(bold('YPT')) +
      '  ' +
      yellow('not scored') +
      dim(' · no attributed commits or self-tags in this window.') +
      '\n' +
      hint
    );
  }
  const color = yptScoreColor(ypt);
  return (
    '  ' +
    magenta(bold('YPT')) +
    '  ' +
    color(bold(ypt.toFixed(1))) +
    dim(' / 100') +
    '   ' +
    dim('(`mileage explain ypt` for the breakdown)')
  );
}

export function fillBar(pct: number | null): string {
  if (pct === null) return '—';
  const filled = Math.max(0, Math.min(8, Math.round((pct / 100) * 8)));
  return '▓'.repeat(filled) + '░'.repeat(8 - filled);
}

function capBar(w: { percent_used: number | null; warning_level: string }): string {
  const bar = fillBar(w.percent_used);
  if (w.percent_used === null) return dim(bar);
  const color =
    w.warning_level === 'over' || w.warning_level === 'strong'
      ? red
      : w.warning_level === 'soft'
        ? yellow
        : green;
  return color(`${bar} ${w.percent_used.toFixed(0)}%`);
}

function renderHeadroomLine(usage: UsageCheckResult): string {
  const clear =
    usage.five_hour.warning_level === 'ok' && usage.seven_day.warning_level === 'ok';
  const glyph = clear ? dim('✓') : yellow('⚠');
  return `  Cap   5h ${capBar(usage.five_hour)}   7d ${capBar(usage.seven_day)}   ${glyph}`;
}

function survival7dRate(m: MultiWindowSurvival): number | null {
  const w = m.windows.find((x) => x.window_days === 7);
  if (!w || w.summary.commits_evaluated === 0 || w.summary.rate === null) return null;
  return w.summary.rate;
}

function renderShipLine(tally: EffTally, survival7d: number | null): string[] {
  const buckets =
    green(`${tally.shipped} shipped`) +
    dim(' · ') +
    cyan(`${tally.likely} likely`) +
    dim(' · ') +
    dim(`${tally.research} research`);
  const sub =
    survival7d !== null
      ? `        ${tally.total} sessions · ${(survival7d * 100).toFixed(0)}% alive @7d`
      : `        ${tally.total} sessions`;
  return [`  Ship  ${buckets}`, dim(sub)];
}

function renderHeaderBar(
  weekLabel: string,
  planLabel: string,
  scope: string,
): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(
    brightCyan(bold('Mileage')) +
      '  ' +
      dim('·') +
      '  ' +
      cyan(weekLabel),
  );
  const meta: string[] = [];
  meta.push(dim('Plan:') + ' ' + planLabel);
  meta.push(dim('Scope:') + ' ' + scope);
  lines.push('  ' + meta.join('   '));
  lines.push('');
  return lines;
}

function scopeLabel(
  projectFilter: string | undefined,
  nameMap: Map<string, string>,
): string {
  if (!projectFilter) return cyan('all projects');
  const name = nameMap.get(projectFilter);
  return name ? cyan(name) : cyan(projectFilter.slice(0, 10));
}

function windowLabel(days: number, calendarWeek: boolean): string {
  if (calendarWeek) return 'This week';
  if (days === 1) return 'Today';
  if (days === 7) return 'Last 7 days';
  if (days === 30) return 'Last 30 days';
  return `Last ${days} days`;
}

function startOfCalendarWeek(timestamp: number): number {
  // Monday 00:00 local time of the calendar week containing `timestamp`.
  const d = new Date(timestamp);
  const day = d.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - daysFromMonday);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface TopRowFormatted {
  lead: string;
  when: string;
  model: string;
  dur: string;
  commits: string;
  waste: boolean;
}

function fmtTopRow(r: TopRowFormatted): string {
  const lead = r.lead.padStart(5);
  const when = r.when.padEnd(9);
  const model = r.model.padEnd(14);
  const dur = r.dur.padStart(6);
  const commits = r.commits.padEnd(10);
  const wasteMarker = r.waste ? yellow('⚠ waste') : '';
  return `    ${lead}  ${when}  ${model}  ${dim(dur)}  ${commits}${wasteMarker}`;
}

function renderTierFlexBlock(tier: TierFlexResult): string[] {
  const lines: string[] = [];
  if (tier.rows.length < 2 && !tier.warning) return lines;

  lines.push('');
  lines.push(cyan('  Tier-flex audit') + dim(' (last 30 days)'));
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
  nameMap: Map<string, string>,
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
  lines.push(cyan('  By project'));
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
  const labelWidth = Math.min(
    24,
    Math.max(...rows.slice(0, 5).map((r) => projectLabel(r.hash, nameMap).length)),
  );
  for (const r of rows.slice(0, 5)) {
    const label = projectLabel(r.hash, nameMap).padEnd(labelWidth);
    const cps =
      r.commits > 0
        ? showDollars
          ? fmtUsd(r.cost / r.commits) + '/commit'
          : `${Math.round(r.tokens / r.commits / 1000)}K tok/commit`
        : dim('no commits');
    const headline = showDollars
      ? fmtUsd(r.cost).padStart(8)
      : `${fmtNum(r.tokens)} tok`.padStart(14);
    lines.push(`    ${cyan(label)}   ${headline}   ${cps}`);
  }
  return lines;
}

function projectLabel(hash: string, nameMap: Map<string, string>): string {
  const name = nameMap.get(hash);
  if (name) return name;
  return hash.slice(0, 10);
}

export function renderLast7Days(
  db: DatabaseSync,
  projectHash?: string,
  windowDays: number = 7,
  calendarWeek: boolean = false,
): string {
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
  const curr7 = all.filter((s) => s.date >= isoDateUTC(currStart));
  const prior7 = all.filter(
    (s) => s.date < isoDateUTC(currStart) && s.date >= isoDateUTC(priorStart),
  );

  const curr = aggregate(curr7);
  const prev = aggregate(prior7);
  const topSessions = getTopExpensiveSessions(
    db,
    currStart,
    TOP_SESSIONS_N,
    projectHash,
  );
  const rateHits = getRateLimitHitsSince(db, currStart);
  const tierFlex = computeTierFlex(db, now - 30 * 86400_000);
  const patterns = detectPatterns(db, now - 30 * 86400_000);
  const survival = getSurvivalSummariesSince(db, currStart, projectHash);
  const nameMap = getProjectNameMap(db);
  const usage = computeUsageCheck(db, cfg.plan);
  const effTally = bucketWindow(db, currStart, now, projectHash);
  const ctx: RenderCtx = {
    cfg, last7Start: currStart, now, curr, prev,
    topSessions, rateHits, tierFlex, patterns, survival, last7: curr7,
    nameMap, projectFilter: projectHash, windowDays, calendarWeek,
    usage, effTally,
  };

  if (isApiPlan(cfg.plan)) return renderApiView(ctx);
  if (isSubscriptionPlan(cfg.plan)) return renderSubscriptionView(ctx);
  return renderUnknownView(ctx);
}

interface RenderCtx {
  cfg: MileageConfig;
  last7Start: number;
  now: number;
  curr: WindowAgg;
  prev: WindowAgg;
  topSessions: TopSession[];
  rateHits: RateLimitHit[];
  tierFlex: TierFlexResult;
  patterns: PatternFinding[];
  survival: MultiWindowSurvival;
  last7: Snapshot[];
  nameMap: Map<string, string>;
  projectFilter?: string;
  windowDays: number;
  calendarWeek: boolean;
  usage: UsageCheckResult;
  effTally: EffTally;
}

function renderApiView(ctx: RenderCtx): string {
  const { cfg, last7Start, now, curr, prev, topSessions, rateHits, tierFlex, patterns, survival, last7 } = ctx;
  const lines: string[] = [];

  lines.push(
    ...renderHeaderBar(
      windowLabel(ctx.windowDays, ctx.calendarWeek) +
        '  ·  ' +
        fmtDateRange(last7Start, now),
      planDisplayName(cfg.plan),
      scopeLabel(ctx.projectFilter, ctx.nameMap),
    ),
  );

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
      ? '  ' + dim(`(vs ${fmtNum(prev.attributed_commit_count)} prior period)`)
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
    lines.push(cyan(`  Top sessions`) + dim(` (by cost)`));
    for (const s of topSessions) {
      lines.push(
        fmtTopRow({
          lead: fmtUsd(s.cost_usd, s.cost_usd >= 10 ? 0 : 2),
          when: fmtWeekdayTime(s.timestamp),
          model: shortModel(s.model_id),
          dur: fmtDuration(s.duration_ms),
          commits: s.attr_count === 0 ? '0 commits' : s.attr_count === 1 ? '1 commit' : `${s.attr_count} commits`,
          waste:
            s.cost_usd >= cfg.preferences.waste_threshold_usd && s.attr_count === 0,
        }),
      );
    }
  }

  lines.push(...renderSurvivalBlock(survival));
  lines.push(...renderTierFlexBlock(tierFlex));
  lines.push(...renderPatternsBlock(patterns));
  lines.push(...renderProjectBreakdown(last7, true, ctx.nameMap));

  if (curr.session_count === 0 && curr.commit_count === 0) {
    lines.push('');
    lines.push(
      yellow(
        '  No data in this window. Run `mileage sync` from a git repo where you have used Claude Code recently.',
      ),
    );
  }

  const yptCurr = avgYpt(curr);
  const yptLine = renderYptFooter(yptCurr, curr.session_count > 0, ctx.projectFilter);
  if (yptLine) {
    lines.push('');
    lines.push(yptLine);
  }
  lines.push('');
  return lines.join('\n');
}

function renderSubscriptionView(ctx: RenderCtx): string {
  const { cfg, last7Start, now, curr, prev, topSessions, rateHits, tierFlex, patterns, survival, last7 } = ctx;
  const lines: string[] = [];
  const totalTokens = curr.total_tokens_in + curr.total_tokens_out;
  const prevTokens = prev.total_tokens_in + prev.total_tokens_out;

  lines.push(
    ...renderHeaderBar(
      windowLabel(ctx.windowDays, ctx.calendarWeek) +
        '  ·  ' +
        fmtDateRange(last7Start, now),
      planDisplayName(cfg.plan),
      scopeLabel(ctx.projectFilter, ctx.nameMap),
    ),
  );
  lines.push(renderHeadroomLine(ctx.usage));
  lines.push(...renderShipLine(ctx.effTally, survival7dRate(ctx.survival)));
  lines.push('  ' + dim('─'.repeat(44)));

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
      ? '  ' + dim(`(vs ${fmtNum(prev.attributed_commit_count)} prior period)`)
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
    lines.push(cyan(`  Top sessions`) + dim(` (by usage)`));
    for (const s of topSessions) {
      const pct =
        curr.total_cost_usd > 0
          ? `${((s.cost_usd / curr.total_cost_usd) * 100).toFixed(0)}%`
          : '-';
      lines.push(
        fmtTopRow({
          lead: pct,
          when: fmtWeekdayTime(s.timestamp),
          model: shortModel(s.model_id),
          dur: fmtDuration(s.duration_ms),
          commits: s.attr_count === 0 ? '0 commits' : s.attr_count === 1 ? '1 commit' : `${s.attr_count} commits`,
          waste:
            s.attr_count === 0 && s.cost_usd >= cfg.preferences.waste_threshold_usd,
        }),
      );
    }
  }

  lines.push(...renderSurvivalBlock(survival));
  lines.push(...renderTierFlexBlock(tierFlex));
  lines.push(...renderPatternsBlock(patterns));
  lines.push(...renderProjectBreakdown(last7, false, ctx.nameMap));

  if (curr.session_count === 0 && curr.commit_count === 0) {
    lines.push('');
    lines.push(
      yellow(
        '  No data in this window. Run `mileage sync` from a git repo where you have used Claude Code recently.',
      ),
    );
  }

  const yptCurr = avgYpt(curr);
  const yptLine = renderYptFooter(yptCurr, curr.session_count > 0, ctx.projectFilter);
  if (yptLine) {
    lines.push('');
    lines.push(yptLine);
  }
  lines.push('');
  return lines.join('\n');
}

function renderUnknownView(ctx: RenderCtx): string {
  const apiOut = renderApiView(ctx);
  const banner =
    '\n' +
    yellow(
      '  ⚙ Declare your plan for better-tailored output: `mileage config:set-plan <plan>` (api | pro | max-100 | max-200 | cursor-pro | copilot)',
    ) +
    '\n';
  return banner + apiOut;
}

function fmtNumF(n: unknown, decimals: number): string {
  const x = Number(n);
  if (!Number.isFinite(x)) return '—';
  return x.toFixed(decimals);
}

export function renderExplain(db: DatabaseSync, metric: string): string {
  if (metric !== 'ypt') return `Unknown metric: ${metric}. Known: ypt`;
  const rows = getSnapshotsSince(db, '0000-01-01');
  if (rows.length === 0) return 'No snapshots yet. Run `mileage sync` first.';
  rows.sort((a, b) => (a.date < b.date ? 1 : -1));
  const latest = rows.find((r) => r.ypt_score !== null) ?? rows[0];
  const prov: any = latest.provenance ?? {};
  const version = prov.version || '(unknown version)';
  const cal = prov.calibration ?? {};
  const inputs = prov.inputs ?? {};
  const byModel = prov.by_model ?? {};
  const nameMap = getProjectNameMap(db);
  const projectName =
    nameMap.get(latest.project_hash) ?? latest.project_hash.slice(0, 10);
  const lines: string[] = [];

  // Header
  lines.push('');
  lines.push(
    brightCyan(bold('YPT')) +
      '  ' +
      dim('·') +
      '  ' +
      cyan('Yield Per Token') +
      '  ' +
      dim('·') +
      '  ' +
      magenta(version),
  );
  lines.push('');

  // What it is
  lines.push(cyan('  What it measures'));
  lines.push('    A bounded 0 to 100 score for how efficiently your tokens convert into');
  lines.push('    shipped work. 50 is a typical day. 90 is top-decile.');
  lines.push('');

  // How it's computed
  lines.push(cyan('  How it is computed'));
  lines.push(`    yield_rate = composite_outcomes / (tokens / 100,000)`);
  lines.push(`    YPT        = 100 × Φ((ln(yield_rate) - ln(μ)) / σ)`);
  lines.push('');
  lines.push('    ' + dim('where:'));
  lines.push('    ' + bold('Φ') + dim(' (phi)   ') + 'standard normal CDF, a smooth S-curve from 0 to 100');
  lines.push('    ' + bold('μ') + dim(' (mu)    ') + 'calibration midpoint (the yield_rate that maps to 50)');
  lines.push('    ' + bold('σ') + dim(' (sigma) ') + 'spread (how steep the curve is around the midpoint)');
  lines.push('    ' + bold('ln') + dim('         ') + 'natural logarithm (compresses big numbers)');
  lines.push('');
  lines.push('    composite_outcomes counts your attributed commits, weighted by:');
  lines.push('      attribution confidence (direct=1.0, hook=0.85, inferred=0.5)');
  lines.push('      code survival at 7d/30d (a commit reverted next day counts less)');
  lines.push('      your self-tags (marking a session shipped or dead-end)');
  lines.push('');

  // Current calibration
  lines.push(cyan('  Active calibration'));
  lines.push(
    `    μ      = ${bold(fmtNumF(cal.mu, 4))}   ${dim('(median yield_rate that maps to score 50)')}`,
  );
  lines.push(
    `    σ      = ${bold(fmtNumF(cal.sigma, 4))}   ${dim('(spread; controls how fast the score rises)')}`,
  );
  lines.push(`    anchor = ${cal.anchor ?? '(unset)'}`);
  lines.push(`    source = ${cal.source ?? '(unset)'}`);
  lines.push('');

  // Most recent scored snapshot
  lines.push(
    cyan('  Most recent scored snapshot') +
      dim('  ·  ' + latest.date + '  ·  project ') +
      cyan(projectName),
  );
  lines.push(`    tokens                = ${fmtNum(inputs.tokens ?? 0)}`);
  lines.push(
    `    composite_outcomes    = ${fmtNumF(inputs.composite_outcomes ?? 0, 3)}`,
  );
  lines.push(
    `    yield_rate            = ${fmtNumF(inputs.yield_rate ?? 0, 3)}   ${dim('(outcomes per 100K tokens)')}`,
  );
  lines.push(
    `    scorable / unscorable = ${inputs.scorable_sessions ?? 0} / ${inputs.unscorable_sessions ?? 0}   ${dim('sessions')}`,
  );
  if (inputs.excluded_sessions) {
    lines.push(`    excluded (exploring)  = ${inputs.excluded_sessions}`);
  }
  const attr = inputs.attribution_breakdown ?? {};
  lines.push(
    `    attribution mix       = ${attr.direct ?? 0} direct, ${attr.high ?? 0} hook, ${attr.inferred ?? 0} inferred`,
  );
  const tags = inputs.self_tag_breakdown ?? {};
  const tagPairs: [string, number][] = [
    ['shipped', tags.shipped ?? 0],
    ['exploring', tags.exploring ?? 0],
    ['debugging', tags.debugging ?? 0],
    ['dead-end', tags['dead-end'] ?? 0],
  ];
  const tagStr =
    tagPairs
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ') || '(none)';
  lines.push(`    self-tag mix          = ${tagStr}`);
  const survivalLabel = inputs.survival_weight_applied
    ? green('applied')
    : dim('not yet (commits younger than 7 days)');
  lines.push(`    survival weighting    = ${survivalLabel}`);
  const score =
    latest.ypt_score === null
      ? dim('not scored')
      : yptScoreColor(latest.ypt_score)(bold(latest.ypt_score.toFixed(2)));
  lines.push(`    YPT score             = ${score}`);

  // Per-model
  const modelEntries = Object.entries(byModel as Record<string, any>);
  if (modelEntries.length > 0) {
    lines.push('');
    lines.push(cyan('  Per-model breakdown'));
    for (const [model, m] of modelEntries) {
      const label = model.padEnd(24);
      const sess = String(m.sessions).padStart(3);
      const yr = fmtNumF(m.yield_rate, 2).padStart(5);
      const sc = fmtNumF(m.score, 0).padStart(3);
      lines.push(`    ${label}  ${sess} sess   yield ${yr}   score ${sc}`);
    }
  }

  // Sources
  if (Array.isArray(prov.citations) && prov.citations.length > 0) {
    lines.push('');
    lines.push(cyan('  Sources'));
    for (const c of prov.citations) {
      // Strip the "what V0.1.1 was; replaced" parenthetical roadmap-speak
      // and other internal asides.
      const cleaned = String(c)
        .replace(/\s*\(.*?was.*?replaced.*?\)\s*$/i, '')
        .replace(/\s*\(.*?Phase 3.*?\)\s*$/i, '')
        .replace(/\s*\(.*?deferred.*?\)\s*$/i, '');
      lines.push('    · ' + cleaned);
    }
  }

  lines.push('');
  lines.push(
    dim(
      '  This calibration is the initial release. (μ, σ) will be refined as the user base grows.',
    ),
  );
  lines.push('');
  return lines.join('\n');
}
