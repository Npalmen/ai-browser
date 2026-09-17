import { getModelProfile, type ModelCatalog, MODEL_CATALOG } from './model-catalog';
import { ModelError } from './model-errors';
import type {
  ModelAlias,
  ModelPrivacyRequirement,
  ModelProfile,
  TaskClass,
} from './model-types';

export interface RouteModelRequestInput {
  taskClass: TaskClass;
  needsVision: boolean;
  privacy: ModelPrivacyRequirement;
  estimatedInputTokens: number;
}

export interface ModelRoute {
  alias: ModelAlias;
  profile: ModelProfile;
}

/**
 * Context overflow with no eligible one-step fallback returns CONTEXT_TOO_LARGE,
 * including when a configured fallback lacks required capabilities (e.g. vision).
 */
export function routeModelRequest(
  input: RouteModelRequestInput,
  catalog: ModelCatalog = MODEL_CATALOG,
): ModelRoute {
  if (input.privacy === 'localOnly') {
    throw new ModelError(
      'MODEL_NOT_CONFIGURED',
      'No local model adapter is configured; remote models are not used for localOnly requests.',
    );
  }

  if (!Number.isInteger(input.estimatedInputTokens) || input.estimatedInputTokens < 0) {
    throw new ModelError(
      'MODEL_REQUEST_FAILED',
      'estimatedInputTokens must be a non-negative integer.',
    );
  }

  const alias = input.needsVision ? 'page-vision' : aliasForTaskClass(input.taskClass);
  const profile = getModelProfile(alias, catalog);
  assertRequiredCapabilities(profile, input.needsVision);

  if (profileFitsContext(profile, input.estimatedInputTokens)) {
    return { alias: profile.alias, profile };
  }

  const fallbackAlias = profile.fallbackAlias;
  if (fallbackAlias === undefined) {
    throw new ModelError(
      'CONTEXT_TOO_LARGE',
      `${alias} cannot fit the estimated input and has no fallback.`,
    );
  }

  const fallback = getModelProfile(fallbackAlias, catalog);
  if (
    !profileHasRequiredCapabilities(fallback, input.needsVision) ||
    !profileFitsContext(fallback, input.estimatedInputTokens)
  ) {
    throw new ModelError(
      'CONTEXT_TOO_LARGE',
      `${alias} cannot fit the estimated input and fallback ${fallbackAlias} is not eligible.`,
    );
  }

  return { alias: fallback.alias, profile: fallback };
}

function aliasForTaskClass(taskClass: TaskClass): ModelAlias {
  switch (taskClass) {
    case 'page_summary':
      return 'page-fast';
    case 'page_question':
    case 'extraction':
      return 'page-standard';
    case 'page_analysis':
    case 'comparison':
      return 'page-deep';
    default: {
      const exhaustive: never = taskClass;
      throw new ModelError('MODEL_UNAVAILABLE', `Unsupported task class: ${exhaustive}`);
    }
  }
}

function profileFitsContext(profile: ModelProfile, estimatedInputTokens: number): boolean {
  return estimatedInputTokens + profile.maxOutputTokens <= profile.contextWindowTokens;
}

function profileHasRequiredCapabilities(profile: ModelProfile, needsVision: boolean): boolean {
  if (profile.capabilities.text !== true) {
    return false;
  }
  if (needsVision && profile.capabilities.vision !== true) {
    return false;
  }
  return true;
}

function assertRequiredCapabilities(profile: ModelProfile, needsVision: boolean): void {
  if (!profileHasRequiredCapabilities(profile, needsVision)) {
    throw new ModelError(
      'MODEL_UNAVAILABLE',
      `${profile.alias} does not support the required capabilities.`,
    );
  }
}
