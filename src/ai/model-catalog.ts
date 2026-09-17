import { ModelError } from './model-errors';
import {
  MODEL_ALIASES,
  type ModelAlias,
  type ModelCapabilities,
  type ModelProfile,
} from './model-types';

/**
 * Retrieved 2026-09-17 from GET https://ai-gateway.vercel.sh/v1/models
 * (unauthenticated OpenAI-style list). Catalog slugs and context windows
 * come from that response; they are not fetched at app runtime.
 */
export type GatewayProviderSort = 'cost' | 'ttft' | 'tps';

export interface GatewayCatalogMetadata {
  readonly sort?: GatewayProviderSort;
}

export interface ModelCatalogEntry {
  readonly profile: ModelProfile;
  readonly gateway: GatewayCatalogMetadata;
}

export type ModelCatalog = Readonly<Record<ModelAlias, ModelCatalogEntry>>;

const TEXT_VISION_STRUCTURED_REASONING: ModelCapabilities = Object.freeze({
  text: true,
  vision: true,
  structuredOutput: true,
  reasoning: true,
});

function entry(
  profile: ModelProfile,
  gateway: GatewayCatalogMetadata,
): ModelCatalogEntry {
  return Object.freeze({
    profile: Object.freeze({
      ...profile,
      capabilities: Object.freeze({ ...profile.capabilities }),
    }),
    gateway: Object.freeze({ ...gateway }),
  });
}

export const MODEL_CATALOG: ModelCatalog = Object.freeze({
  // Cheap high-volume summaries/extraction. Live: language, text in/out,
  // 400_000 context, tools + reasoning. OpenAI structured outputs via Gateway.
  'page-fast': entry(
    {
      alias: 'page-fast',
      providerModelId: 'openai/gpt-5-nano',
      provider: 'ai-gateway',
      capabilities: TEXT_VISION_STRUCTURED_REASONING,
      contextWindowTokens: 400_000,
      maxOutputTokens: 1024,
      costTier: 'low',
      latencyTier: 'fast',
      requestTimeoutMs: 30_000,
      fallbackAlias: 'page-standard',
    },
    { sort: 'cost' },
  ),

  // Default page Q&A. Live: language, text in/out, 1_000_000 context,
  // tools + reasoning. AI SDK Output.object via tool-use on Gateway.
  'page-standard': entry(
    {
      alias: 'page-standard',
      providerModelId: 'google/gemini-2.5-flash',
      provider: 'ai-gateway',
      capabilities: TEXT_VISION_STRUCTURED_REASONING,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 2048,
      costTier: 'medium',
      latencyTier: 'balanced',
      requestTimeoutMs: 60_000,
      fallbackAlias: 'page-deep',
    },
    { sort: 'ttft' },
  ),

  // Hard analysis/comparison. Live: language, text in/out, 1_000_000 context,
  // tools + reasoning. Gateway Anthropic structured-output docs use this slug.
  'page-deep': entry(
    {
      alias: 'page-deep',
      providerModelId: 'anthropic/claude-sonnet-5',
      provider: 'ai-gateway',
      capabilities: TEXT_VISION_STRUCTURED_REASONING,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 4096,
      costTier: 'high',
      latencyTier: 'slow',
      requestTimeoutMs: 120_000,
    },
    {},
  ),

  // Screenshot/layout/charts. Live: language, image+text in, text out,
  // 1_000_000 context, vision + tools. Distinct from page-deep.
  'page-vision': entry(
    {
      alias: 'page-vision',
      providerModelId: 'google/gemini-3-flash',
      provider: 'ai-gateway',
      capabilities: TEXT_VISION_STRUCTURED_REASONING,
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 2048,
      costTier: 'medium',
      latencyTier: 'balanced',
      requestTimeoutMs: 90_000,
    },
    { sort: 'ttft' },
  ),
});

assertCatalogInvariants(MODEL_CATALOG);

export function getModelProfile(
  alias: ModelAlias,
  catalog: ModelCatalog = MODEL_CATALOG,
): ModelProfile {
  return catalog[alias].profile;
}

export function getGatewayCatalogMetadata(
  alias: ModelAlias,
  catalog: ModelCatalog = MODEL_CATALOG,
): GatewayCatalogMetadata {
  return catalog[alias].gateway;
}

export function assertCatalogInvariants(catalog: ModelCatalog): void {
  const aliases = Object.keys(catalog) as ModelAlias[];
  if (aliases.length !== MODEL_ALIASES.length) {
    throw new ModelError(
      'MODEL_UNAVAILABLE',
      `Model catalog must contain exactly ${MODEL_ALIASES.length} aliases.`,
    );
  }

  for (const alias of MODEL_ALIASES) {
    const catalogEntry = catalog[alias];
    if (!catalogEntry) {
      throw new ModelError('MODEL_UNAVAILABLE', `Missing catalog entry for ${alias}.`);
    }

    const { profile } = catalogEntry;
    if (profile.alias !== alias) {
      throw new ModelError(
        'MODEL_UNAVAILABLE',
        `Catalog key ${alias} does not match profile.alias ${profile.alias}.`,
      );
    }
    if (profile.providerModelId.trim() === '') {
      throw new ModelError('MODEL_UNAVAILABLE', `${alias} has an empty providerModelId.`);
    }
    if (profile.contextWindowTokens <= 0 || !Number.isInteger(profile.contextWindowTokens)) {
      throw new ModelError('MODEL_UNAVAILABLE', `${alias} contextWindowTokens must be a positive integer.`);
    }
    if (profile.maxOutputTokens <= 0 || !Number.isInteger(profile.maxOutputTokens)) {
      throw new ModelError('MODEL_UNAVAILABLE', `${alias} maxOutputTokens must be a positive integer.`);
    }
    if (profile.requestTimeoutMs <= 0 || !Number.isInteger(profile.requestTimeoutMs)) {
      throw new ModelError('MODEL_UNAVAILABLE', `${alias} requestTimeoutMs must be a positive integer.`);
    }
    if (profile.capabilities.text !== true) {
      throw new ModelError('MODEL_UNAVAILABLE', `${alias} must support text.`);
    }
  }

  if (catalog['page-vision'].profile.capabilities.vision !== true) {
    throw new ModelError('MODEL_UNAVAILABLE', 'page-vision must support vision.');
  }

  assertFallbackGraph(catalog);
}

function assertFallbackGraph(catalog: ModelCatalog): void {
  for (const alias of MODEL_ALIASES) {
    const fallback = catalog[alias].profile.fallbackAlias;
    if (fallback === undefined) {
      continue;
    }
    if (fallback === alias) {
      throw new ModelError('MODEL_UNAVAILABLE', `${alias} cannot fall back to itself.`);
    }
    if (!catalog[fallback]) {
      throw new ModelError(
        'MODEL_UNAVAILABLE',
        `${alias} fallbackAlias ${fallback} is not in the catalog.`,
      );
    }
  }

  for (const start of MODEL_ALIASES) {
    const seen = new Set<ModelAlias>();
    let current: ModelAlias | undefined = start;
    while (current !== undefined) {
      if (seen.has(current)) {
        throw new ModelError('MODEL_UNAVAILABLE', `Fallback cycle involving ${start}.`);
      }
      seen.add(current);
      current = catalog[current].profile.fallbackAlias;
    }
  }
}
