import * as crypto from 'node:crypto';
import type { RateLimitHit } from '../storage/types';

// Patterns must be unambiguous — these strings should only appear in genuine
// Anthropic rate-limit API/UX error messages, not in normal conversation.
const RATE_LIMIT_PATTERNS = [
  /"type":\s*"rate_limit_error"/i,
  /rate_limit_error/i,
  /HTTP\s*429\b/i,
  /\b429\b.*(too many requests|rate)/i,
  /Claude usage limit (reached|exceeded)/i,
  /usage limit (reached|exceeded)/i,
  /you have been rate[_\s-]?limited/i,
  /retry[_\s-]?after.*\d+/i,
];

const WINDOW_5H = /5[_\s-]?hour|five[_\s-]?hour/i;
const WINDOW_7D = /7[_\s-]?day|seven[_\s-]?day|weekly/i;

function classifyWindow(text: string): RateLimitHit['window'] {
  if (WINDOW_5H.test(text) || /session limit/i.test(text)) return '5h';
  if (WINDOW_7D.test(text)) return '7d';
  return 'unknown';
}

function makeHit(text: string, timestamp: number, sessionId: string | null): RateLimitHit {
  const id = crypto
    .createHash('sha1')
    .update(`${timestamp}|${sessionId ?? ''}|${text.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16);
  return {
    id,
    timestamp,
    session_id: sessionId,
    window: classifyWindow(text),
    raw_message: text.slice(0, 500),
  };
}

// A single account-level cap exhaustion produces many 429 entries: retry backoff
// within one instance, AND simultaneous 429s across concurrently-running Claude
// Code instances (the cap is per-account — hit once, every instance gets 429ed).
// Collapse hits whose consecutive gap is under this threshold into ONE event,
// regardless of which session/instance logged them. Once the cap is hit you stay
// blocked until the window resets (hours away), so genuinely distinct wall-hits
// are always far apart — a 10-minute gap can't merge two real events.
export const RATE_LIMIT_CLUSTER_GAP_MS = 10 * 60_000;

export function clusterRateLimitHits(
  hits: RateLimitHit[],
  gapMs: number = RATE_LIMIT_CLUSTER_GAP_MS,
): RateLimitHit[] {
  if (hits.length <= 1) return hits;
  const asc = [...hits].sort((a, b) => a.timestamp - b.timestamp);
  const events: RateLimitHit[] = [asc[0]]; // earliest hit = when the wall was first hit
  let prevTs = asc[0].timestamp;
  for (let i = 1; i < asc.length; i++) {
    if (asc[i].timestamp - prevTs > gapMs) events.push(asc[i]);
    prevTs = asc[i].timestamp;
  }
  return events.reverse(); // DESC, matching getRateLimitHitsSince's contract
}

export function detectRateLimitHit(
  text: string,
  timestamp: number,
  sessionId: string | null,
): RateLimitHit | null {
  if (!text) return null;
  if (!RATE_LIMIT_PATTERNS.some((p) => p.test(text))) return null;
  return makeHit(text, timestamp, sessionId);
}

// Real Claude Code cap hits arrive as API-error entries (isApiErrorMessage with
// error:"rate_limit" / apiErrorStatus 429), NOT tool-result errors — and their
// user-facing text ("session limit reached") doesn't match the text patterns above.
// Detect them structurally off the reliable flags instead.
export function detectApiErrorRateLimit(
  entry: { isApiErrorMessage?: boolean; error?: string; apiErrorStatus?: number },
  text: string,
  timestamp: number,
  sessionId: string | null,
): RateLimitHit | null {
  const isRateLimit =
    entry.isApiErrorMessage === true &&
    ((typeof entry.error === 'string' && /rate[_\s-]?limit/i.test(entry.error)) ||
      entry.apiErrorStatus === 429);
  if (!isRateLimit) return null;
  return makeHit(text || 'rate limit (api error)', timestamp, sessionId);
}
