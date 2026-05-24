export type EventType = 'session' | 'commit';
export type Source = 'claude_code' | 'git';
export type AttributionTier = 'direct' | 'high' | 'inferred';

export interface SessionEvent {
  id: string;
  timestamp: number;
  type: 'session';
  source: 'claude_code';
  project_hash: string;
  session_id: string;
  tokens_in: number;
  tokens_out: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  cost_usd: number;
  pricing_version: string;
  pricing_fallback: boolean;
  model_id: string;
  session_end_ms: number;
}

export interface TopSession {
  session_id: string;
  timestamp: number;
  cost_usd: number;
  duration_ms: number;
  attr_count: number;
  model_id: string;
}

export type Plan =
  | 'api'
  | 'pro'
  | 'max-100'
  | 'max-200'
  | 'cursor-pro'
  | 'copilot'
  | 'unknown';

export interface MileageConfig {
  version: 1;
  plan: Plan;
  preferences: {
    currency: string;
    show_dollars_anyway: boolean;
    waste_threshold_usd: number;
  };
}

export type SessionTag = 'shipped' | 'exploring' | 'debugging' | 'dead-end';

export interface SessionTagRow {
  session_id: string;
  tag: SessionTag;
  tagged_at: number;
}

export interface CommitSurvivalRow {
  commit_hash: string;
  project_hash: string;
  evaluated_at: number;
  lines_added: number;
  lines_surviving: number;
  files_touched: number;
  files_revisited: number;
  window_days: number;
}

export interface RateLimitHit {
  id: string;
  timestamp: number;
  session_id: string | null;
  window: '5h' | '7d' | 'unknown';
  raw_message: string;
}

export interface CommitEvent {
  id: string;
  timestamp: number;
  type: 'commit';
  source: 'git';
  project_hash: string;
  commit_hash: string;
  lines_added: number;
  lines_removed: number;
  files_changed: number;
  primary_language: string;
  branch: string;
}

export type Event = SessionEvent | CommitEvent;

export interface Attribution {
  session_id: string;
  commit_hash: string;
  tier: AttributionTier;
  confidence: number;
}

export interface Snapshot {
  date: string;
  project_hash: string;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  session_count: number;
  commit_count: number;
  attributed_commit_count: number;
  direct_attribution_count: number;
  inferred_attribution_count: number;
  ypt_score: number | null;
  cost_per_ship_tokens: number | null;
  cost_per_ship_usd: number | null;
  provenance: object;
  computed_at: number;
}

export interface ToolCommitHint {
  session_id: string;
  commit_hash: string;
  timestamp: number;
}
