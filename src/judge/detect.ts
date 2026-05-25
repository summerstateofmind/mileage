import * as os from 'node:os';
import type { JudgeModel } from './types';
import type { MileageConfig } from '../storage/types';

export interface DetectInputs {
  freeRamGb: number;
  ollamaModels: string[];
  override: string | null;
  cloud: { enabled: boolean; model: string };
}

export function chooseModel(i: DetectInputs): JudgeModel {
  if (i.override === 'off') return { kind: 'off', model: '', reason: 'disabled by override' };
  if (i.override === 'cloud') {
    return i.cloud.enabled
      ? { kind: 'cloud', model: i.cloud.model, reason: 'override: cloud' }
      : { kind: 'off', model: '', reason: 'cloud override but cloud not configured' };
  }
  if (i.override) return { kind: 'ollama', model: i.override, reason: `override: ${i.override}` };

  if (i.cloud.enabled) return { kind: 'cloud', model: i.cloud.model, reason: 'cloud opt-in configured' };
  if (i.ollamaModels.length === 0) {
    return { kind: 'off', model: '', reason: 'Ollama not reachable or no models pulled' };
  }
  const big = i.ollamaModels.find((m) => /(7|8|9|13|14)b/i.test(m));
  const small = i.ollamaModels.find((m) => /(1|2|3|4)b|mini|small/i.test(m));
  if (i.freeRamGb >= 14 && big) return { kind: 'ollama', model: big, reason: '>=14GB RAM, 7-8B' };
  if (i.freeRamGb >= 7) return { kind: 'ollama', model: small ?? i.ollamaModels[0], reason: '>=7GB RAM, small model' };
  return { kind: 'off', model: '', reason: 'insufficient RAM (<7GB free)' };
}

export async function selectJudgeModel(cfg: MileageConfig): Promise<JudgeModel> {
  const freeRamGb = os.freemem() / 1e9;
  let ollamaModels: string[] = [];
  try {
    const res = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      ollamaModels = (data.models ?? []).map((m) => m.name);
    }
  } catch {
    /* Ollama not running — leave empty */
  }
  return chooseModel({
    freeRamGb,
    ollamaModels,
    override: cfg.judge.model_override,
    cloud: { enabled: cfg.judge.cloud.enabled, model: cfg.judge.cloud.model },
  });
}
