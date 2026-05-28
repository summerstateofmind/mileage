import { findSessionSegmentEntries } from '../ingest/claude_code';
import type { JsonlEntry } from '../ingest/claude_code';
import type { JudgeInput, TrajectorySummary, ActionStep } from './types';

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

const BASH_SAFE_VERB_RE = /\b(test|build|lint|typecheck|git|install|run)\b/i;
const ACTION_ARC_CAP = 40;

export function extractActionArc(entries: JsonlEntry[], cap = ACTION_ARC_CAP): ActionStep[] {
  const pending = new Map<string, { tool: string; file?: string }>();
  const arc: ActionStep[] = [];

  for (const e of entries) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;

    for (const c of content as any[]) {
      if (c?.type === 'tool_use' && typeof c?.name === 'string') {
        let toolLabel = c.name;
        let file: string | undefined;

        if ((c.name === 'Edit' || c.name === 'Write' || c.name === 'Read') && typeof c.input?.file_path === 'string') {
          file = c.input.file_path;
        }
        if (c.name === 'Bash' && typeof c.input?.command === 'string') {
          const verb = c.input.command.match(BASH_SAFE_VERB_RE);
          if (verb) toolLabel = `Bash ${verb[1].toLowerCase()}`;
        }

        if (typeof c.id === 'string') {
          pending.set(c.id, { tool: toolLabel, file });
        }
      } else if (c?.type === 'tool_result') {
        const id = c.tool_use_id;
        const info = typeof id === 'string' ? pending.get(id) : undefined;
        if (info) {
          const step: ActionStep = { tool: info.tool, outcome: c.is_error === true ? 'fail' : 'ok' };
          if (info.file) step.file = info.file;
          arc.push(step);
          pending.delete(id);
        }
      }
    }
  }

  return arc.slice(-cap);
}

export function buildJudgeInput(sessionId: string, segIdx: number): JudgeInput | null {
  const entries = findSessionSegmentEntries(sessionId, segIdx);
  if (!entries) return null;
  return {
    prompts: extractPrompts(entries),
    trajectory: summarizeTrajectory(entries),
    action_arc: extractActionArc(entries),
  };
}
