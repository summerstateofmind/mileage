import { DatabaseSync } from 'node:sqlite';

export interface PatternFinding {
  severity: number;
  headline: string;
  detail: string;
}

interface SessionRow {
  timestamp: number;
  model_id: string;
  cost_usd: number;
  attr_count: number;
}

function loadSessions(
  db: DatabaseSync,
  sinceMs: number,
  projectHash?: string,
): SessionRow[] {
  const projectClause = projectHash ? 'AND e.project_hash = ?' : '';
  const params: unknown[] = projectHash ? [sinceMs, projectHash] : [sinceMs];
  return db
    .prepare(
      `SELECT
         e.timestamp,
         COALESCE(e.model_id, 'unknown') AS model_id,
         e.cost_usd,
         (SELECT COUNT(*) FROM attributions a WHERE a.session_id = e.session_id) AS attr_count
       FROM events e
       WHERE e.type = 'session'
         AND e.timestamp >= ?
         ${projectClause}
         AND e.cost_usd > 0`,
    )
    .all(...(params as never[])) as unknown as SessionRow[];
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

function dayOfWeek(ts: number): number {
  return new Date(ts).getDay();
}

function isMorning(ts: number): boolean {
  const h = new Date(ts).getHours();
  return h >= 6 && h < 12;
}

function isAfternoon(ts: number): boolean {
  const h = new Date(ts).getHours();
  return h >= 12 && h < 18;
}

function isEvening(ts: number): boolean {
  const h = new Date(ts).getHours();
  return h >= 18 || h < 6;
}

interface Bucket {
  n: number;
  cost: number;
  outcomes: number;
}
function emptyBucket(): Bucket {
  return { n: 0, cost: 0, outcomes: 0 };
}
function add(b: Bucket, s: SessionRow): void {
  b.n++;
  b.cost += s.cost_usd;
  b.outcomes += s.attr_count > 0 ? 1 : 0;
}
function yieldRate(b: Bucket): number {
  return b.n > 0 ? b.outcomes / b.n : 0;
}

function timeOfDayPattern(sessions: SessionRow[]): PatternFinding | null {
  const morning = emptyBucket();
  const afternoon = emptyBucket();
  const evening = emptyBucket();
  for (const s of sessions) {
    if (isMorning(s.timestamp)) add(morning, s);
    else if (isAfternoon(s.timestamp)) add(afternoon, s);
    else if (isEvening(s.timestamp)) add(evening, s);
  }
  const buckets: [string, Bucket][] = [
    ['morning', morning],
    ['afternoon', afternoon],
    ['evening', evening],
  ];
  const eligible = buckets.filter(([, b]) => b.n >= 5);
  if (eligible.length < 2) return null;

  eligible.sort((a, b) => yieldRate(b[1]) - yieldRate(a[1]));
  const best = eligible[0];
  const worst = eligible[eligible.length - 1];
  const bestY = yieldRate(best[1]);
  const worstY = yieldRate(worst[1]);
  if (bestY < 0.1) return null;
  if (bestY < worstY * 1.6) return null;

  const severity = (bestY - worstY) * 10;
  return {
    severity,
    headline: `Your ${best[0]} sessions ship outcomes ${(bestY * 100).toFixed(0)}% of the time vs ${(worstY * 100).toFixed(0)}% for ${worst[0]}.`,
    detail: `${best[1].n} ${best[0]} sessions, ${worst[1].n} ${worst[0]} sessions over the window.`,
  };
}

function dayOfWeekPattern(sessions: SessionRow[]): PatternFinding | null {
  const dayBuckets: Bucket[] = Array.from({ length: 7 }, () => emptyBucket());
  for (const s of sessions) {
    add(dayBuckets[dayOfWeek(s.timestamp)], s);
  }
  const labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const eligible = dayBuckets
    .map((b, i) => ({ day: labels[i], bucket: b }))
    .filter(({ bucket }) => bucket.n >= 3);
  if (eligible.length < 2) return null;

  eligible.sort((a, b) => yieldRate(b.bucket) - yieldRate(a.bucket));
  const best = eligible[0];
  const worst = eligible[eligible.length - 1];
  const bestY = yieldRate(best.bucket);
  const worstY = yieldRate(worst.bucket);
  if (bestY < 0.15) return null;
  if (bestY < worstY * 1.8) return null;

  const severity = (bestY - worstY) * 8;
  return {
    severity,
    headline: `Your ${best.day} sessions ship ${(bestY * 100).toFixed(0)}% of the time vs ${(worstY * 100).toFixed(0)}% on ${worst.day}.`,
    detail: `${best.bucket.n} ${best.day} sessions, ${worst.bucket.n} ${worst.day} sessions over the window.`,
  };
}

function longExpensivePattern(sessions: SessionRow[]): PatternFinding | null {
  const longExpensive = sessions.filter(
    (s) => s.cost_usd >= 30 && s.attr_count === 0,
  );
  if (longExpensive.length < 3) return null;
  const totalCost = longExpensive.reduce((a, s) => a + s.cost_usd, 0);
  const totalAllCost = sessions.reduce((a, s) => a + s.cost_usd, 0);
  if (totalAllCost === 0) return null;
  const fraction = totalCost / totalAllCost;
  if (fraction < 0.15) return null;

  const severity = fraction * 12;
  return {
    severity,
    headline: `${longExpensive.length} expensive sessions (>$30) shipped zero commits — ${(fraction * 100).toFixed(0)}% of your total spend.`,
    detail: `Total wasted on these sessions: $${totalCost.toFixed(0)}. Worth a \`mileage tag\` pass to mark them.`,
  };
}

function modelOutcomeMix(sessions: SessionRow[]): PatternFinding | null {
  const byModel = new Map<string, Bucket>();
  for (const s of sessions) {
    const k = shortModel(s.model_id);
    if (!byModel.has(k)) byModel.set(k, emptyBucket());
    add(byModel.get(k)!, s);
  }
  const eligible = Array.from(byModel.entries()).filter(([, b]) => b.n >= 5);
  if (eligible.length < 2) return null;

  let best: [string, Bucket] | null = null;
  let worst: [string, Bucket] | null = null;
  for (const e of eligible) {
    if (!best || yieldRate(e[1]) > yieldRate(best[1])) best = e;
    if (!worst || yieldRate(e[1]) < yieldRate(worst[1])) worst = e;
  }
  if (!best || !worst || best === worst) return null;
  const bestY = yieldRate(best[1]);
  const worstY = yieldRate(worst[1]);
  if (bestY < 0.15) return null;
  if (bestY < worstY * 1.5) return null;

  const severity = (bestY - worstY) * 9;
  return {
    severity,
    headline: `${best[0]} ships ${(bestY * 100).toFixed(0)}% of the time vs ${worst[0]} at ${(worstY * 100).toFixed(0)}%.`,
    detail: `Consider defaulting to ${best[0]} for similar work.`,
  };
}

export function detectPatterns(
  db: DatabaseSync,
  sinceMs: number,
  projectHash?: string,
): PatternFinding[] {
  const sessions = loadSessions(db, sinceMs, projectHash);
  if (sessions.length < 10) return [];

  const findings: PatternFinding[] = [];
  for (const detector of [
    longExpensivePattern,
    timeOfDayPattern,
    dayOfWeekPattern,
    modelOutcomeMix,
  ]) {
    const f = detector(sessions);
    if (f) findings.push(f);
  }
  findings.sort((a, b) => b.severity - a.severity);
  return findings;
}
