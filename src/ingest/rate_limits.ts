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

export function detectRateLimitHit(
  text: string,
  timestamp: number,
  sessionId: string | null,
): RateLimitHit | null {
  if (!text) return null;
  let matched = false;
  for (const p of RATE_LIMIT_PATTERNS) {
    if (p.test(text)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  let win: RateLimitHit['window'] = 'unknown';
  if (WINDOW_5H.test(text)) win = '5h';
  else if (WINDOW_7D.test(text)) win = '7d';

  const id = crypto
    .createHash('sha1')
    .update(`${timestamp}|${sessionId ?? ''}|${text.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16);

  return {
    id,
    timestamp,
    session_id: sessionId,
    window: win,
    raw_message: text.slice(0, 500),
  };
}
