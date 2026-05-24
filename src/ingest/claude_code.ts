import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import * as crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { claudeProjectsDir, projectHashFromPath } from '../storage/paths';
import { insertSession, insertRateLimitHit, upsertProject } from '../storage/db';
import { computeSessionCostUsd } from '../compute/cost';
import { PRICING_VERSION } from '../pricing/models';
import { detectRateLimitHit } from './rate_limits';
import type { SessionEvent, ToolCommitHint, RateLimitHit } from '../storage/types';

const SESSION_GAP_MS = 10 * 60_000;
const COMMIT_HASH_RE = /^\[\S+\s+(?:\(root-commit\)\s+)?([a-f0-9]{7,40})\]/m;

interface JsonlEntry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  requestId?: string;
  cwd?: string;
  toolUseResult?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  costUSD?: number;
}

export interface ParseResult {
  sessions: SessionEvent[];
  toolCommitHints: ToolCommitHint[];
  rateLimitHits: RateLimitHit[];
  projectsSeen: { project_hash: string; path: string }[];
  skipped: number;
  parseErrors: number;
}

export function parseJsonlFile(filePath: string, fallbackProjectHash: string): ParseResult {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  return parseJsonlLines(lines, fallbackProjectHash);
}

export function parseJsonlLines(lines: string[], fallbackProjectHash: string): ParseResult {
  let parseErrors = 0;
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      parseErrors++;
    }
  }

  type SessionGroup = {
    sessionId: string;
    entries: JsonlEntry[];
  };
  const groups = new Map<string, SessionGroup>();
  for (const e of entries) {
    if (!e.sessionId || !e.timestamp) continue;
    let g = groups.get(e.sessionId);
    if (!g) {
      g = { sessionId: e.sessionId, entries: [] };
      groups.set(e.sessionId, g);
    }
    g.entries.push(e);
  }

  const sessions: SessionEvent[] = [];
  const toolCommitHints: ToolCommitHint[] = [];
  const rateLimitHits: RateLimitHit[] = [];
  const projectsByHash = new Map<string, string>();
  let skipped = 0;

  for (const group of groups.values()) {
    const sorted = group.entries
      .map((e) => ({ e, t: Date.parse(e.timestamp as string) }))
      .filter((x) => Number.isFinite(x.t))
      .sort((a, b) => a.t - b.t);
    if (sorted.length === 0) continue;

    const logical: { entries: JsonlEntry[]; start: number; end: number }[] = [];
    let current: { entries: JsonlEntry[]; start: number; end: number } | null = null;
    for (const { e, t } of sorted) {
      if (!current || t - current.end > SESSION_GAP_MS) {
        if (current) logical.push(current);
        current = { entries: [e], start: t, end: t };
      } else {
        current.entries.push(e);
        current.end = t;
      }
    }
    if (current) logical.push(current);

    for (let idx = 0; idx < logical.length; idx++) {
      const seg = logical[idx];
      const baseId = `${group.sessionId}:${idx}`;
      const tok = accumulateTokens(seg.entries);
      const model = pickModel(seg.entries);
      const reportedCost = sumCost(seg.entries);
      const cwd = pickCwd(seg.entries);
      const segProjectHash = cwd ? projectHashFromPath(cwd) : fallbackProjectHash;
      if (cwd && !projectsByHash.has(segProjectHash)) {
        projectsByHash.set(segProjectHash, cwd);
      }

      const totalTok = tok.input + tok.cache_create + tok.cache_read + tok.output;
      if (totalTok === 0) {
        skipped++;
      } else {
        const computed = computeSessionCostUsd({
          input_tokens: tok.input,
          cache_creation_tokens: tok.cache_create,
          cache_read_tokens: tok.cache_read,
          output_tokens: tok.output,
          model_id: model,
        });
        const costUsd = reportedCost > 0 ? reportedCost : computed.total_usd;

        sessions.push({
          id: baseId,
          timestamp: seg.start,
          type: 'session',
          source: 'claude_code',
          project_hash: segProjectHash,
          session_id: baseId,
          tokens_in: tok.input + tok.cache_create,
          tokens_out: tok.output,
          cache_creation_tokens: tok.cache_create,
          cache_read_tokens: tok.cache_read,
          cost_usd: costUsd,
          pricing_version: PRICING_VERSION,
          pricing_fallback: computed.fallback,
          model_id: model,
          session_end_ms: seg.end,
        });
      }

      const hints = extractCommitHintsFromSegment(seg.entries, baseId);
      toolCommitHints.push(...hints);

      const hits = extractRateLimitHitsFromSegment(seg.entries, baseId);
      rateLimitHits.push(...hits);
    }
  }

  const projectsSeen = Array.from(projectsByHash, ([project_hash, path]) => ({
    project_hash,
    path,
  }));
  return { sessions, toolCommitHints, rateLimitHits, projectsSeen, skipped, parseErrors };
}

function extractRateLimitHitsFromSegment(
  entries: JsonlEntry[],
  sessionId: string,
): RateLimitHit[] {
  const hits: RateLimitHit[] = [];
  for (const e of entries) {
    const ts = Date.parse(e.timestamp as string);
    if (!Number.isFinite(ts)) continue;

    // toolUseResult is only populated on actual tool error responses; safe to scan
    if (typeof e.toolUseResult === 'string' && /error|fail/i.test(e.toolUseResult)) {
      const hit = detectRateLimitHit(e.toolUseResult, ts, sessionId);
      if (hit) hits.push(hit);
    }

    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Array<any>) {
      // Only scan explicit tool error results — never assistant text (which can contain
      // the literal phrase "rate limit" in conversation about rate limits).
      if (c?.type === 'tool_result' && c?.is_error === true) {
        const text =
          typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content)
              ? c.content
                  .map((x: any) => (typeof x?.text === 'string' ? x.text : ''))
                  .join(' ')
              : '';
        const hit = detectRateLimitHit(text, ts, sessionId);
        if (hit) hits.push(hit);
      }
    }
  }
  return hits;
}

