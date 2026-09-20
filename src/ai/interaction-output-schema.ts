import { InteractionError } from '../shared/interaction-errors';
import {
  INTERACTION_SCROLL_DIRECTIONS,
  MAX_INTERACTION_SCROLL_AMOUNT_PX,
  MAX_INTERACTION_TYPE_TEXT_LENGTH,
  type ModelInteractionProposal,
} from '../shared/interaction-types';
import type { TargetId } from '../shared/observation-types';
import { parseModelInteractionProposal } from '../interaction/proposal-validator';
import { ModelError } from './model-errors';

export const AGENT_ANSWER_DISPOSITIONS = [
  'informational',
  'cannot-complete',
  'needs-clarification',
  'task-complete',
] as const;
export type AgentAnswerDisposition = (typeof AGENT_ANSWER_DISPOSITIONS)[number];

export interface AgentModelAnswerOutput {
  kind: 'answer';
  disposition?: AgentAnswerDisposition;
  text: string;
  referencedTargets: TargetId[];
}

export const AGENT_TASK_CONTINUATIONS = ['continue', 'complete-on-success'] as const;
export type AgentTaskContinuation = (typeof AGENT_TASK_CONTINUATIONS)[number];

export const MAX_ON_SUCCESS_TEXT_LENGTH = 280;
export const DEFAULT_TASK_COMPLETION_TEXT = 'Done.';

export interface AgentModelInteractionOutput {
  kind: 'interaction';
  proposal: ModelInteractionProposal;
  continuation?: AgentTaskContinuation;
  onSuccessText?: string;
}

export type AgentModelOutput = AgentModelAnswerOutput | AgentModelInteractionOutput;

const FORBIDDEN_TOP_LEVEL_KEYS = new Set([
  'tabId',
  'observationId',
  'documentRevision',
  'frameId',
  'backendNodeId',
  'actionId',
  'grant',
  'authority',
  'policyOutcome',
]);

const PROPOSAL_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'click' },
        targetId: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'targetId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'type' },
        targetId: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1, maxLength: MAX_INTERACTION_TYPE_TEXT_LENGTH },
      },
      required: ['kind', 'targetId', 'text'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'select' },
        targetId: { type: 'string', minLength: 1 },
        optionTargetId: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'targetId', 'optionTargetId'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'scroll' },
        mode: { const: 'viewport' },
        direction: { type: 'string', enum: [...INTERACTION_SCROLL_DIRECTIONS] },
        amountPx: { type: 'integer', minimum: 1, maximum: MAX_INTERACTION_SCROLL_AMOUNT_PX },
      },
      required: ['kind', 'mode', 'direction', 'amountPx'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'scroll' },
        mode: { const: 'into-view' },
        targetId: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'mode', 'targetId'],
    },
  ],
};

export const AGENT_MODEL_OUTPUT_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'answer' },
        disposition: { type: 'string', enum: [...AGENT_ANSWER_DISPOSITIONS] },
        text: { type: 'string' },
        referencedTargets: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      required: ['kind', 'disposition', 'text', 'referencedTargets'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'interaction' },
        proposal: PROPOSAL_JSON_SCHEMA,
        continuation: { type: 'string', enum: [...AGENT_TASK_CONTINUATIONS] },
        onSuccessText: { type: 'string', minLength: 1, maxLength: MAX_ON_SUCCESS_TEXT_LENGTH },
      },
      required: ['kind', 'proposal', 'continuation'],
    },
  ],
};

export function parseAgentModelOutput(input: unknown): AgentModelOutput {
  try {
    return parseAgentModelOutputInternal(input);
  } catch (error: unknown) {
    if (error instanceof InteractionError) {
      throw new ModelError('MODEL_OUTPUT_INVALID', 'The model output was invalid.', { cause: error });
    }
    if (error instanceof ModelError) {
      throw error;
    }
    throw new ModelError('MODEL_OUTPUT_INVALID', 'The model output was invalid.', { cause: error });
  }
}

function parseAgentModelOutputInternal(input: unknown): AgentModelOutput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'The model output must be an object.');
  }

  const record = input as Record<string, unknown>;
  assertNoForbiddenTopLevelKeys(record);

  const kind = record.kind;
  if (kind === 'answer') {
    return parseAnswerOutput(record);
  }
  if (kind === 'interaction') {
    return parseInteractionOutput(record);
  }

  throw new ModelError('MODEL_OUTPUT_INVALID', 'The model output kind must be answer or interaction.');
}

function parseAnswerOutput(record: Record<string, unknown>): AgentModelAnswerOutput {
  assertAllowedKeys(record, new Set(['kind', 'disposition', 'text', 'referencedTargets']));

  if (typeof record.text !== 'string') {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'Answer text must be a string.');
  }

  if (
    !Array.isArray(record.referencedTargets) ||
    !record.referencedTargets.every((item) => typeof item === 'string')
  ) {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'referencedTargets must be an array of strings.');
  }

  return {
    kind: 'answer',
    disposition: parseAnswerDisposition(record.disposition),
    text: record.text,
    referencedTargets: record.referencedTargets,
  };
}

function parseAnswerDisposition(value: unknown): AgentAnswerDisposition {
  if (value === undefined) {
    return 'task-complete';
  }
  if (
    value !== 'informational' &&
    value !== 'cannot-complete' &&
    value !== 'needs-clarification' &&
    value !== 'task-complete'
  ) {
    throw new ModelError(
      'MODEL_OUTPUT_INVALID',
      'Answer disposition must be informational, cannot-complete, needs-clarification, or task-complete.',
    );
  }
  return value;
}

function parseInteractionOutput(record: Record<string, unknown>): AgentModelInteractionOutput {
  assertAllowedKeys(record, new Set(['kind', 'proposal', 'continuation', 'onSuccessText']));

  if (typeof record.proposal !== 'object' || record.proposal === null || Array.isArray(record.proposal)) {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'Interaction proposal must be an object.');
  }

  const proposal = parseModelInteractionProposal(record.proposal);
  const continuation = parseContinuation(record.continuation, proposal.kind);
  const onSuccessText = parseOnSuccessText(record.onSuccessText);

  return {
    kind: 'interaction',
    proposal,
    continuation,
    ...(onSuccessText !== undefined ? { onSuccessText } : {}),
  };
}

function parseContinuation(
  value: unknown,
  proposalKind: ModelInteractionProposal['kind'],
): AgentTaskContinuation {
  if (value === undefined) {
    return 'continue';
  }
  if (value !== 'continue' && value !== 'complete-on-success') {
    throw new ModelError(
      'MODEL_OUTPUT_INVALID',
      'Interaction continuation must be continue or complete-on-success.',
    );
  }
  if (proposalKind === 'scroll') {
    return 'continue';
  }
  return value;
}

function parseOnSuccessText(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'onSuccessText must be a string.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed.length > MAX_ON_SUCCESS_TEXT_LENGTH) {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'onSuccessText exceeds the allowed length.');
  }
  return trimmed;
}

function assertNoForbiddenTopLevelKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_TOP_LEVEL_KEYS.has(key)) {
      throw new ModelError('MODEL_OUTPUT_INVALID', `Model output must not include forbidden field: ${key}`);
    }
  }
}

function assertAllowedKeys(record: Record<string, unknown>, allowedKeys: Set<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ModelError('MODEL_OUTPUT_INVALID', `Model output contains unknown field: ${key}`);
    }
  }
}
