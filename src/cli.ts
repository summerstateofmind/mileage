#!/usr/bin/env node
process.removeAllListeners('warning');

import { Command } from 'commander';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import { openDb, getLastSyncMs, setLastSyncMs, upsertProject, getKnownProjects } from './storage/db';
import { ingestClaudeCode } from './ingest/claude_code';
import { ingestGit } from './ingest/git';
import { attributeDirect, attributeInferred } from './ingest/attribution';
import { selectReposToSync } from './ingest/repo_selection';
import { computeSnapshotsSince } from './compute/ypt';
import { updateSurvivalForCwd } from './compute/survival';
import { renderLast7Days, renderExplain } from './render/show';
import { renderWeeklyReport } from './render/report';
import { renderHeatmap } from './render/heatmap';
import { projectHashFromCwd } from './storage/paths';
import { readConfig, setPlan, VALID_PLANS, addExcludedRepo, removeExcludedRepo, setJudgeEnabled, setJudgeCloud } from './config/plan';
import { runJudgePass } from './judge/run_pass';
import { completionScript } from './cli/completion';
import { selectJudgeModel } from './judge/detect';
import { purgeVerdicts, getAllVerdicts, getProjectNameMap } from './storage/db';
import * as readline from 'node:readline';
import { runTagFlow } from './cli/tag';
import { runReviewFlow } from './cli/review';
import { installPostCommitHook, uninstallPostCommitHook } from './cli/hook';
import { runFirstRunWizard, needsFirstRun } from './cli/first_run';
import { bold, cyan, dim, green, magenta, red, yellow } from './render/ansi';
import { computeUsageCheck, fmtMsDuration } from './compute/usage';
import { buildShowJson } from './render/show_json';
import type { Plan } from './storage/types';

const AUTO_SYNC_STALENESS_MS = 30 * 60_000;

const program = new Command();

program
  .name('mileage')
  .version('0.1.0')
  .description('Measure your AI coding efficiency. YPT = Yield Per Token.')
  .enablePositionalOptions();

interface SyncOpts {
  since?: string;
  silent?: boolean;
}

function parseSince(s: string): number {
  const m = s.match(/^(\d+)([dh])$/);
  if (!m) throw new Error(`bad --since: ${s} (try 7d, 30d, 24h)`);
  const n = parseInt(m[1], 10);
  const mult = m[2] === 'd' ? 86_400_000 : 3_600_000;
  return Date.now() - n * mult;
}

function runSync(db: DatabaseSync, opts: SyncOpts): void {
  const sinceMs = parseSince(opts.since ?? '30d');
  const cwd = process.cwd();
  const projectHash = projectHashFromCwd(cwd);
  // Record this project so 'By project' can show a real name.
  upsertProject(db, {
    project_hash: projectHash,
    name: path.basename(cwd.replace(/[\\/]+$/, '')) || cwd,
    path: cwd,
  });

  const cc = ingestClaudeCode(db, sinceMs);
  const cfg = readConfig();
  const known = getKnownProjects(db);
  const repos = selectReposToSync(known, cfg.excluded_repos);
  const excludedCount = known.length - repos.length;
  let gitCommits = 0;
  let survivalEvaluated = 0;
  for (const repo of repos) {
    gitCommits += ingestGit(db, repo.path, sinceMs, repo.project_hash).commitsIngested;
    survivalEvaluated += updateSurvivalForCwd(db, repo.path).evaluated;
  }
  const direct = attributeDirect(db, cc.toolCommitHints);
  const inferred = attributeInferred(db, sinceMs);
  const snaps = computeSnapshotsSince(db, sinceMs);
  setLastSyncMs(db, Date.now());

  if (opts.silent) return;

  console.log(
    `Synced ${cc.sessionsIngested} sessions across ${cc.filesScanned} JSONL files, ` +
      `git-scanned ${repos.length} repos${excludedCount > 0 ? ` (${excludedCount} excluded)` : ''}, ` +
      `${gitCommits} commits, ` +
      `${direct + inferred} attributions (${direct} direct, ${inferred} by time-window), ` +
      `${cc.rateLimitHitsIngested} rate-limit hits, ` +
      `${survivalEvaluated} survival evaluations, ` +
      `${snaps} snapshots`,
  );
  if (cc.parseErrors > 0) {
    console.warn(`  warning: ${cc.parseErrors} JSONL parse errors (skipped)`);
  }
  if (cc.skipped > 0) {
    console.warn(`  warning: ${cc.skipped} sessions skipped (zero tokens)`);
  }
  if (gitCommits === 0) {
    console.warn(
      `  note: no git commits ingested across ${repos.length} repos — none are git repos, or no recent activity`,
    );
  }
}

