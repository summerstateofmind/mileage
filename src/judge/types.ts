export type Tier = 'high' | 'solid' | 'thin' | 'stalled' | 'unrated';

export interface JudgeResult {
  tier: Tier;
  confidence: number;
  rationale: string;
}

export type JudgeModelKind = 'off' | 'ollama' | 'cloud';

export interface JudgeModel {
  kind: JudgeModelKind;
  model: string;
  reason: string;
}

export interface TrajectorySummary {
  tool_counts: Record<string, number>;
  error_count: number;
  files_touched: number;
  max_edits_to_one_file: number;
  bash_count: number;
}

export interface ActionStep {
  tool: string;
  file?: string;
  outcome: 'ok' | 'fail';
}

export interface JudgeInput {
  prompts: string[];
  trajectory: TrajectorySummary;
  action_arc: ActionStep[];
}
