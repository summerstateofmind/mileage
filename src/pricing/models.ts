export interface ModelPricing {
  input_per_mtok: number;
  cache_create_per_mtok: number;
  cache_read_per_mtok: number;
  output_per_mtok: number;
}

export const PRICING_VERSION = '2026-05-22';

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7': {
    input_per_mtok: 15.0,
    cache_create_per_mtok: 18.75,
    cache_read_per_mtok: 1.5,
    output_per_mtok: 75.0,
  },
  'claude-opus-4-6': {
    input_per_mtok: 15.0,
    cache_create_per_mtok: 18.75,
    cache_read_per_mtok: 1.5,
    output_per_mtok: 75.0,
  },
  'claude-sonnet-4-6': {
    input_per_mtok: 3.0,
    cache_create_per_mtok: 3.75,
    cache_read_per_mtok: 0.3,
    output_per_mtok: 15.0,
  },
  'claude-sonnet-4-5': {
    input_per_mtok: 3.0,
    cache_create_per_mtok: 3.75,
    cache_read_per_mtok: 0.3,
    output_per_mtok: 15.0,
  },
  'claude-haiku-4-5': {
    input_per_mtok: 0.8,
    cache_create_per_mtok: 1.0,
    cache_read_per_mtok: 0.08,
    output_per_mtok: 4.0,
  },
  'claude-3-7-sonnet': {
    input_per_mtok: 3.0,
    cache_create_per_mtok: 3.75,
    cache_read_per_mtok: 0.3,
    output_per_mtok: 15.0,
  },
  'claude-3-5-sonnet': {
    input_per_mtok: 3.0,
    cache_create_per_mtok: 3.75,
    cache_read_per_mtok: 0.3,
    output_per_mtok: 15.0,
  },
  'claude-3-5-haiku': {
    input_per_mtok: 0.8,
    cache_create_per_mtok: 1.0,
    cache_read_per_mtok: 0.08,
    output_per_mtok: 4.0,
  },
  'claude-3-opus': {
    input_per_mtok: 15.0,
    cache_create_per_mtok: 18.75,
    cache_read_per_mtok: 1.5,
    output_per_mtok: 75.0,
  },
};

const FALLBACK_BY_TIER = {
  opus: PRICING['claude-opus-4-7'],
  sonnet: PRICING['claude-sonnet-4-6'],
  haiku: PRICING['claude-haiku-4-5'],
  unknown: PRICING['claude-sonnet-4-6'],
};

export interface PricingLookup {
  pricing: ModelPricing;
  fallback: boolean;
  matched_as: string;
}

export function pricingFor(modelId: string): PricingLookup {
  if (PRICING[modelId]) {
    return { pricing: PRICING[modelId], fallback: false, matched_as: modelId };
  }
  const m = modelId.toLowerCase();
  if (m.includes('opus')) {
    return { pricing: FALLBACK_BY_TIER.opus, fallback: true, matched_as: 'opus-tier' };
  }
  if (m.includes('haiku')) {
    return { pricing: FALLBACK_BY_TIER.haiku, fallback: true, matched_as: 'haiku-tier' };
  }
  if (m.includes('sonnet')) {
    return { pricing: FALLBACK_BY_TIER.sonnet, fallback: true, matched_as: 'sonnet-tier' };
  }
  return { pricing: FALLBACK_BY_TIER.unknown, fallback: true, matched_as: 'unknown-fallback' };
}

export function listKnownModels(): string[] {
  return Object.keys(PRICING);
}
