import type { JudgeInput } from './types';

export function buildJudgePrompt(input: JudgeInput): string {
  const tools = Object.entries(input.trajectory.tool_counts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';

  const arcStr = input.action_arc.length > 0
    ? input.action_arc.map((a) => {
        const file = a.file ? ` ${a.file}` : '';
        return `${a.tool}${file}:${a.outcome}`;
      }).join(' → ')
    : '(no tool actions captured)';

  return [
    'You are grading session YIELD — how much meaningful forward progress this session produced.',
    'Commits/edits are NOT the signal; many high-yield sessions are pure research with zero commits.',
    '',
    'TIERS:',
    '  high    — focused, efficient progress on something that matters; converged; clear forward motion',
    '  solid   — real, meaningful progress — the normal good working session',
    '  thin    — some progress but slow, scattered, minor, or partly off-track; not wasted, not impressive',
    '  stalled — little/no meaningful progress: repeated failed attempts, circling, thrashing, or abandoned unresolved',
    '',
    'ANCHORS:',
    '  high:    "Researched 3 auth libraries, compared trade-offs, picked one with rationale" (zero commits, converged)',
    '  solid:   "Debugged flaky test, found root cause in async timing, wrote the fix" (normal productive session)',
    "  thin:    \"Explored caching options, read some docs, didn't land on a decision\" (some work, no convergence)",
    '  stalled: "Tried same regex fix 4 times, each failed the same test, no new approach" (thrashing loop)',
    '',
    `User intent (prompts):\n${input.prompts.map((p) => `- ${p}`).join('\n') || '- (none captured)'}`,
    '',
    `Action arc:\n${arcStr}`,
    '',
    `Summary: tools={${tools}}; errors=${input.trajectory.error_count}; files_edited=${input.trajectory.files_touched}; max_edits_to_one_file=${input.trajectory.max_edits_to_one_file}`,
    '',
    'Respond with ONLY this JSON, no prose:',
    '{"tier":"high"|"solid"|"thin"|"stalled","confidence":0.0-1.0,"rationale":"<=14 words, cite the specific work"}',
  ].join('\n');
}
