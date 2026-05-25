import { DatabaseSync } from 'node:sqlite';
import { gatherComposites } from '../compute/composite_outcomes';
import { classifySessionBucket, type EffBucket } from '../compute/effectiveness';
import { getJudgedSessionIds, insertVerdict } from '../storage/db';
import type { MileageConfig } from '../storage/types';
import { selectJudgeModel } from './detect';
import { buildJudgeInput } from './input';
import { runJudge, ollamaTransport, cloudTransport, type JudgeTransport } from './runner';

const JUDGE_EFFORT_TOKENS = 250_000;
const JUDGE_MAX_PER_PASS = 8;

// v1 uses a tokens-only effort proxy (research sessions are reliably high-token in
// the dogfood data). Duration is a noted v1.1 refinement — it would require threading
// session_end_ms through Part 2's outcomes types, which we avoid here.
export function qualifiesForJudging(bucket: EffBucket, tokens: number): boolean {
  return bucket === 'research' && tokens >= JUDGE_EFFORT_TOKENS;
}

export interface JudgePassResult {
  model: string;
  judged: number;
  skipped_unavailable: boolean;
}

export async function runJudgePass(
  db: DatabaseSync,
  cfg: MileageConfig,
  startMs: number,
  endMs: number,
  refresh = false,
): Promise<JudgePassResult> {
  const model = await selectJudgeModel(cfg);
  if (model.kind === 'off') return { model: model.reason, judged: 0, skipped_unavailable: true };

  let transport: JudgeTransport;
  if (model.kind === 'cloud') {
    const key = process.env.MILEAGE_JUDGE_API_KEY ?? '';
    transport = cloudTransport(cfg.judge.cloud.endpoint, key);
  } else {
    transport = ollamaTransport;
  }

  const { composites, attrMap } = gatherComposites(db, startMs, endMs);
  const alreadyJudged = refresh ? new Set<string>() : getJudgedSessionIds(db);

  const candidates = composites.filter((c) => {
    const bucket = classifySessionBucket(c, attrMap.get(c.session_id) ?? []);
    return qualifiesForJudging(bucket, c.tokens) && !alreadyJudged.has(c.session_id);
  });

  let judged = 0;
  for (const c of candidates.slice(0, JUDGE_MAX_PER_PASS)) {
    const [origId, idxStr] = c.session_id.split(':');
    const input = buildJudgeInput(origId, Number(idxStr));
    if (!input) continue;
    const result = await runJudge(model, input, transport);
    insertVerdict(db, {
      session_id: c.session_id,
      verdict: result.verdict,
      confidence: result.confidence,
      model: model.model || model.kind,
      rationale: result.rationale,
      judged_at: Date.now(),
    });
    judged++;
  }
  return { model: model.model || model.kind, judged, skipped_unavailable: false };
}
