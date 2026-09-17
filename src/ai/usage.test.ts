import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeGatewayCost, normalizeModelUsage } from './usage';

describe('normalizeModelUsage', () => {
  it('keeps sparse usage sparse', () => {
    assert.deepEqual(
      normalizeModelUsage({
        inputTokens: 11,
        outputTokens: 7,
        inputTokenDetails: {
          cacheReadTokens: undefined,
        },
        outputTokenDetails: {
          reasoningTokens: undefined,
        },
      }),
      {
        inputTokens: 11,
        outputTokens: 7,
      },
    );
  });

  it('maps installed SDK nested usage fields without synthesizing totals', () => {
    assert.deepEqual(
      normalizeModelUsage({
        inputTokens: 20,
        outputTokens: 5,
        inputTokenDetails: {
          cacheReadTokens: 3,
        },
        outputTokenDetails: {
          reasoningTokens: 4,
        },
      }),
      {
        inputTokens: 20,
        outputTokens: 5,
        reasoningTokens: 4,
        cachedInputTokens: 3,
      },
    );
  });

  it('omits usage when no reliable counts are present', () => {
    assert.equal(normalizeModelUsage({}), undefined);
    assert.equal(normalizeModelUsage(undefined), undefined);
    assert.equal(normalizeModelUsage({ inputTokens: Number.NaN }), undefined);
  });

  it('preserves a reported zero without inventing sibling fields', () => {
    assert.deepEqual(normalizeModelUsage({ outputTokens: 0 }), { outputTokens: 0 });
  });
});

describe('normalizeGatewayCost', () => {
  it('returns known USD cost for a finite non-negative Gateway cost', () => {
    assert.deepEqual(normalizeGatewayCost({ gateway: { cost: 0.0012 } }), {
      knowledge: 'known',
      amountUsd: 0.0012,
      currency: 'USD',
    });
  });

  it('returns unknown USD when cost is missing or invalid', () => {
    assert.deepEqual(normalizeGatewayCost(undefined), {
      knowledge: 'unknown',
      currency: 'USD',
    });
    assert.deepEqual(normalizeGatewayCost({ gateway: {} }), {
      knowledge: 'unknown',
      currency: 'USD',
    });
    assert.deepEqual(normalizeGatewayCost({ gateway: { cost: -1 } }), {
      knowledge: 'unknown',
      currency: 'USD',
    });
    assert.deepEqual(normalizeGatewayCost({ gateway: { cost: Number.NaN } }), {
      knowledge: 'unknown',
      currency: 'USD',
    });
  });
});