function accumulateTokens(entries: JsonlEntry[]): {
  input: number;
  cache_create: number;
  cache_read: number;
  output: number;
} {
  const seenRequestIds = new Set<string>();
  let input = 0;
  let cache_create = 0;
  let cache_read = 0;
  let output = 0;
  for (const e of entries) {
    if (e.type !== 'assistant') continue;
    const reqId = e.requestId;
    if (!reqId || seenRequestIds.has(reqId)) continue;
    seenRequestIds.add(reqId);
    const u = e.message?.usage;
    if (!u) continue;
    input += u.input_tokens ?? 0;
    cache_create += u.cache_creation_input_tokens ?? 0;
    cache_read += u.cache_read_input_tokens ?? 0;
    output += u.output_tokens ?? 0;
  }
  return { input, cache_create, cache_read, output };
}

function pickModel(entries: JsonlEntry[]): string {
  for (const e of entries) {
    if (e.type === 'assistant' && e.message?.model) return e.message.model;
  }
  return 'unknown';
}

function pickCwd(entries: JsonlEntry[]): string | null {
  for (const e of entries) {
    if (typeof e.cwd === 'string' && e.cwd.length > 0) return e.cwd;
  }
  return null;
}

function sumCost(entries: JsonlEntry[]): number {
  let total = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (typeof e.costUSD === 'number' && e.requestId && !seen.has(e.requestId)) {
      seen.add(e.requestId);
      total += e.costUSD;
    }
  }
  return total;
}

function extractCommitHintsFromSegment(
  entries: JsonlEntry[],
  sessionId: string,
): ToolCommitHint[] {
  const toolUseById = new Map<string, { command: string; ts: number }>();
  const hints: ToolCommitHint[] = [];

  for (const e of entries) {
    const ts = Date.parse(e.timestamp as string);
    if (!Number.isFinite(ts)) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content as Array<any>) {
      if (c?.type === 'tool_use' && c?.name === 'Bash' && typeof c?.input?.command === 'string') {
        const cmd = c.input.command as string;
        if (/^\s*git\s+commit\b/.test(cmd) && typeof c.id === 'string') {
          toolUseById.set(c.id, { command: cmd, ts });
        }
      } else if (c?.type === 'tool_result' && typeof c?.tool_use_id === 'string') {
        const origin = toolUseById.get(c.tool_use_id);
        if (!origin) continue;
        const resultText =
          typeof c.content === 'string'
            ? c.content
            : Array.isArray(c.content)
              ? c.content.map((x: any) => (typeof x?.text === 'string' ? x.text : '')).join('\n')
              : '';
        const m = resultText.match(COMMIT_HASH_RE);
        if (m) {
          hints.push({
            session_id: sessionId,
            commit_hash: m[1],
            timestamp: ts,
          });
        }
      }
    }
  }

  return hints;
}

function basenameForDisplay(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, '');
  const base = path.basename(cleaned);
  return base || cleaned;
}

export function findJsonlFilesModifiedSince(sinceMs: number): { file: string; projectDir: string }[] {
  const root = claudeProjectsDir();
  if (!fs.existsSync(root)) return [];
  const out: { file: string; projectDir: string }[] = [];
  for (const dirent of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const projectPath = path.join(root, dirent.name);
    let files: string[];
    try {
      files = fs.readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(projectPath, f);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= sinceMs) {
          out.push({ file: full, projectDir: dirent.name });
        }
      } catch {
        continue;
      }
    }
  }
  return out;
}

export interface IngestSummary {
  sessionsIngested: number;
  toolCommitHints: ToolCommitHint[];
  rateLimitHitsIngested: number;
  skipped: number;
  parseErrors: number;
  filesScanned: number;
}

export function ingestClaudeCode(db: DatabaseSync, sinceMs: number): IngestSummary {
  const files = findJsonlFilesModifiedSince(sinceMs);
  let sessionsIngested = 0;
  let rateLimitHitsIngested = 0;
  let skipped = 0;
  let parseErrors = 0;
  const toolCommitHints: ToolCommitHint[] = [];

  for (const { file } of files) {
    const r = parseJsonlFile(file, 'unknown');
    for (const s of r.sessions) {
      if (s.session_end_ms < sinceMs) continue;
      insertSession(db, s);
      sessionsIngested++;
    }
    for (const h of r.rateLimitHits) {
      if (h.timestamp < sinceMs) continue;
      insertRateLimitHit(db, h);
      rateLimitHitsIngested++;
    }
    for (const p of r.projectsSeen) {
      upsertProject(db, {
        project_hash: p.project_hash,
        name: basenameForDisplay(p.path),
        path: p.path,
      });
    }
    skipped += r.skipped;
    parseErrors += r.parseErrors;
    toolCommitHints.push(...r.toolCommitHints);
  }

  return {
    sessionsIngested,
    toolCommitHints,
    rateLimitHitsIngested,
    skipped,
    parseErrors,
    filesScanned: files.length,
  };
}
