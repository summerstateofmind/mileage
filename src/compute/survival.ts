import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CommitSurvivalRow } from '../storage/types';

const WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;

interface CommitForSurvival {
  commit_hash: string;
  project_hash: string;
  timestamp: number;
  lines_added: number;
  files_changed: number;
  cwd_candidate: string | null;
}

export function selectCommitsNeedingSurvivalCompute(
  db: DatabaseSync,
  windowDays: number = WINDOW_DAYS,
): CommitForSurvival[] {
  const cutoffMs = Date.now() - windowDays * MS_PER_DAY;
  const rows = db
    .prepare(
      `SELECT e.commit_hash, e.project_hash, e.timestamp, e.lines_added, e.files_changed
       FROM events e
       LEFT JOIN commit_survival s
         ON s.commit_hash = e.commit_hash AND s.window_days = ?
       WHERE e.type = 'commit'
         AND e.timestamp <= ?
         AND e.commit_hash IN (SELECT commit_hash FROM attributions)
         AND s.commit_hash IS NULL`,
    )
    .all(windowDays, cutoffMs) as any[];

  return rows.map((r) => ({
    commit_hash: String(r.commit_hash),
    project_hash: String(r.project_hash),
    timestamp: Number(r.timestamp),
    lines_added: Number(r.lines_added ?? 0),
    files_changed: Number(r.files_changed ?? 0),
    cwd_candidate: null,
  }));
}

function gitFilesInCommit(repoPath: string, commitHash: string): string[] | null {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoPath, 'show', '--numstat', '--pretty=format:', commitHash],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const files: string[] = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) files.push(m[3]);
    }
    return files;
  } catch {
    return null;
  }
}

function gitFileChangedSince(
  repoPath: string,
  commitHash: string,
  filePath: string,
  windowDays: number,
): boolean {
  try {
    const since = `${windowDays} days`;
    const out = execFileSync(
      'git',
      [
        '-C',
        repoPath,
        'log',
        `${commitHash}..HEAD`,
        `--since=${since}`,
        '--oneline',
        '--',
        filePath,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function computeSurvivalForCommit(
  repoPath: string,
  commit: CommitForSurvival,
  windowDays: number = WINDOW_DAYS,
): CommitSurvivalRow | null {
  const files = gitFilesInCommit(repoPath, commit.commit_hash);
  if (files === null) return null;

  let filesRevisited = 0;
  for (const f of files) {
    if (gitFileChangedSince(repoPath, commit.commit_hash, f, windowDays)) {
      filesRevisited++;
    }
  }
  const filesTouched = files.length;
  // File-level approximation: assume even line distribution across files;
  // surviving lines = lines_added * (1 - revisitedRatio)
  const revisitedRatio = filesTouched > 0 ? filesRevisited / filesTouched : 0;
  const linesSurviving = Math.round(commit.lines_added * (1 - revisitedRatio));

  return {
    commit_hash: commit.commit_hash,
    project_hash: commit.project_hash,
    evaluated_at: Date.now(),
    lines_added: commit.lines_added,
    lines_surviving: linesSurviving,
    files_touched: filesTouched,
    files_revisited: filesRevisited,
    window_days: windowDays,
  };
}

export function upsertSurvival(db: DatabaseSync, row: CommitSurvivalRow): void {
  db.prepare(
    `INSERT OR REPLACE INTO commit_survival
     (commit_hash, project_hash, evaluated_at, lines_added, lines_surviving,
      files_touched, files_revisited, window_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.commit_hash,
    row.project_hash,
    row.evaluated_at,
    row.lines_added,
    row.lines_surviving,
    row.files_touched,
    row.files_revisited,
    row.window_days,
  );
}

export interface SurvivalUpdateResult {
  evaluated: number;
  unable: number;
}

const DEFAULT_WINDOWS = [7, 30];

export function updateSurvivalForCwd(
  db: DatabaseSync,
  cwd: string,
  windows: number[] = DEFAULT_WINDOWS,
): SurvivalUpdateResult {
  let evaluated = 0;
  let unable = 0;
  for (const w of windows) {
    const candidates = selectCommitsNeedingSurvivalCompute(db, w);
    for (const c of candidates) {
      const row = computeSurvivalForCommit(cwd, c, w);
      if (row === null) {
        unable++;
        continue;
      }
      upsertSurvival(db, row);
      evaluated++;
    }
  }
  return { evaluated, unable };
}

export interface SurvivalSummary {
  total_lines_added: number;
  total_lines_surviving: number;
  rate: number | null;
  files_revisited: { file: string; count: number }[];
  commits_evaluated: number;
}

export interface MultiWindowSurvival {
  windows: { window_days: number; summary: SurvivalSummary }[];
}

export function getSurvivalSummariesSince(
  db: DatabaseSync,
  sinceMs: number,
  projectHash?: string,
  windows: number[] = DEFAULT_WINDOWS,
): MultiWindowSurvival {
  return {
    windows: windows.map((w) => ({
      window_days: w,
      summary: getSurvivalSummarySince(db, sinceMs, projectHash, w),
    })),
  };
}

export function getSurvivalSummarySince(
  db: DatabaseSync,
  sinceMs: number,
  projectHash?: string,
  windowDays: number = WINDOW_DAYS,
): SurvivalSummary {
  // Survival can only be computed for commits older than `windowDays`, so
  // "this week's survival" really means "the freshest survival data we have."
  // Look at commits evaluated in the last 30 days, regardless of when the
  // commit itself happened.
  const evalCutoffMs = Date.now() - 30 * MS_PER_DAY;
  const projFilter = projectHash ? `AND s.project_hash = ?` : '';
  const params: unknown[] = projectHash
    ? [windowDays, evalCutoffMs, projectHash]
    : [windowDays, evalCutoffMs];
  void sinceMs; // intentionally unused — see comment above
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(s.lines_added), 0)     AS total_lines_added,
         COALESCE(SUM(s.lines_surviving), 0) AS total_lines_surviving,
         COUNT(*)                            AS commits_evaluated
       FROM commit_survival s
       WHERE s.window_days = ?
         AND s.evaluated_at >= ?
         ${projFilter}`,
    )
    .get(...(params as never[])) as any;
  const total = Number(row?.total_lines_added ?? 0);
  const surv = Number(row?.total_lines_surviving ?? 0);
  return {
    total_lines_added: total,
    total_lines_surviving: surv,
    rate: total > 0 ? surv / total : null,
    files_revisited: [],
    commits_evaluated: Number(row?.commits_evaluated ?? 0),
  };
}
