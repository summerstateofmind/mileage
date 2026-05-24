import { DatabaseSync } from 'node:sqlite';
import { getSnapshotsSince } from '../storage/db';
import { bold, dim } from './ansi';
import { readConfig, isApiPlan } from '../config/plan';
import type { Snapshot } from '../storage/types';

const DAYS = 90;
const MS_PER_DAY = 86_400_000;

interface DayCell {
  date: string;
  hasData: boolean;
  cost: number;
  tokens: number;
  attributed: number;
  efficiency: number | null;
}

function isoDateUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function buildDayCells(snaps: Snapshot[]): Map<string, DayCell> {
  const cells = new Map<string, DayCell>();
  const now = Date.now();
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = isoDateUTC(now - i * MS_PER_DAY);
    cells.set(date, {
      date,
      hasData: false,
      cost: 0,
      tokens: 0,
      attributed: 0,
      efficiency: null,
    });
  }
  for (const s of snaps) {
    const c = cells.get(s.date);
    if (!c) continue;
    c.hasData = true;
    c.cost += s.total_cost_usd;
    c.tokens += s.total_tokens_in + s.total_tokens_out;
    c.attributed += s.attributed_commit_count;
  }
  for (const c of cells.values()) {
    if (!c.hasData) continue;
    if (c.attributed > 0) {
      c.efficiency = c.attributed / Math.max(1, c.tokens / 100_000);
    } else if (c.tokens > 0) {
      c.efficiency = 0;
    }
  }
  return cells;
}

function ansi256(code: number, content: string): string {
  if (!process.stdout.isTTY || process.env.NO_COLOR) return content;
  return `\x1b[38;5;${code}m${content}\x1b[0m`;
}

function pickColor(c: DayCell, p90Efficiency: number): number {
  if (!c.hasData) return 240;
  if (c.efficiency === null) return 240;
  if (c.efficiency === 0) return 124;
  if (p90Efficiency <= 0) return 244;
  const ratio = Math.min(1, c.efficiency / p90Efficiency);
  if (ratio < 0.2) return 124;
  if (ratio < 0.4) return 166;
  if (ratio < 0.6) return 178;
  if (ratio < 0.8) return 148;
  return 40;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

export function renderHeatmap(db: DatabaseSync, projectHash?: string): string {
  const sinceDate = isoDateUTC(Date.now() - DAYS * MS_PER_DAY);
  const snaps = getSnapshotsSince(db, sinceDate, projectHash);
  const cells = buildDayCells(snaps);

  const effValues: number[] = [];
  for (const c of cells.values()) {
    if (c.hasData && c.efficiency !== null && c.efficiency > 0) effValues.push(c.efficiency);
  }
  const p90 = percentile(effValues, 0.9);

  const sorted = [...cells.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const startDow = new Date(sorted[0].date + 'T00:00:00Z').getUTCDay();

  const grid: (DayCell | null)[][] = Array.from({ length: 7 }, () => []);
  for (let i = 0; i < startDow; i++) grid[i].push(null);
  let dow = startDow;
  for (const c of sorted) {
    grid[dow].push(c);
    dow = (dow + 1) % 7;
  }
  const maxCols = Math.max(...grid.map((r) => r.length));
  for (const r of grid) while (r.length < maxCols) r.push(null);

  const lines: string[] = [];
  lines.push('');
  lines.push(bold('Mileage heatmap') + dim('  ·  last 90 days  ·  color = efficiency (commits per 100K tokens)'));
  lines.push('');
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (let r = 0; r < 7; r++) {
    const cells = grid[r];
    let row = '  ' + dim(dayLabels[r].padEnd(4));
    for (const c of cells) {
      if (c === null) {
        row += '  ';
      } else if (!c.hasData) {
        row += ansi256(238, '· ');
      } else {
        const color = pickColor(c, p90);
        row += ansi256(color, '■ ');
      }
    }
    lines.push(row);
  }
  lines.push('');
  const cfg = readConfig();
  const legend = isApiPlan(cfg.plan)
    ? '  Legend: ' +
      ansi256(238, '·') + dim(' no data    ') +
      ansi256(124, '■') + dim(' wasted    ') +
      ansi256(178, '■') + dim(' typical    ') +
      ansi256(40,  '■') + dim(' efficient')
    : '  Legend: ' +
      ansi256(238, '·') + dim(' no data    ') +
      ansi256(124, '■') + dim(' tokens, no commits    ') +
      ansi256(178, '■') + dim(' typical    ') +
      ansi256(40,  '■') + dim(' high-yield day');
  lines.push(legend);
  lines.push('');
  return lines.join('\n');
}
