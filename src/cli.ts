#!/usr/bin/env node
process.removeAllListeners('warning');

import { Command } from 'commander';
import { openDb } from './storage/db';
import { ingestClaudeCode } from './ingest/claude_code';
import { ingestGit } from './ingest/git';
import { attributeDirect, attributeInferred } from './ingest/attribution';
import { computeSnapshotsSince } from './compute/ypt';
import { updateSurvivalForCwd } from './compute/survival';
import { renderLast7Days, renderExplain } from './render/show';
import { renderWeeklyReport } from './render/report';
import { renderHeatmap } from './render/heatmap';
import { projectHashFromCwd } from './storage/paths';
import { readConfig, setPlan, VALID_PLANS } from './config/plan';
import { runTagFlow } from './cli/tag';
import { runReviewFlow } from './cli/review';
import { installPostCommitHook, uninstallPostCommitHook } from './cli/hook';
import type { Plan } from './storage/types';

const program = new Command();

program
  .name('mileage')
  .version('0.1.0')
  .description('Measure your AI coding efficiency. YPT = Yield Per Token.');

program
  .command('sync')
  .description('Ingest Claude Code sessions + git commits and compute snapshots')
  .option('--since <duration>', 'how far back to sync (e.g. 7d, 30d, 24h)', '30d')
  .action((opts) => {
    const sinceMs = parseSince(opts.since);
    const db = openDb();
    const cwd = process.cwd();
    const projectHash = projectHashFromCwd(cwd);

    const cc = ingestClaudeCode(db, sinceMs);
    const git = ingestGit(db, cwd, sinceMs, projectHash);
    const direct = attributeDirect(db, cc.toolCommitHints);
    const inferred = attributeInferred(db, sinceMs);
    const survival = updateSurvivalForCwd(db, cwd);
    const snaps = computeSnapshotsSince(db, sinceMs);

    console.log(
      `Synced ${cc.sessionsIngested} sessions across ${cc.filesScanned} JSONL files, ` +
        `${git.commitsIngested} commits, ` +
        `${direct + inferred} attributions (${direct} direct, ${inferred} inferred), ` +
        `${cc.rateLimitHitsIngested} rate-limit hits, ` +
        `${survival.evaluated} survival evaluations, ` +
        `${snaps} snapshots`,
    );
    if (cc.parseErrors > 0) {
      console.warn(`  warning: ${cc.parseErrors} JSONL parse errors (skipped)`);
    }
    if (cc.skipped > 0) {
      console.warn(`  warning: ${cc.skipped} sessions skipped (zero tokens)`);
    }
    if (git.commitsIngested === 0) {
      console.warn(
        `  note: no git commits ingested from ${cwd} — not a repo, or no recent activity`,
      );
    }
    db.close();
  });

program
  .command('show')
  .description('Print recent spend, outcomes, and supporting metrics')
  .option('--project <hash>', 'restrict to one project hash')
  .option('--heatmap', 'render the 90-day efficiency heatmap')
  .action((opts) => {
    const db = openDb();
    if (opts.heatmap) {
      console.log(renderHeatmap(db, opts.project));
    } else {
      console.log(renderLast7Days(db, opts.project));
    }
    db.close();
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
  .description(
    'Set your plan: ' + VALID_PLANS.join(' | '),
  )
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

program.parseAsync(process.argv).catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

function parseSince(s: string): number {
  const m = s.match(/^(\d+)([dh])$/);
  if (!m) throw new Error(`bad --since: ${s} (try 7d, 30d, 24h)`);
  const n = parseInt(m[1], 10);
  const mult = m[2] === 'd' ? 86_400_000 : 3_600_000;
  return Date.now() - n * mult;
}
