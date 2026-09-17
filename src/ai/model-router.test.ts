import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ModelCatalog, ModelCatalogEntry } from './model-catalog';
import { MODEL_CATALOG } from './model-catalog';
import { ModelError } from './model-errors';
import { routeModelRequest } from './model-router';
import type {
  ModelAlias,
  ModelCapabilities,
  ModelProfile,
  TaskClass,
} from './model-types';

const TASK_CLASS_ALIASES: Array<{ taskClass: TaskClass; alias: ModelAlias }> = [
  { taskClass: 'page_summary', alias: 'page-fast' },
  { taskClass: 'page_question', alias: 'page-standard' },
  { taskClass: 'extraction', alias: 'page-standard' },
  { taskClass: 'page_analysis', alias: 'page-deep' },
  { taskClass: 'comparison', alias: 'page-deep' },
];

function testEntry(
  alias: ModelAlias,
  overrides: Partial<ModelProfile> & {
    capabilities?: Partial<ModelCapabilities>;
  } = {},
): ModelCatalogEntry {
  const base = MODEL_CATALOG[alias].profile;
  return {
    gateway: {},
    profile: {
      ...base,
      ...overrides,
      alias,
      capabilities: {
        ...base.capabilities,
        ...overrides.capabilities,
      },
    },
  };
}

function testCatalog(overrides: Partial<Record<ModelAlias, ModelCatalogEntry>>): ModelCatalog {
  return {
    'page-fast': testEntry('page-fast'),
    'page-standard': testEntry('page-standard'),
    'page-deep': testEntry('page-deep'),
    'page-vision': testEntry('page-vision'),
    ...overrides,
  };
}

describe('routeModelRequest', () => {
  for (const { taskClass, alias } of TASK_CLASS_ALIASES) {
    it(`routes ${taskClass} to ${alias}`, () => {
      const route = routeModelRequest({
        taskClass,
        needsVision: false,
        privacy: 'remoteAllowed',
        estimatedInputTokens: 1_000,
      });
      assert.equal(route.alias, alias);
      assert.equal(route.profile.alias, alias);
    });
  }

  for (const { taskClass } of TASK_CLASS_ALIASES) {
    it(`routes needsVision ${taskClass} to page-vision`, () => {
      const route = routeModelRequest({
        taskClass,
        needsVision: true,
        privacy: 'remoteAllowed',
        estimatedInputTokens: 1_000,
      });
      assert.equal(route.alias, 'page-vision');
      assert.equal(route.profile.alias, 'page-vision');
    });
  }

  it('fails closed for localOnly without returning a Gateway profile', () => {
    assert.throws(
      () =>
        routeModelRequest({
          taskClass: 'page_question',
          needsVision: false,
          privacy: 'localOnly',
          estimatedInputTokens: 1_000,
        }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_NOT_CONFIGURED',
    );

    assert.throws(
      () =>
        routeModelRequest({
          taskClass: 'page_summary',
          needsVision: true,
          privacy: 'localOnly',
          estimatedInputTokens: 1_000,
        }),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_NOT_CONFIGURED',
    );
  });

  it('returns the primary profile when input plus output reserve fits', () => {
    const catalog = testCatalog({
      'page-fast': testEntry('page-fast', {
        contextWindowTokens: 200,
        maxOutputTokens: 50,
        fallbackAlias: 'page-standard',
      }),
      'page-standard': testEntry('page-standard', {
        contextWindowTokens: 10_000,
        maxOutputTokens: 50,
      }),
    });

    const route = routeModelRequest(
      {
        taskClass: 'page_summary',
        needsVision: false,
        privacy: 'remoteAllowed',
        estimatedInputTokens: 150,
      },
      catalog,
    );

    assert.equal(route.alias, 'page-fast');
  });

  it('uses the configured fallback when only the fallback fits', () => {
    const catalog = testCatalog({
      'page-fast': testEntry('page-fast', {
        contextWindowTokens: 100,
        maxOutputTokens: 50,
        fallbackAlias: 'page-standard',
      }),
      'page-standard': testEntry('page-standard', {
        contextWindowTokens: 10_000,
        maxOutputTokens: 50,
      }),
    });

    const route = routeModelRequest(
      {
        taskClass: 'page_summary',
        needsVision: false,
        privacy: 'remoteAllowed',
        estimatedInputTokens: 80,
      },
      catalog,
    );

    assert.equal(route.alias, 'page-standard');
  });

  it('fails CONTEXT_TOO_LARGE when neither primary nor fallback fits', () => {
    const catalog = testCatalog({
      'page-fast': testEntry('page-fast', {
        contextWindowTokens: 100,
        maxOutputTokens: 50,
        fallbackAlias: 'page-standard',
      }),
      'page-standard': testEntry('page-standard', {
        contextWindowTokens: 120,
        maxOutputTokens: 50,
      }),
    });

    assert.throws(
      () =>
        routeModelRequest(
          {
            taskClass: 'page_summary',
            needsVision: false,
            privacy: 'remoteAllowed',
            estimatedInputTokens: 80,
          },
          catalog,
        ),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'CONTEXT_TOO_LARGE',
    );
  });

  it('fails CONTEXT_TOO_LARGE when the fallback lacks required vision', () => {
    const catalog = testCatalog({
      'page-vision': testEntry('page-vision', {
        contextWindowTokens: 100,
        maxOutputTokens: 50,
        fallbackAlias: 'page-fast',
        capabilities: { text: true, vision: true, structuredOutput: true, reasoning: true },
      }),
      'page-fast': testEntry('page-fast', {
        contextWindowTokens: 10_000,
        maxOutputTokens: 50,
        capabilities: { text: true, vision: false, structuredOutput: true, reasoning: true },
      }),
    });

    assert.throws(
      () =>
        routeModelRequest(
          {
            taskClass: 'page_question',
            needsVision: true,
            privacy: 'remoteAllowed',
            estimatedInputTokens: 80,
          },
          catalog,
        ),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'CONTEXT_TOO_LARGE',
    );
  });

  it('does not walk past a single fallback step', () => {
    const catalog = testCatalog({
      'page-fast': testEntry('page-fast', {
        contextWindowTokens: 100,
        maxOutputTokens: 50,
        fallbackAlias: 'page-standard',
      }),
      'page-standard': testEntry('page-standard', {
        contextWindowTokens: 120,
        maxOutputTokens: 50,
        fallbackAlias: 'page-deep',
      }),
      'page-deep': testEntry('page-deep', {
        contextWindowTokens: 10_000,
        maxOutputTokens: 50,
      }),
    });

    assert.throws(
      () =>
        routeModelRequest(
          {
            taskClass: 'page_summary',
            needsVision: false,
            privacy: 'remoteAllowed',
            estimatedInputTokens: 80,
          },
          catalog,
        ),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'CONTEXT_TOO_LARGE',
    );
  });

  it('fails MODEL_UNAVAILABLE when the selected profile lacks required text', () => {
    const catalog = testCatalog({
      'page-standard': testEntry('page-standard', {
        capabilities: { text: false, vision: false, structuredOutput: true, reasoning: true },
      }),
    });

    assert.throws(
      () =>
        routeModelRequest(
          {
            taskClass: 'page_question',
            needsVision: false,
            privacy: 'remoteAllowed',
            estimatedInputTokens: 10,
          },
          catalog,
        ),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'MODEL_UNAVAILABLE',
    );
  });
});
