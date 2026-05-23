import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface StatsCacheDay {
  date: string;
  messageCount: number;
  sessionCount: number;
  toolCallCount: number;
}

export interface StatsCacheModelDay {
  date: string;
  tokensByModel: Record<string, number>;
}

export interface StatsCache {
  version: number;
  lastComputedDate: string;
  dailyActivity: StatsCacheDay[];
  dailyModelTokens: StatsCacheModelDay[];
}

export function readStatsCache(): StatsCache | null {
  const p = path.join(os.homedir(), '.claude', 'stats-cache.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as StatsCache;
  } catch {
    return null;
  }
}
