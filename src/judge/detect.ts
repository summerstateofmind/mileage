import * as os from 'node:os';
import type { JudgeModel } from './types';
import type { MileageConfig } from '../storage/types';

export interface DetectInputs {
  totalRamGb: number;
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
  // Local-first: pick the largest model the machine can hold by TOTAL RAM (free RAM is
  // transient — a 16GB box often shows <10GB free and would wrongly under-select).
  if (i.totalRamGb >= 16 && big) return { kind: 'ollama', model: big, reason: '>=16GB RAM, 7-8B (local)' };
  if (i.totalRamGb >= 8) return { kind: 'ollama', model: small ?? i.ollamaModels[0], reason: '>=8GB RAM, small model (local)' };
  return { kind: 'off', model: '', reason: 'insufficient RAM (<8GB) for a local model' };
}

export async function selectJudgeModel(cfg: MileageConfig): Promise<JudgeModel> {
  const totalRamGb = os.totalmem() / 1e9;
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
    totalRamGb,
    ollamaModels,
    override: cfg.judge.model_override,
    cloud: { enabled: cfg.judge.cloud.enabled, model: cfg.judge.cloud.model },
  });
}
