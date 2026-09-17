import type { TargetId } from '../shared/observation-types';

export type ModelAlias =
  | 'page-fast'
  | 'page-standard'
  | 'page-deep'
  | 'page-vision';

export const MODEL_ALIASES: readonly ModelAlias[] = [
  'page-fast',
  'page-standard',
  'page-deep',
  'page-vision',
];

export type TaskClass =
  | 'page_summary'
  | 'page_question'
  | 'page_analysis'
  | 'comparison'
  | 'extraction';

export type ModelPrivacyRequirement = 'remoteAllowed' | 'localOnly';

export type CostTier = 'low' | 'medium' | 'high';

export type LatencyTier = 'fast' | 'balanced' | 'slow';

export interface ModelCapabilities {
  readonly text: boolean;
  readonly vision: boolean;
  readonly structuredOutput: boolean;
  readonly reasoning: boolean;
}

export interface ModelProfile {
  readonly alias: ModelAlias;
  readonly providerModelId: string;
  readonly provider: 'ai-gateway';
  readonly capabilities: ModelCapabilities;
  readonly contextWindowTokens: number;
  /**
   * Product output cap for this alias,
   * not necessarily the provider model's absolute maximum.
   */
  readonly maxOutputTokens: number;
  readonly costTier: CostTier;
  readonly latencyTier: LatencyTier;
  readonly requestTimeoutMs: number;
  readonly fallbackAlias?: ModelAlias;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export type CostKnowledge = 'known' | 'estimated' | 'unknown';

export interface ModelCost {
  knowledge: CostKnowledge;
  amountUsd?: number;
  currency: 'USD';
}

export type ModelMessageRole = 'system' | 'user';

export type ModelMessagePart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      mimeType: 'image/jpeg';
      dataBase64: string;
    };

export interface ModelMessage {
  role: ModelMessageRole;
  content: ModelMessagePart[];
}

export interface ModelRequest {
  requestId: string;
  messages: ModelMessage[];
  profile: ModelProfile;
}

export interface ModelResponse {
  text: string;
  referencedTargets: TargetId[];
  usage?: ModelUsage;
  cost?: ModelCost;
  resolvedProviderModelId: string;
  latencyMs: number;
}