interface ShowOpts {
  project?: string;
  heatmap?: boolean;
  days?: number;
  calendarWeek?: boolean;
  showHelpHint?: boolean;
  json?: boolean;
}

function runShow(db: DatabaseSync, opts: ShowOpts): void {
  if (opts.json) {
    console.log(
      JSON.stringify(
        buildShowJson(
          db,
          opts.project,
          opts.days ?? 7,
          !!opts.calendarWeek,
        ),
        null,
        2,
      ),
    );
    return;
  }
  if (opts.heatmap) {
    console.log(renderHeatmap(db, opts.project));
    return;
  }
  console.log(
    renderLast7Days(
      db,
      opts.project,
      opts.days ?? 7,
      !!opts.calendarWeek,
    ),
  );
  if (opts.showHelpHint) {
    console.log(
      dim(
        '  `mileage --help` for all commands  ·  `mileage explain ypt` for the formula  ·  `mileage --all` for cross-project view',
      ),
    );
    console.log('');
  }
}

function isSyncStale(db: DatabaseSync): boolean {
  const last = getLastSyncMs(db);
  if (last === null) return true;
  return Date.now() - last > AUTO_SYNC_STALENESS_MS;
}

async function runBareCommand(opts: {
  noSync?: boolean;
  all?: boolean;
  days?: number;
  calendarWeek?: boolean;
}): Promise<void> {
  const db = openDb();
  try {
    if (needsFirstRun(db)) {
      await runFirstRunWizard(db, process.cwd(), {
        runSync: () => runSync(db, { since: '60d' }),
      });
      runShow(db, {
        days: opts.days,
        calendarWeek: opts.calendarWeek,
        showHelpHint: true,
      });
      return;
    }

    if (!opts.noSync && isSyncStale(db)) {
      const last = getLastSyncMs(db);
      const note = last === null ? 'no prior sync' : `${fmtAgo(Date.now() - last)} since last sync`;
      console.log(dim(`Auto-syncing (${note})...`));
      runSync(db, { since: '30d', silent: true });
      const cfgJudge = readConfig();
      if (cfgJudge.judge.enabled) {
        const now2 = Date.now();
        await runJudgePass(db, cfgJudge, now2 - 30 * 86400_000, now2, false);
      }
    }

    const projectFilter = opts.all ? undefined : autoProjectFilter(db);
    runShow(db, {
      project: projectFilter,
      days: opts.days,
      calendarWeek: opts.calendarWeek,
      showHelpHint: true,
    });
  } finally {
    db.close();
  }
}

function autoProjectFilter(db: DatabaseSync): string | undefined {
  const cwd = process.cwd();
  const cwdHash = projectHashFromCwd(cwd);
  const known = getKnownProjects(db);
  const cwdNorm = normalizePathForCompare(cwd);

  // If cwd has tracked descendants, the user's intent is "show everything under
  // here" — do not narrow to the cwd itself even if it happens to be tracked.
  const hasChildren = known.some((p) => {
    const pNorm = normalizePathForCompare(p.path);
    if (pNorm === cwdNorm) return false;
    return pNorm.startsWith(cwdNorm + '/') || pNorm.startsWith(cwdNorm + '\\');
  });
  if (hasChildren) return undefined;

  if (known.some((p) => p.project_hash === cwdHash)) return cwdHash;
  return undefined;
}

