import { pricingFor } from '../pricing/models';

export interface TokenUsage {
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  model_id: string;
}

export interface CostBreakdown {
  total_usd: number;
  fallback: boolean;
  matched_as: string;
}

export function computeSessionCostUsd(u: TokenUsage): CostBreakdown {
  const { pricing, fallback, matched_as } = pricingFor(u.model_id);
  const cost =
    (u.input_tokens / 1_000_000) * pricing.input_per_mtok +
    (u.cache_creation_tokens / 1_000_000) * pricing.cache_create_per_mtok +
    (u.cache_read_tokens / 1_000_000) * pricing.cache_read_per_mtok +
    (u.output_tokens / 1_000_000) * pricing.output_per_mtok;
  return { total_usd: Number(cost.toFixed(4)), fallback, matched_as };
}
