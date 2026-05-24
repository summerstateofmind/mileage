import * as readline from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { readConfig, setPlan, VALID_PLANS, planDisplayName } from '../config/plan';
import { getLastSyncMs } from '../storage/db';
import type { Plan } from '../storage/types';
import { bold, dim, green, yellow, cyan } from '../render/ansi';
import { installPostCommitHook, isGitRepo } from './hook';

const PLAN_CHOICES: { key: string; plan: Plan; label: string }[] = [
  { key: '1', plan: 'api', label: 'Claude API (pay-per-token)' },
  { key: '2', plan: 'pro', label: 'Claude Pro ($20/mo)' },
  { key: '3', plan: 'max-100', label: 'Claude Max — 5× ($100/mo)' },
  { key: '4', plan: 'max-200', label: 'Claude Max — 20× ($200/mo)' },
  { key: '5', plan: 'cursor-pro', label: 'Cursor Pro' },
  { key: '6', plan: 'copilot', label: 'GitHub Copilot' },
  { key: '7', plan: 'unknown', label: 'Skip / decide later' },
];

function prompt(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

function renderPlanMenu(): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(bold('What plan are you on?'));
  for (const c of PLAN_CHOICES) {
    lines.push(`  ${cyan('[' + c.key + ']')} ${c.label}`);
  }
  return lines.join('\n');
}

async function pickPlan(rl: readline.Interface): Promise<Plan> {
  console.log(renderPlanMenu());
  while (true) {
    const raw = await prompt(rl, '  > ');
    const k = raw.trim().toLowerCase();
    const found = PLAN_CHOICES.find((c) => c.key === k);
    if (found) return found.plan;
    // Also accept the plan name directly for power users.
    if ((VALID_PLANS as readonly string[]).includes(k)) return k as Plan;
    console.log(yellow(`  Pick a number 1–${PLAN_CHOICES.length}.`));
  }
}

async function yesNo(
  rl: readline.Interface,
  q: string,
  defaultYes: boolean = true,
): Promise<boolean> {
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const raw = (await prompt(rl, q + suffix)).trim().toLowerCase();
  if (raw === '') return defaultYes;
  return raw.startsWith('y');
}

export interface FirstRunResult {
  planSet: Plan;
  hookOffered: boolean;
  hookInstalled: boolean;
  hookSkippedReason?: 'not-a-repo' | 'user-declined' | 'already-present';
}

export interface FirstRunDeps {
  runSync: () => Promise<void> | void;
}

/**
 * Interactive first-run flow. Caller provides the sync action so this module
 * doesn't have to know how a real sync is wired.
 */
export async function runFirstRunWizard(
  db: DatabaseSync,
  cwd: string,
  deps: FirstRunDeps,
): Promise<FirstRunResult> {
  console.log('');
  console.log(bold('👋 Welcome to Mileage.') + dim('  Quick setup (30 seconds).'));
  console.log(
    dim(
      "  Mileage reads your Claude Code session logs and your git history, locally.\n" +
        "  Nothing leaves your machine.",
    ),
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let plan: Plan = 'unknown';
  let hookOffered = false;
  let hookInstalled = false;
  let hookSkippedReason: FirstRunResult['hookSkippedReason'];

  try {
    plan = await pickPlan(rl);
    setPlan(plan);
    console.log(green(`  ✓ Plan: ${planDisplayName(plan)}`));

    console.log('');
    console.log(dim('  Syncing your Claude Code data — first run can take a minute…'));
    await deps.runSync();

    if (!isGitRepo(cwd)) {
      hookSkippedReason = 'not-a-repo';
      console.log('');
      console.log(
        dim(
          `  Tip: from any of your git repos, run \`mileage install-hook\` to auto-sync on every commit.`,
        ),
      );
    } else {
      hookOffered = true;
      const wantHook = await yesNo(
        rl,
        '\n  Install a git post-commit hook here so Mileage auto-syncs on every commit?',
        true,
      );
      if (wantHook) {
        const r = installPostCommitHook(cwd);
        if (r.installed) {
          hookInstalled = true;
          console.log(green(`  ✓ Hook installed: ${r.path}`));
        } else if (r.alreadyPresent) {
          hookInstalled = true;
          hookSkippedReason = 'already-present';
          console.log(dim(`  Hook was already installed.`));
        } else {
          console.log(yellow(`  ⚠ ${r.message}`));
        }
      } else {
        hookSkippedReason = 'user-declined';
        console.log(
          dim(`  Skipped. You can install it later with \`mileage install-hook\`.`),
        );
      }
    }
  } finally {
    rl.close();
  }

  console.log('');
  console.log(bold('─'.repeat(60)));
  return {
    planSet: plan,
    hookOffered,
    hookInstalled,
    hookSkippedReason,
  };
}

/**
 * Heuristic for whether a user needs the first-run wizard.
 * True if no config file exists, OR if it does but plan is still 'unknown'
 * AND we have no prior sync recorded.
 */
export function needsFirstRun(db: DatabaseSync): boolean {
  const cfg = readConfig();
  if (cfg.plan !== 'unknown') return false;
  return getLastSyncMs(db) === null;
}
