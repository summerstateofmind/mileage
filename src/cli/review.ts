import * as readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { getTopExpensiveSessions, setSessionTag, getSessionTag } from '../storage/db';
import { bold, dim, green, yellow, cyan } from '../render/ansi';
import type { SessionTag } from '../storage/types';

const MS_PER_DAY = 86_400_000;

function fmtDuration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${(m % 60).toString().padStart(2, '0')}m`;
}

function fmtWeekdayTime(ms: number): string {
  const d = new Date(ms);
  const w = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${w} ${hh}:${mm}`;
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-\d{8,}$/, '');
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

const TAG_KEYS: Record<string, SessionTag | 'skip'> = {
  s: 'shipped',
  e: 'exploring',
  d: 'debugging',
  x: 'dead-end',
  k: 'skip',
};

export async function runReviewFlow(
  db: DatabaseSync,
  options: { windowDays?: number } = {},
): Promise<{ reviewed: number }> {
  const days = options.windowDays ?? 7;
  const sinceMs = Date.now() - days * MS_PER_DAY;
  const top = getTopExpensiveSessions(db, sinceMs, 5);

  if (top.length === 0) {
    console.log(dim(`No sessions in the last ${days} days. Run \`mileage sync\` from a repo you've used Claude Code in.`));
    return { reviewed: 0 };
  }

  console.log('');
  console.log(bold(`Mileage review — last ${days} days`));
  console.log(dim(`Walking through your top ${top.length} expensive sessions. Be honest with yourself.`));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let reviewed = 0;

  try {
    for (let i = 0; i < top.length; i++) {
      const s = top[i];
      const existing = getSessionTag(db, s.session_id);
      console.log('');
      console.log(bold(`${i + 1}. ${fmtWeekdayTime(s.timestamp)}`) + dim(` · ${shortModel(s.model_id)} · ${fmtDuration(s.duration_ms)} · $${s.cost_usd.toFixed(2)} · ${s.attr_count} commit${s.attr_count === 1 ? '' : 's'}`));
      if (existing) {
        console.log(dim(`   Already tagged: ${existing.tag}.`));
        const overwrite = (await ask(rl, '   Re-tag? [y/N] ')).trim().toLowerCase();
        if (overwrite !== 'y') continue;
      }
      console.log('   Was this session worth it?');
      console.log(`     ${cyan('[s]')} shipped  ${cyan('[e]')} exploring  ${cyan('[d]')} debugging  ${cyan('[x]')} dead-end  ${cyan('[k]')} skip`);
      let key = '';
      while (!(key in TAG_KEYS)) {
        const raw = await ask(rl, '   > ');
        key = raw.trim().toLowerCase().charAt(0);
        if (!(key in TAG_KEYS)) console.log(yellow('   Type one of: s / e / d / x / k'));
      }
      const action = TAG_KEYS[key];
      if (action === 'skip') continue;
      setSessionTag(db, s.session_id, action);
      reviewed++;
      console.log(green(`   Tagged: ${action}`));
    }
  } finally {
    rl.close();
  }
  console.log('');
  return { reviewed };
}
