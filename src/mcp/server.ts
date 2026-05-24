#!/usr/bin/env node
process.removeAllListeners('warning');

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, getKnownProjects, setSessionTag } from '../storage/db';
import { readConfig } from '../config/plan';
import { buildShowJson } from '../render/show_json';
import { computeUsageCheck } from '../compute/usage';
import { getSurvivalSummariesSince } from '../compute/survival';
import { computeTierFlex } from '../compute/tier_flex';
import { detectPatterns } from '../compute/patterns';
import { getTopExpensiveSessions, getRateLimitHitsSince } from '../storage/db';
import { renderExplain } from '../render/show';
import type { SessionTag } from '../storage/types';

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function textContent(value: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: value,
      },
    ],
  };
}

async function main(): Promise<void> {
  const server = new McpServer(
    { name: 'mileage', version: '0.3.0' },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.registerTool(
    'show',
    {
      title: 'Mileage dashboard (JSON)',
      description:
        'Get the current Mileage dashboard as structured JSON: spend, outcomes, top sessions, tier-flex audit, patterns, survival, cap usage. Use this whenever the user asks about their AI tool spend, token usage, YPT, or coding efficiency.',
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe('Project hash to filter to. Omit for all-projects view.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Rolling window in days. Default 7.'),
        calendar_week: z
          .boolean()
          .optional()
          .describe('If true, scope to this calendar week (Mon-Sun, partial). Overrides days.'),
      },
    },
    async (args) => {
      const db = openDb();
      try {
        const data = buildShowJson(
          db,
          args.project,
          args.days ?? 7,
          !!args.calendar_week,
        );
        return jsonContent(data);
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'usage_check',
    {
      title: 'Cap usage check',
      description:
        'Check current 5-hour and 7-day rolling token usage vs the estimated plan cap. Returns a warning level (ok / soft / strong / over) and a recommended action. Cap estimates are community-approximated; for live exact cap use, run `/usage` in Claude Code. Call this BEFORE starting an expensive request to avoid hitting the cap mid-task.',
    },
    async () => {
      const db = openDb();
      try {
        const cfg = readConfig();
        return jsonContent(computeUsageCheck(db, cfg.plan));
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'explain_ypt',
    {
      title: 'Explain YPT',
      description:
        'Get the YPT (Yield Per Token) formula, current calibration, latest snapshot inputs, per-model breakdown, and sources. Plain-text human-readable.',
    },
    async () => {
      const db = openDb();
      try {
        const out = renderExplain(db, 'ypt');
        return textContent(out);
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'top_sessions',
    {
      title: 'Top sessions',
      description:
        'Get the N most expensive sessions in a recent window. Useful for "show me my expensive sessions" or "what did I work on last weekend".',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Window in days. Default 7.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max sessions to return. Default 5.'),
        project: z.string().optional().describe('Project hash filter.'),
      },
    },
    async (args) => {
      const db = openDb();
      try {
        const sinceMs = Date.now() - (args.days ?? 7) * 86_400_000;
        const rows = getTopExpensiveSessions(
          db,
          sinceMs,
          args.limit ?? 5,
          args.project,
        );
        return jsonContent({ sessions: rows });
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'tier_flex',
    {
      title: 'Tier-flex audit',
      description:
        'Compare per-model yield rates (sessions with outcomes / total sessions) and average cost. Surfaces whether expensive models (Opus) are actually outperforming cheaper ones (Sonnet, Haiku). Use when the user asks "which model should I use" or "is Opus worth it".',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Window in days. Default 30.'),
      },
    },
    async (args) => {
      const db = openDb();
      try {
        const sinceMs = Date.now() - (args.days ?? 30) * 86_400_000;
        return jsonContent(computeTierFlex(db, sinceMs));
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'survival',
    {
      title: 'Code survival',
      description:
        'Get the share of AI-attributed lines still alive at 7d and 30d. Quality signal, file-level approximation. Returns null windows when no commits are old enough to evaluate.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Window in days for inclusion. Default 7.'),
        project: z.string().optional().describe('Project hash filter.'),
      },
    },
    async (args) => {
      const db = openDb();
      try {
        const sinceMs = Date.now() - (args.days ?? 7) * 86_400_000;
        return jsonContent(getSurvivalSummariesSince(db, sinceMs, args.project));
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'patterns',
    {
      title: 'Behavioral patterns',
      description:
        'Detect waste patterns and behavioral findings over the last 30 days: time-of-day yield, day-of-week cost, model-vs-outcome correlations, recurring expensive-zero-commit sessions.',
    },
    async () => {
      const db = openDb();
      try {
        return jsonContent({ patterns: detectPatterns(db, Date.now() - 30 * 86_400_000) });
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'projects',
    {
      title: 'Known projects',
      description:
        'List projects Mileage has seen, with hash, name, path, and last-seen timestamp.',
    },
    async () => {
      const db = openDb();
      try {
        return jsonContent({ projects: getKnownProjects(db) });
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'recent_waste',
    {
      title: 'Recent waste sessions',
      description:
        'Get recent sessions that cost above the waste threshold AND shipped zero attributed commits. Use proactively when the user mentions cost regret or wanting to clean up.',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Window in days. Default 14.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Max sessions. Default 10.'),
      },
    },
    async (args) => {
      const db = openDb();
      try {
        const cfg = readConfig();
        const sinceMs = Date.now() - (args.days ?? 14) * 86_400_000;
        const sessions = getTopExpensiveSessions(db, sinceMs, args.limit ?? 10);
        const waste = sessions.filter(
          (s) =>
            s.attr_count === 0 && s.cost_usd >= cfg.preferences.waste_threshold_usd,
        );
        return jsonContent({
          waste_threshold_usd: cfg.preferences.waste_threshold_usd,
          sessions: waste,
        });
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'rate_limit_hits',
    {
      title: 'Rate-limit hits',
      description:
        'Count of times the user got rate-limited by Anthropic in the given window. Hits include timestamps; useful when user asks "did I hit the cap this week".',
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe('Window in days. Default 7.'),
      },
    },
    async (args) => {
      const db = openDb();
      try {
        const sinceMs = Date.now() - (args.days ?? 7) * 86_400_000;
        const hits = getRateLimitHitsSince(db, sinceMs);
        return jsonContent({ count: hits.length, hits });
      } finally {
        db.close();
      }
    },
  );

  server.registerTool(
    'tag',
    {
      title: 'Tag a session',
      description:
        'Write a self-tag for a session: shipped / exploring / debugging / dead-end. Use ONLY after the user explicitly says how they want a session tagged. Do not infer tags without asking.',
      inputSchema: {
        session_id: z
          .string()
          .describe('Session id, e.g. from `top_sessions` or `recent_waste`.'),
        tag: z
          .enum(['shipped', 'exploring', 'debugging', 'dead-end'])
          .describe('The tag to apply.'),
      },
    },
    async (args) => {
      const db = openDb();
      try {
        setSessionTag(db, args.session_id, args.tag as SessionTag);
        return textContent(
          `Tagged session ${args.session_id} as "${args.tag}".`,
        );
      } finally {
        db.close();
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('mileage-mcp failed:', err);
  process.exit(1);
});
