import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertCatalogInvariants,
  getGatewayCatalogMetadata,
  getModelProfile,
  MODEL_CATALOG,
} from './model-catalog';
import { ModelError } from './model-errors';
import { MODEL_ALIASES, type ModelAlias } from './model-types';

const LOCKED_OUTPUT_CAPS: Record<ModelAlias, number> = {
  'page-fast': 1024,
  'page-standard': 2048,
  'page-deep': 4096,
  'page-vision': 2048,
};

const LOCKED_TIMEOUTS_MS: Record<ModelAlias, number> = {
  'page-fast': 30_000,
  'page-standard': 60_000,
  'page-deep': 120_000,
  'page-vision': 90_000,
};

const LOCKED_FALLBACKS: Record<ModelAlias, ModelAlias | undefined> = {
  'page-fast': 'page-standard',
  'page-standard': 'page-deep',
  'page-deep': undefined,
  'page-vision': undefined,
};

describe('MODEL_CATALOG', () => {
  it('contains exactly the four product aliases', () => {
    assert.deepEqual(Object.keys(MODEL_CATALOG).sort(), [...MODEL_ALIASES].sort());
  });

  it('uses non-empty provider model ids and positive windows, caps, and timeouts', () => {
    for (const alias of MODEL_ALIASES) {
      const profile = getModelProfile(alias);
      assert.equal(profile.alias, alias);
      assert.equal(profile.provider, 'ai-gateway');
      assert.notEqual(profile.providerModelId.trim(), '');
      assert.ok(profile.contextWindowTokens > 0);
      assert.equal(profile.maxOutputTokens, LOCKED_OUTPUT_CAPS[alias]);
      assert.equal(profile.requestTimeoutMs, LOCKED_TIMEOUTS_MS[alias]);
      assert.equal(profile.capabilities.text, true);
    }
  });

  it('marks page-vision as vision-capable', () => {
    assert.equal(getModelProfile('page-vision').capabilities.vision, true);
  });

  it('records current Gateway slugs from the 2026-09-17 live catalog', () => {
    assert.equal(getModelProfile('page-fast').providerModelId, 'openai/gpt-5-nano');
    assert.equal(getModelProfile('page-standard').providerModelId, 'google/gemini-2.5-flash');
    assert.equal(getModelProfile('page-deep').providerModelId, 'anthropic/claude-sonnet-5');
    assert.equal(getModelProfile('page-vision').providerModelId, 'google/gemini-3-flash');
  });

  it('uses live context windows from the Gateway model list', () => {
    assert.equal(getModelProfile('page-fast').contextWindowTokens, 400_000);
    assert.equal(getModelProfile('page-standard').contextWindowTokens, 1_000_000);
    assert.equal(getModelProfile('page-deep').contextWindowTokens, 1_000_000);
    assert.equal(getModelProfile('page-vision').contextWindowTokens, 1_000_000);
  });

  it('has an acyclic fallback graph matching the locked plan', () => {
    for (const alias of MODEL_ALIASES) {
      assert.equal(getModelProfile(alias).fallbackAlias, LOCKED_FALLBACKS[alias]);
    }
    assert.doesNotThrow(() => assertCatalogInvariants(MODEL_CATALOG));
  });

  it('keeps Gateway provider-sort metadata in the catalog layer', () => {
    assert.equal(getGatewayCatalogMetadata('page-fast').sort, 'cost');
    assert.equal(getGatewayCatalogMetadata('page-standard').sort, 'ttft');
    assert.equal(getGatewayCatalogMetadata('page-vision').sort, 'ttft');
    assert.equal(getGatewayCatalogMetadata('page-deep').sort, undefined);
  });

  it('returns frozen production profiles', () => {
    const profile = getModelProfile('page-fast');
    assert.throws(() => {
      (profile as { maxOutputTokens: number }).maxOutputTokens = 1;
    }, TypeError);
    assert.throws(() => {
      (profile.capabilities as { text: boolean }).text = false;
    }, TypeError);
  });

  it('rejects a self-fallback catalog', () => {
    const broken = {
      ...MODEL_CATALOG,
      'page-deep': {
        ...MODEL_CATALOG['page-deep'],
        profile: {
          ...MODEL_CATALOG['page-deep'].profile,
          fallbackAlias: 'page-deep' as const,
        },
      },
    };

    assert.throws(
      () => assertCatalogInvariants(broken),
      (error: unknown) => error instanceof ModelError && error.code === 'MODEL_UNAVAILABLE',
    );
  });
});
