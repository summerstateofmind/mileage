import { findSessionSegmentEntries } from '../ingest/claude_code';
import type { JsonlEntry } from '../ingest/claude_code';
import type { JudgeInput, TrajectorySummary } from './types';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (c?.type === 'text' && typeof c.text === 'string' ? c.text : ''))
      .join(' ')
      .trim();
  }
  return '';
}

// User free-text only. tool_result blocks (which ride on role:user messages) are skipped,
// and assistant messages are never read — so no assistant prose, code, or diffs leak out.
export function extractPrompts(entries: JsonlEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.message?.role !== 'user') continue;
    const content = e.message?.content;
    if (Array.isArray(content) && content.some((c: any) => c?.type === 'tool_result')) continue;
    const t = textOf(content);
    if (t) out.push(t);
  }
  return out;
}

export function summarizeTrajectory(entries: JsonlEntry[]): TrajectorySummary {
  const tool_counts: Record<string, number> = {};
  const fileEdits: Record<string, number> = {};
  let error_count = 0;
  for (const e of entries) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as any[]) {
      if (c?.type === 'tool_use' && typeof c?.name === 'string') {
        tool_counts[c.name] = (tool_counts[c.name] ?? 0) + 1;
        const fp = c?.input?.file_path;
        if ((c.name === 'Edit' || c.name === 'Write') && typeof fp === 'string') {
          fileEdits[fp] = (fileEdits[fp] ?? 0) + 1;
        }
      } else if (c?.type === 'tool_result' && c?.is_error === true) {
        error_count++;
      }
    }
  }
  const editValues = Object.values(fileEdits);
  return {
    tool_counts,
    error_count,
    files_touched: editValues.length,
    max_edits_to_one_file: editValues.length ? Math.max(...editValues) : 0,
    bash_count: tool_counts.Bash ?? 0,
  };
}

export function buildJudgeInput(sessionId: string, segIdx: number): JudgeInput | null {
  const entries = findSessionSegmentEntries(sessionId, segIdx);
  if (!entries) return null;
  return { prompts: extractPrompts(entries), trajectory: summarizeTrajectory(entries) };
}
