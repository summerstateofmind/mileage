import type { JudgeInput } from './types';

export function buildJudgePrompt(input: JudgeInput): string {
  const t = input.trajectory;
  const tools = Object.entries(t.tool_counts).map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
  return [
    'You judge whether an AI coding session that produced NO git commit was still worthwhile.',
    'productive = explored options, researched, localized a bug, made a real decision, or correctly abandoned a bad approach after learning.',
    'spinning = repeated near-identical failed attempts, no convergence, thrashing the same file, confidently-wrong loops.',
    'If genuinely unclear, answer uncertain.',
    '',
    `User intent (prompts):\n${input.prompts.map((p) => `- ${p}`).join('\n') || '- (none captured)'}`,
    '',
    `Behavioral trajectory: tools={${tools}}; errors=${t.error_count}; files_edited=${t.files_touched}; max_edits_to_one_file=${t.max_edits_to_one_file}; bash=${t.bash_count}.`,
    '',
    'Respond with ONLY this JSON, no prose: {"verdict":"productive"|"spinning"|"uncertain","confidence":0.0-1.0,"rationale":"<=12 words"}',
  ].join('\n');
}