function normalizePathForCompare(p: string): string {
  const stripped = p.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped;
}

function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

program
  .option('--no-sync', "don't auto-sync even if data looks stale")
  .option('--all', 'show data from all projects (default: filter to current dir if known)')
  .option('--days <n>', 'rolling window in days (default 7)', (v) => parseInt(v, 10))
  .option('--week', 'this calendar week (Mon–Sun, partial through today)')
  .option('--month', 'rolling last 30 days')
  .action(async (opts) => {
    const days = opts.month ? 30 : opts.days;
    await runBareCommand({
      noSync: opts.sync === false,
      all: !!opts.all,
      days,
      calendarWeek: !!opts.week,
    });
  });

program
  .command('init')
  .description('Re-run the first-time setup wizard (plan, sync, hook offer)')
  .action(async () => {
    const db = openDb();
    try {
      await runFirstRunWizard(db, process.cwd(), {
        runSync: () => runSync(db, { since: '60d' }),
      });
      runShow(db, {});
    } finally {
      db.close();
    }
  });

program
  .command('sync')
  .description('Ingest Claude Code sessions + git commits and compute snapshots')
  .option('--since <duration>', 'how far back to sync (e.g. 7d, 30d, 24h)', '30d')
  .option('--silent', 'no output unless there is an error', false)
  .action(async (opts) => {
    const db = openDb();
    try {
      runSync(db, opts as SyncOpts);
      const cfgJudge = readConfig();
      if (cfgJudge.judge.enabled) {
        const now = Date.now();
        await runJudgePass(db, cfgJudge, now - 30 * 86400_000, now, false);
      }
    } finally {
      db.close();
    }
  });

program
  .command('show')
  .description('Print recent spend, outcomes, and supporting metrics')
  .option('--project <hash>', 'restrict to one project hash')
  .option('--all', 'show data from all projects (default in `show`)')
  .option('--heatmap', 'render the 90-day efficiency heatmap')
  .option('--days <n>', 'rolling window in days (default 7)', (v) => parseInt(v, 10))
  .option('--week', 'this calendar week (Mon–Sun, partial through today)')
  .option('--month', 'rolling last 30 days')
  .option('--json', 'output structured JSON (machine-readable; for skills, MCP, scripts)')
  .action((opts) => {
    const db = openDb();
    try {
      const days = opts.month ? 30 : opts.days;
      runShow(db, {
        project: opts.project,
        heatmap: !!opts.heatmap,
        days,
        calendarWeek: !!opts.week,
        json: !!opts.json,
      });
    } finally {
      db.close();
    }
  });

program
  .command('check')
  .description('Token volume in the rolling 5h/7d windows + heavy-day baseline (run /usage for exact cap %)')
  .option('--json', 'output structured JSON')
  .action((opts) => {
    const db = openDb();
    try {
      const cfg = readConfig();
      const usage = computeUsageCheck(db, cfg.plan);
      if (opts.json) {
        console.log(JSON.stringify(usage, null, 2));
        return;
      }
      renderUsageCheck(usage);
    } finally {
      db.close();
    }
  });

function renderUsageCheck(usage: ReturnType<typeof computeUsageCheck>): void {
  // No estimated cap % here: Anthropic's real limit accounting is unpublished and
  // weights cache tokens, so any % we showed would only contradict `/usage`. We
  // surface the honest local signals — token volume + heavy-day baseline — and
  // defer the cap % to /usage, which reads Anthropic's server-side truth.
  const lines: string[] = [];
  lines.push('');
  lines.push(bold('Mileage cap check') + dim('  ·  plan: ' + usage.plan));
  lines.push('');
  for (const win of [usage.five_hour, usage.seven_day]) {
    const reset =
      win.ms_until_reset === null
        ? ''
        : dim('  · window resets in ~' + fmtMsDuration(win.ms_until_reset));
    lines.push(
      `  ${win.window_label.padEnd(4)} ${win.tokens_used.toLocaleString().padStart(13)} tokens used${reset}`,
    );
  }
  lines.push('');
  if (usage.baseline.typical_heavy_day_tokens !== null) {
    lines.push(
      dim(
        `  Today: ${usage.baseline.today_tokens.toLocaleString()} tokens  ·  your typical heavy day (p90, last 30d): ${usage.baseline.typical_heavy_day_tokens.toLocaleString()}`,
      ),
    );
    lines.push('');
  }
  lines.push(
    '  ' + magenta(bold('→')) + ' For exact, live cap usage, run ' + bold('/usage') + ' inside Claude Code.',
  );
  lines.push(
    dim(
      "    Mileage tracks your token volume and when you hit the wall — not Anthropic's cap %, which only /usage reads accurately.",
    ),
  );
  lines.push('');
  console.log(lines.join('\n'));
}

