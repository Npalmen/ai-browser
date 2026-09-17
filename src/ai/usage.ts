import type { ModelCost, ModelUsage } from './model-types';

export interface ModelUsageSource {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    cacheReadTokens?: number;
  };
  outputTokenDetails?: {
    reasoningTokens?: number;
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Copy only counts that a provider actually reported.
 * Missing fields stay absent; zeros are preserved when provided.
 */
export function normalizeModelUsage(source: unknown): ModelUsage | undefined {
  const record = asRecord(source);
  if (!record) {
    return undefined;
  }

  const inputDetails = asRecord(record.inputTokenDetails);
  const outputDetails = asRecord(record.outputTokenDetails);

  const usage: ModelUsage = {};
  const inputTokens = asCount(record.inputTokens);
  const outputTokens = asCount(record.outputTokens);
  const totalTokens = asCount(record.totalTokens);
  const reasoningTokens =
    asCount(record.reasoningTokens) ?? asCount(outputDetails?.reasoningTokens);
  const cachedInputTokens =
    asCount(record.cachedInputTokens) ?? asCount(inputDetails?.cacheReadTokens);

  if (inputTokens !== undefined) {
    usage.inputTokens = inputTokens;
  }
  if (outputTokens !== undefined) {
    usage.outputTokens = outputTokens;
  }
  if (reasoningTokens !== undefined) {
    usage.reasoningTokens = reasoningTokens;
  }
  if (cachedInputTokens !== undefined) {
    usage.cachedInputTokens = cachedInputTokens;
  }
  if (totalTokens !== undefined) {
    usage.totalTokens = totalTokens;
  }

  return Object.keys(usage).length > 0 ? usage : undefined;
}

function firstNonNegativeCost(values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Gateway request cost from provider metadata.
 * Missing or invalid values stay unknown; this does not estimate.
 */
export function normalizeGatewayCost(providerMetadata: unknown): ModelCost {
  const gateway = asRecord(asRecord(providerMetadata)?.gateway);
  const amountUsd = firstNonNegativeCost([gateway?.cost, gateway?.totalCost]);

  if (amountUsd === undefined) {
    return { knowledge: 'unknown', currency: 'USD' };
  }

  return {
    knowledge: 'known',
    amountUsd,
    currency: 'USD',
  };
}
