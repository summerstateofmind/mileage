import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

export interface CommitDetail {
  hash: string;
  short_hash: string;
  subject: string;
  body: string;
  files: string[];
}

const subjectCache = new Map<string, { subject: string; body: string } | null>();
const filesCache = new Map<string, string[] | null>();

function gitSubject(
  projectPath: string,
  hash: string,
  includeBody: boolean,
): { subject: string; body: string } | null {
  const cacheKey = `${projectPath}::${hash}::${includeBody ? 'b' : 's'}`;
  const cached = subjectCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const fmt = includeBody ? '%s%n---BODY---%n%b' : '%s';
    const out = execFileSync(
      'git',
      ['-C', projectPath, 'log', '-1', `--format=${fmt}`, hash],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (includeBody) {
      const [subject, ...rest] = out.split('\n---BODY---\n');
      const result = {
        subject: subject.trim(),
        body: rest.join('\n---BODY---\n').trim(),
      };
      subjectCache.set(cacheKey, result);
      return result;
    }
    const result = { subject: out.trim(), body: '' };
    subjectCache.set(cacheKey, result);
    return result;
  } catch {
    subjectCache.set(cacheKey, null);
    return null;
  }
}

function gitFiles(projectPath: string, hash: string): string[] | null {
  const cacheKey = `${projectPath}::${hash}`;
  const cached = filesCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        projectPath,
        'show',
        '--name-only',
        '--no-renames',
        '--format=',
        hash,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const files = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    filesCache.set(cacheKey, files);
    return files;
  } catch {
    filesCache.set(cacheKey, null);
    return null;
  }
}

export function fetchCommitDetail(
  projectPath: string | null,
  hash: string,
  includeBody: boolean = false,
): CommitDetail | null {
  if (!projectPath || !fs.existsSync(projectPath)) {
    return {
      hash,
      short_hash: hash.slice(0, 7),
      subject: '(project path unavailable)',
      body: '',
      files: [],
    };
  }
  const meta = gitSubject(projectPath, hash, includeBody);
  const files = gitFiles(projectPath, hash);
  if (!meta && !files) return null;
  return {
    hash,
    short_hash: hash.slice(0, 7),
    subject: meta?.subject ?? '(unknown subject)',
    body: meta?.body ?? '',
    files: files ?? [],
  };
}

export function dedupeFilesAcrossCommits(
  commits: CommitDetail[],
  cap: number = 5,
): { shown: string[]; remaining: number } {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const c of commits) {
    for (const f of c.files) {
      if (seen.has(f)) continue;
      seen.add(f);
      ordered.push(f);
    }
  }
  if (ordered.length <= cap) return { shown: ordered, remaining: 0 };
  return { shown: ordered.slice(0, cap), remaining: ordered.length - cap };
}