program
  .command('heatmap')
  .description('Render the 90-day efficiency heatmap')
  .option('--project <hash>', 'restrict to one project hash')
  .action((opts) => {
    const db = openDb();
    try {
      console.log(renderHeatmap(db, opts.project));
    } finally {
      db.close();
    }
  });

program
  .command('projects')
  .description('List known projects (hash, name, path, last seen)')
  .action(() => {
    const db = openDb();
    try {
      const rows = getKnownProjects(db);
      if (rows.length === 0) {
        console.log('No projects recorded yet. Run `mileage sync` from a repo.');
        return;
      }
      const nameW = Math.min(32, Math.max(...rows.map((r) => r.name.length)));
      console.log('');
      console.log(
        '  ' +
          'NAME'.padEnd(nameW) +
          '  ' +
          'HASH'.padEnd(12) +
          '  LAST SEEN            PATH',
      );
      for (const r of rows) {
        const when = new Date(r.last_seen).toISOString().slice(0, 16).replace('T', ' ');
        console.log(
          '  ' +
            r.name.padEnd(nameW) +
            '  ' +
            r.project_hash.slice(0, 12).padEnd(12) +
            '  ' +
            when +
            '     ' +
            r.path,
        );
      }
      console.log('');
    } finally {
      db.close();
    }
  });

program
  .command('tag')
  .description('Interactive: tag your recent sessions (shipped / exploring / debugging / dead-end)')
  .option('--since <duration>', 'how far back to consider (e.g. 14d)', '14d')
  .option('--min-cost <usd>', 'min session cost to consider (default $1)', '1')
  .option('--limit <n>', 'max sessions to walk through', '10')
  .action(async (opts) => {
    const db = openDb();
    const sinceMs = parseSince(opts.since);
    const result = await runTagFlow(db, {
      sinceMs,
      minCostUsd: parseFloat(opts.minCost),
      limit: parseInt(opts.limit, 10),
    });
    console.log(
      `\nTagged ${result.tagged}, skipped ${result.skipped}${result.quit ? ' (quit early)' : ''}.`,
    );
    db.close();
  });

program
  .command('review')
  .description('Interactive: walk through your top expensive sessions and reflect')
  .option('--days <n>', 'window in days', '7')
  .action(async (opts) => {
    const db = openDb();
    const result = await runReviewFlow(db, { windowDays: parseInt(opts.days, 10) });
    console.log(`\nReviewed ${result.reviewed} sessions.`);
    db.close();
  });

program
  .command('report')
  .description('Generate copy-pasteable weekly markdown report')
  .option('--week', 'last 7 days (default)')
  .option('--month', 'last 30 days')
  .action((opts) => {
    const db = openDb();
    const days = opts.month ? 30 : 7;
    console.log(renderWeeklyReport(db, days));
    db.close();
  });

program
  .command('install-hook')
  .description('Install a git post-commit hook in the current repo that auto-syncs Mileage')
  .action(() => {
    const r = installPostCommitHook(process.cwd());
    console.log(r.message);
    process.exit(r.installed || r.alreadyPresent ? 0 : 1);
  });

