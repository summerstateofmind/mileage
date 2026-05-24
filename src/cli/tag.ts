import * as readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import {
  getUntaggedSessionsSince,
  setSessionTag,
  getSessionContextCommits,
  getProjectInfo,
  UntaggedSession,
  SessionContextCommit,
} from '../storage/db';
import { bold, dim, green, yellow, cyan, magenta } from '../render/ansi';
import type { SessionTag } from '../storage/types';
import {
  fetchCommitDetail,
  dedupeFilesAcrossCommits,
  CommitDetail,
} from './tag_context';

function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const dateStr = d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${dateStr} ${hours}:${mins}`;
}

function fmtClockTime(ms: number): string {
  const d = new Date(ms);
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${hours}:${mins}`;
}

function fmtAgo(ms: number): string {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function shortModel(modelId: string): string {
  return modelId.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

const KEY_TO_ACTION: Record<string, SessionTag | 'skip' | 'quit' | 'info'> = {
  s: 'shipped',
  e: 'exploring',
  d: 'debugging',
  x: 'dead-end',
  k: 'skip',
  q: 'quit',
  i: 'info',
};

function promptOnce(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

interface SessionContext {
  projectName: string;
  projectPath: string | null;
  commits: CommitDetail[];
  hasMoreFiles: boolean;
  filesShown: string[];
}

function gatherSessionContext(
  db: DatabaseSync,
  session: UntaggedSession,
): SessionContext {
  const project = getProjectInfo(db, session.project_hash);
  const projectName = project?.name ?? session.project_hash.slice(0, 10);
  const projectPath = project?.path ?? null;
  const endMs = session.timestamp + session.duration_ms;
  const ctxCommits = getSessionContextCommits(
    db,
    session.session_id,
    session.project_hash,
    session.timestamp,
    endMs,
  );
  const details: CommitDetail[] = [];
  for (const c of ctxCommits) {
    const d = fetchCommitDetail(projectPath, c.commit_hash, false);
    if (d) details.push({ ...d, ...{ subject: d.subject, files: d.files } });
  }
  const { shown, remaining } = dedupeFilesAcrossCommits(details, 5);
  return {
    projectName,
    projectPath,
    commits: details,
    hasMoreFiles: remaining > 0,
    filesShown: shown,
  };
}

function renderSessionBlock(
  s: UntaggedSession,
  ctxCommitsRaw: SessionContextCommit[],
  ctx: SessionContext,
  idx: number,
  total: number,
): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(bold(`Session ${idx + 1} of ${total}`));

  const header =
    `  ${cyan(fmtDateTime(s.timestamp))} ` +
    `${dim('(' + fmtAgo(s.timestamp) + ')')}  ` +
    `· ${shortModel(s.model_id)} ` +
    `· ${fmtDuration(s.duration_ms)} ` +
    `· $${s.cost_usd.toFixed(2)} ` +
    `· ${magenta(ctx.projectName)} ` +
    `· ${s.attr_count} commit${s.attr_count === 1 ? '' : 's'}`;
  lines.push(header);

  // Commit context
  const attributed = ctxCommitsRaw.filter((c) => c.kind === 'attributed');
  const nearby = ctxCommitsRaw.filter((c) => c.kind === 'nearby');

  if (attributed.length > 0) {
    lines.push('');
    lines.push(dim(`  Attributed commits:`));
    for (const c of attributed) {
      const d = ctx.commits.find((x) => x.hash === c.commit_hash);
      lines.push(
        `    ${dim(fmtClockTime(c.timestamp))}  ${yellow(d?.short_hash ?? c.commit_hash.slice(0, 7))}  ${d?.subject ?? '(no subject)'}`,
      );
    }
  }

  if (nearby.length > 0) {
    lines.push('');
    lines.push(
      dim(`  Nearby commits in ${ctx.projectName} (±2h, not yet attributed):`),
    );
    for (const c of nearby) {
      const d = ctx.commits.find((x) => x.hash === c.commit_hash);
      lines.push(
        `    ${dim(fmtClockTime(c.timestamp))}  ${yellow(d?.short_hash ?? c.commit_hash.slice(0, 7))}  ${d?.subject ?? '(no subject)'}`,
      );
    }
  }

  if (ctx.filesShown.length > 0) {
    lines.push('');
    const more = ctx.hasMoreFiles
      ? dim(`  (+${ctx.commits.reduce((n, c) => n + c.files.length, 0) - ctx.filesShown.length} more — press [i] for full list)`)
      : '';
    lines.push(dim('  Files touched in those commits:'));
    lines.push('    ' + ctx.filesShown.join(', '));
    if (more) lines.push(more);
  }

  if (attributed.length === 0 && nearby.length === 0) {
    lines.push('');
    lines.push(dim(`  No commits in ${ctx.projectName} near this session.`));
  }

  lines.push('');
  lines.push('  What happened?');
  lines.push(
    `    ${cyan('[s]')} shipped     · this session produced working, kept-around output`,
  );
  lines.push(
    `    ${cyan('[e]')} exploring   · research / learning / not meant to ship`,
  );
  lines.push(`    ${cyan('[d]')} debugging   · figuring something out`);
  lines.push(`    ${cyan('[x]')} dead-end    · tried, didn't work, walked away`);
  lines.push(`    ${cyan('[i]')} info        · show more detail (full commit msgs, all files)`);
  lines.push(`    ${cyan('[k]')} skip        · don't tag this one now`);
  lines.push(`    ${cyan('[q]')} quit        · stop tagging`);
  return lines.join('\n');
}

function renderExtendedInfo(
  db: DatabaseSync,
  session: UntaggedSession,
  ctxCommitsRaw: SessionContextCommit[],
): string {
  const project = getProjectInfo(db, session.project_hash);
  const projectPath = project?.path ?? null;
  const lines: string[] = [];
  lines.push('');
  lines.push(bold('  Extended context'));
  lines.push('');
  lines.push(`  Project path: ${dim(project?.path ?? '(unknown)')}`);
  lines.push(`  Session id:   ${dim(session.session_id)}`);
  lines.push('');

  if (ctxCommitsRaw.length === 0) {
    lines.push(
      dim(
        '  No additional context — this session has no attributed or nearby commits in its project.',
      ),
    );
  } else {
    for (const c of ctxCommitsRaw) {
      const d = fetchCommitDetail(projectPath, c.commit_hash, true);
      const kindLabel = c.kind === 'attributed' ? green('[attributed]') : dim('[nearby]');
      lines.push(
        `  ${yellow(d?.short_hash ?? c.commit_hash.slice(0, 7))}  ${kindLabel}  ${dim(fmtClockTime(c.timestamp))}`,
      );
      lines.push(`    ${d?.subject ?? '(no subject)'}`);
      if (d?.body) {
        for (const line of d.body.split('\n').filter(Boolean)) {
          lines.push(dim('    ' + line));
        }
      }
      if (d?.files && d.files.length > 0) {
        lines.push(dim(`    files (${d.files.length}):`));
        for (const f of d.files.slice(0, 30)) lines.push('      ' + f);
        if (d.files.length > 30) {
          lines.push(dim(`      (+${d.files.length - 30} more not shown)`));
        }
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

function renderTagMenu(session: UntaggedSession, projectName: string): string {
  return (
    `  Choose for this session ${dim('(')}${magenta(projectName)} ${dim('· $' + session.cost_usd.toFixed(2) + ')')}: ` +
    `${cyan('[s]')}hipped  ${cyan('[e]')}xploring  ${cyan('[d]')}ebugging  ${cyan('[x]')} dead-end  ${cyan('[i]')}nfo  ${cyan('[k]')}skip  ${cyan('[q]')}uit`
  );
}

export async function runTagFlow(
  db: DatabaseSync,
  options: { sinceMs?: number; minCostUsd?: number; limit?: number } = {},
): Promise<{ tagged: number; skipped: number; quit: boolean }> {
  const sinceMs = options.sinceMs ?? Date.now() - 14 * 86400_000;
  const minCostUsd = options.minCostUsd ?? 1;
  const limit = options.limit ?? 10;

  const sessions = getUntaggedSessionsSince(db, sinceMs, minCostUsd, limit);
  if (sessions.length === 0) {
    console.log(
      green(
        'Nothing to tag — all recent sessions are tagged or below the cost threshold.',
      ),
    );
    return { tagged: 0, skipped: 0, quit: false };
  }

  const windowDays = Math.max(1, Math.round((Date.now() - sinceMs) / 86400000));
  console.log(
    dim(
      `Found ${sessions.length} untagged session${sessions.length === 1 ? '' : 's'} from the last ${windowDays} days (cost ≥ $${minCostUsd}).`,
    ),
  );

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let tagged = 0;
  let skipped = 0;
  let quit = false;

  try {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      const ctxCommitsRaw = getSessionContextCommits(
        db,
        s.session_id,
        s.project_hash,
        s.timestamp,
        s.timestamp + s.duration_ms,
      );
      const ctx = gatherSessionContext(db, s);
      console.log(renderSessionBlock(s, ctxCommitsRaw, ctx, i, sessions.length));

      let resolved = false;
      while (!resolved) {
        const raw = await promptOnce(rl, '  > ');
        const ch = raw.trim().toLowerCase().charAt(0);
        if (!(ch in KEY_TO_ACTION)) {
          console.log(yellow('  Please type one of: s / e / d / x / i / k / q'));
          continue;
        }
        const action = KEY_TO_ACTION[ch];
        if (action === 'info') {
          console.log(renderExtendedInfo(db, s, ctxCommitsRaw));
          console.log(renderTagMenu(s, ctx.projectName));
          continue;
        }
        if (action === 'quit') {
          quit = true;
          console.log(dim('  Stopping.'));
          resolved = true;
          break;
        }
        if (action === 'skip') {
          skipped++;
          resolved = true;
          continue;
        }
        setSessionTag(db, s.session_id, action);
        tagged++;
        console.log(green(`  Tagged: ${action}`));
        resolved = true;
      }
      if (quit) break;
    }
  } finally {
    rl.close();
  }

  return { tagged, skipped, quit };
}
