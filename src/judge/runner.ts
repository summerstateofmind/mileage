import type { JudgeInput, JudgeModel, JudgeResult, Verdict } from './types';
import { buildJudgePrompt } from './prompt';

const UNCERTAIN: JudgeResult = { verdict: 'uncertain', confidence: 0, rationale: 'judge unavailable' };
const VERDICTS: Verdict[] = ['productive', 'spinning', 'uncertain'];

export function parseVerdict(text: string): JudgeResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return UNCERTAIN;
  let obj: any;
  try {
    obj = JSON.parse(m[0]);
  } catch {
    return UNCERTAIN;
  }
  if (!VERDICTS.includes(obj.verdict)) return UNCERTAIN;
  const conf = Number(obj.confidence);
  return {
    verdict: obj.verdict,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0,
    rationale: typeof obj.rationale === 'string' ? obj.rationale.slice(0, 120) : '',
  };
}

export type JudgeTransport = (model: string, prompt: string) => Promise<string>;

export async function ollamaTransport(model: string, prompt: string): Promise<string> {
  const res = await fetch('http://localhost:11434/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, prompt, stream: false, format: 'json' }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json()) as { response?: string };
  return data.response ?? '';
}

export function cloudTransport(endpoint: string, apiKey: string): JudgeTransport {
  return async (model, prompt) => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  };
}

export async function runJudge(
  model: JudgeModel,
  input: JudgeInput,
  transport: JudgeTransport,
): Promise<JudgeResult> {
  if (model.kind === 'off') return UNCERTAIN;
  try {
    const text = await transport(model.model, buildJudgePrompt(input));
    return parseVerdict(text);
  } catch {
    return UNCERTAIN;
  }
}