program
  .command('uninstall-hook')
  .description('Remove the Mileage post-commit hook from the current repo')
  .action(() => {
    const r = uninstallPostCommitHook(process.cwd());
    console.log(r.message);
    process.exit(r.removed ? 0 : 1);
  });

program
  .command('explain <metric>')
  .description('Show formula, inputs, and academic source for a metric (try: ypt)')
  .action((metric) => {
    const db = openDb();
    console.log(renderExplain(db, metric));
    db.close();
  });

program
  .command('config')
  .description('Show current Mileage config')
  .action(() => {
    console.log(JSON.stringify(readConfig(), null, 2));
  });

program
  .command('config:set-plan <plan>')
  .description('Set your plan: ' + VALID_PLANS.join(' | '))
  .action((plan: string) => {
    if (!VALID_PLANS.includes(plan as Plan)) {
      console.error(`Invalid plan "${plan}". Choose: ${VALID_PLANS.join(', ')}`);
      process.exit(1);
    }
    const cfg = setPlan(plan as Plan);
    console.log(
      `Plan set to "${cfg.plan}". Run \`mileage show\` to see updated framing.`,
    );
  });

program
  .command('judge:enable')
  .description('Turn on the local session-intent judge (opt-in; reads prompts + trajectory)')
  .action(async () => {
    const cfg = readConfig();
    const model = await selectJudgeModel({ ...cfg, judge: { ...cfg.judge, enabled: true } });
    console.log(
      '\n' + bold('Enabling the session-intent judge') + '\n' +
      '  Reads: your PROMPTS + tool-action metadata (counts, file paths, errors) for\n' +
      '         high-effort no-commit "research" sessions only. NOT code, diffs, or\n' +
      '         assistant prose.\n' +
      `  Runs:  ${model.kind === 'off' ? red('no model available — ' + model.reason) : model.kind + ' (' + model.model + ')'}\n` +
      '  Stores: verdict + confidence + a short reason, on THIS machine only.\n' +
      '  Leaves machine: nothing (local). Cloud opt-in (if set) sends prompts+trajectory only.\n',
    );
    if (model.kind === 'off') {
      console.log(dim('  To use a local model: install Ollama (https://ollama.com), then `ollama pull qwen2.5:3b`.'));
      console.log(dim('  Or configure cloud: `mileage judge:set-cloud <endpoint> <model>` + set MILEAGE_JUDGE_API_KEY.\n'));
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((res) => rl.question('Enable the judge? [y/N]: ', res));
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log('Not enabled.');
      return;
    }
    setJudgeEnabled(true);
    console.log(green('Judge enabled.') + ' Run `mileage judge`, or it runs during sync.');
  });

program
  .command('judge:disable')
  .description('Turn off the judge and purge all cached verdicts')
  .action(() => {
    const db = openDb();
    try {
      setJudgeEnabled(false);
      purgeVerdicts(db);
      console.log('Judge disabled; cached verdicts purged.');
    } finally {
      db.close();
    }
  });

program
  .command('judge:set-cloud <endpoint> <model>')
  .description('Configure + enable the cloud judge opt-in; API key from MILEAGE_JUDGE_API_KEY')
  .action((endpoint: string, model: string) => {
    setJudgeCloud({ enabled: true, endpoint, model });
    console.log(`Cloud judge set: ${model} @ ${endpoint}. Set MILEAGE_JUDGE_API_KEY in your env.`);
  });

