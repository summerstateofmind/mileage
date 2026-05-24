import * as readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import {
  getUntaggedSessionsSince,
  setSessionTag,
  UntaggedSession,
} from '../storage/db';
import { bold, dim, green, yellow, cyan } from '../render/ansi';
import type { SessionTag } from '../storage/types';

function fmtDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h${m.toString().padStart(2, '0')}m`;
}

function fmtDateTime(ms: number): string {
  const d = new Date(ms);
  const dateStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const hours = d.getHours().toString().padStart(2, '0');
  const mins = d.getMinutes().toString().padStart(2, '0');
  return `${dateStr} ${hours}:${mins}`;
}

function shortModel(modelId: string): string {
  return modelId.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

const KEY_TO_TAG: Record<string, SessionTag | 'skip' | 'quit'> = {
  s: 'shipped',
  e: 'exploring',
  d: 'debugging',
  x: 'dead-end',
  k: 'skip',
  q: 'quit',
};

function promptOnce(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function renderSessionHeader(s: UntaggedSession, idx: number, total: number): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(bold(`Session ${idx + 1} of ${total}`));
  lines.push(`  ${fmtDateTime(s.timestamp)} · ${shortModel(s.model_id)} · ${fmtDuration(s.duration_ms)} · $${s.cost_usd.toFixed(2)} · ${s.attr_count} commit${s.attr_count === 1 ? '' : 's'}`);
  lines.push('');
  lines.push('  What happened?');
  lines.push(`    ${cyan('[s]')} shipped     · this session produced working, kept-around output`);
  lines.push(`    ${cyan('[e]')} exploring   · research / learning / not meant to ship`);
  lines.push(`    ${cyan('[d]')} debugging   · figuring something out`);
  lines.push(`    ${cyan('[x]')} dead-end    · tried, didn't work, walked away`);
  lines.push(`    ${cyan('[k]')} skip        · don't tag this one now`);
  lines.push(`    ${cyan('[q]')} quit        · stop tagging`);
  return lines.join('\n');
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
    console.log(green('Nothing to tag — all recent sessions are tagged or below the cost threshold.'));
    return { tagged: 0, skipped: 0, quit: false };
  }

  console.log(
    dim(
      `Found ${sessions.length} untagged session${sessions.length === 1 ? '' : 's'} from the last 14 days (cost ≥ $${minCostUsd}).`,
    ),
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let tagged = 0;
  let skipped = 0;
  let quit = false;

  try {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i];
      console.log(renderSessionHeader(s, i, sessions.length));

      let answer = '';
      while (!(answer in KEY_TO_TAG)) {
        const raw = await promptOnce(rl, '  > ');
        answer = raw.trim().toLowerCase().charAt(0);
        if (!(answer in KEY_TO_TAG)) {
          console.log(yellow('  Please type one of: s / e / d / x / k / q'));
        }
      }

      const action = KEY_TO_TAG[answer];
      if (action === 'quit') {
        quit = true;
        console.log(dim('  Stopping.'));
        break;
      }
      if (action === 'skip') {
        skipped++;
        continue;
      }
      setSessionTag(db, s.session_id, action);
      tagged++;
      console.log(green(`  Tagged: ${action}`));
    }
  } finally {
    rl.close();
  }

  return { tagged, skipped, quit };
}
