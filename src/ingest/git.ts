import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { insertCommit } from '../storage/db';
import type { CommitEvent } from '../storage/types';

export function gitLogSince(
  cwd: string,
  sinceMs: number,
  projectHash: string,
): CommitEvent[] {
  const sinceSec = Math.floor(sinceMs / 1000);
  let stdout: string;
  try {
    stdout = execFileSync(
      'git',
      [
        '-C',
        cwd,
        'log',
        '--numstat',
        `--pretty=format:COMMIT|%H|%ct|%D`,
        `--since=@${sinceSec}`,
        '--no-merges',
        'HEAD',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 50 * 1024 * 1024 },
    );
  } catch {
    return [];
  }

  const commits: CommitEvent[] = [];
  let current: {
    hash: string;
    ts: number;
    branch: string;
    files: { added: number; removed: number; pathStr: string }[];
  } | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    if (line.startsWith('COMMIT|')) {
      if (current) commits.push(toEvent(current, projectHash));
      const [, hash, ctSec, refs] = line.split('|');
      current = {
        hash,
        ts: Number(ctSec) * 1000,
        branch: parseBranchFromRefs(refs || ''),
        files: [],
      };
    } else if (current) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) {
        const added = m[1] === '-' ? 0 : Number(m[1]);
        const removed = m[2] === '-' ? 0 : Number(m[2]);
        current.files.push({ added, removed, pathStr: m[3] });
      }
    }
  }
  if (current) commits.push(toEvent(current, projectHash));

  return commits.filter((c) => c.files_changed > 0 || c.lines_added > 0 || c.lines_removed > 0);
}

function parseBranchFromRefs(refs: string): string {
  const tokens = refs.split(',').map((s) => s.trim()).filter(Boolean);
  for (const t of tokens) {
    if (t.startsWith('HEAD -> ')) return t.slice('HEAD -> '.length);
    if (t === 'HEAD') continue;
    if (!t.includes('tag:')) return t;
  }
  return '';
}

function toEvent(
  c: {
    hash: string;
    ts: number;
    branch: string;
    files: { added: number; removed: number; pathStr: string }[];
  },
  projectHash: string,
): CommitEvent {
  let added = 0;
  let removed = 0;
  const extScores = new Map<string, number>();
  for (const f of c.files) {
    added += f.added;
    removed += f.removed;
    const ext = (path.extname(f.pathStr) || '').replace(/^\./, '').toLowerCase();
    if (ext) {
      extScores.set(ext, (extScores.get(ext) ?? 0) + f.added + f.removed);
    }
  }
  let primary = '';
  let topScore = -1;
  for (const [ext, score] of extScores) {
    if (score > topScore) {
      topScore = score;
      primary = ext;
    }
  }
  return {
    id: `git:${c.hash}`,
    timestamp: c.ts,
    type: 'commit',
    source: 'git',
    project_hash: projectHash,
    commit_hash: c.hash,
    lines_added: added,
    lines_removed: removed,
    files_changed: c.files.length,
    primary_language: primary,
    branch: c.branch,
  };
}

export interface GitIngestSummary {
  commitsIngested: number;
}

export function ingestGit(
  db: DatabaseSync,
  cwd: string,
  sinceMs: number,
  projectHash: string,
): GitIngestSummary {
  const commits = gitLogSince(cwd, sinceMs, projectHash);
  for (const c of commits) {
    insertCommit(db, c);
  }
  return { commitsIngested: commits.length };
}