program
  .command('judge:list')
  .description('Review session-intent judge verdicts (most confident first)')
  .action(() => {
    const db = openDb();
    try {
      const rows = getAllVerdicts(db);
      if (rows.length === 0) {
        console.log(dim('No verdicts yet. Run `mileage judge` first (needs a model configured).'));
        return;
      }
      const names = getProjectNameMap(db);
      const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const fmtWhen = (ts: number | null): string => {
        if (ts === null) return '—';
        const d = new Date(ts);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hh}:${mm}`;
      };
      const projOf = (h: string | null): string => (h ? (names.get(h) ?? h.slice(0, 8)) : '—');
      const tierColor = (t: string) => {
        if (t === 'high') return (s: string) => bold(green(s));
        if (t === 'solid') return green;
        if (t === 'thin') return yellow;
        if (t === 'stalled') return red;
        return dim;
      };
      const W = { when: 14, proj: 14, tier: 10, conf: 6 };
      const lines: string[] = [
        '',
        bold('Session yield verdicts') + dim(`  ·  ${rows.length} judged`),
        '',
        dim(
          '  ' +
            'When'.padEnd(W.when) +
            'Project'.padEnd(W.proj) +
            'Tier'.padEnd(W.tier) +
            'Conf'.padEnd(W.conf) +
            'Why',
        ),
      ];
      for (const r of rows) {
        const color = tierColor(r.tier);
        const when = fmtWhen(r.start_ts).padEnd(W.when);
        const proj = projOf(r.project_hash).slice(0, W.proj - 1).padEnd(W.proj);
        const tier = r.tier.padEnd(W.tier);
        const conf = `${(r.confidence * 100).toFixed(0)}%`.padEnd(W.conf);
        lines.push(`  ${dim(when)}${dim(proj)}${color(tier)}${dim(conf)}${r.rationale ?? ''}`);
      }
      lines.push(
        '',
        dim('  high = focused progress · solid = good session · thin = some progress · stalled = stuck/looping'),
        '',
      );
      console.log(lines.join('\n'));
    } finally {
      db.close();
    }
  });

program
  .command('judge')
  .description('Run a judging pass over high-effort no-commit sessions (last 30 days)')
  .option('--refresh', 're-judge sessions even if already cached', false)
  .action(async (opts) => {
    const db = openDb();
    try {
      const cfg = readConfig();
      if (!cfg.judge.enabled) {
        console.log('Judge is off. Enable it with `mileage judge:enable`.');
        return;
      }
      const now = Date.now();
      const r = await runJudgePass(db, cfg, now - 30 * 86400_000, now, !!opts.refresh);
      if (r.skipped_unavailable) {
        console.log(yellow('No model available: ') + r.model);
      } else {
        console.log(`Judged ${r.judged} session(s) with ${r.model}.`);
        if (r.judged > 0) console.log(dim('Review them with `mileage judge:list`.'));
      }
    } finally {
      db.close();
    }
  });

program
  .command('config:exclude-repo <path>')
  .description('Exclude a repo from git scanning during sync (its metadata is never read)')
  .action((p: string) => {
    const cfg = addExcludedRepo(p);
    console.log(`Excluded "${p}". ${cfg.excluded_repos.length} repo(s) now excluded from sync.`);
  });

program
  .command('config:unexclude-repo <path>')
  .description('Remove a repo from the sync exclude list')
  .action((p: string) => {
    const cfg = removeExcludedRepo(p);
    console.log(`Removed "${p}". ${cfg.excluded_repos.length} repo(s) still excluded.`);
  });

program
  .command('debug:list-projects')
  .description('Dump known project hashes with event counts')
  .action(() => {
    const db = openDb();
    const rows = db
      .prepare(
        `SELECT project_hash,
                SUM(CASE WHEN type='session' THEN 1 ELSE 0 END) AS sessions,
                SUM(CASE WHEN type='commit' THEN 1 ELSE 0 END) AS commits,
                SUM(CASE WHEN type='session' THEN COALESCE(tokens_in,0)+COALESCE(tokens_out,0) ELSE 0 END) AS tokens
         FROM events GROUP BY project_hash ORDER BY tokens DESC`,
      )
      .all();
    console.table(rows);
    db.close();
  });

program
  .command('completion <shell>')
  .description('Print a shell completion script (shell: pwsh | bash | zsh)')
  .action((shell: string) => {
    const script = completionScript(
      shell,
      program.commands.map((c) => c.name()),
    );
    if (!script) {
      console.error(`Unknown shell "${shell}". Use: pwsh | bash | zsh.`);
      process.exitCode = 1;
      return;
    }
    console.log(script);
  });

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
