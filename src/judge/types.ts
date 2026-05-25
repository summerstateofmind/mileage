export type Verdict = 'productive' | 'spinning' | 'uncertain';

export interface JudgeResult {
  verdict: Verdict;
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

export interface JudgeInput {
  prompts: string[];
  trajectory: TrajectorySummary;
}
