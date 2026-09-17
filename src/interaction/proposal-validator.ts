import { InteractionError } from '../shared/interaction-errors';
import {
  INTERACTION_SCROLL_DIRECTIONS,
  MAX_INTERACTION_SCROLL_AMOUNT_PX,
  MAX_INTERACTION_TYPE_TEXT_LENGTH,
  type InteractionScrollDirection,
  type ModelClickProposal,
  type ModelInteractionProposal,
  type ModelScrollIntoViewProposal,
  type ModelScrollProposal,
  type ModelSelectProposal,
  type ModelTypeProposal,
  type ModelViewportScrollProposal,
} from '../shared/interaction-types';
import type { TargetId } from '../shared/observation-types';

const FORBIDDEN_MODEL_PROPOSAL_KEYS = new Set([
  'tabId',
  'observationId',
  'documentRevision',
  'frameId',
  'backendNodeId',
  'axNodeId',
]);

export function parseModelInteractionProposal(input: unknown): ModelInteractionProposal {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InteractionError('INVALID_INTERACTION_PROPOSAL', 'Interaction proposal must be an object.');
  }

  const record = input as Record<string, unknown>;

  const kind = record.kind;
  if (typeof kind !== 'string') {
    throw new InteractionError('INVALID_INTERACTION_PROPOSAL', 'Interaction proposal kind must be a string.');
  }

  switch (kind) {
    case 'click':
      return parseClickProposal(record);
    case 'type':
      return parseTypeProposal(record);
    case 'select':
      return parseSelectProposal(record);
    case 'scroll':
      return parseScrollProposal(record);
    default:
      throw new InteractionError('INVALID_INTERACTION_PROPOSAL', `Unknown interaction proposal kind: ${kind}`);
  }
}

function parseClickProposal(record: Record<string, unknown>): ModelClickProposal {
  assertAllowedKeys(record, new Set(['kind', 'targetId']));

  return {
    kind: 'click',
    targetId: parseTargetId(record.targetId, 'targetId'),
  };
}

function parseTypeProposal(record: Record<string, unknown>): ModelTypeProposal {
  assertAllowedKeys(record, new Set(['kind', 'targetId', 'text']));

  const text = parseTypeText(record.text);

  return {
    kind: 'type',
    targetId: parseTargetId(record.targetId, 'targetId'),
    text,
  };
}

function parseSelectProposal(record: Record<string, unknown>): ModelSelectProposal {
  assertAllowedKeys(record, new Set(['kind', 'targetId', 'optionTargetId']));

  return {
    kind: 'select',
    targetId: parseTargetId(record.targetId, 'targetId'),
    optionTargetId: parseTargetId(record.optionTargetId, 'optionTargetId'),
  };
}

function parseScrollProposal(record: Record<string, unknown>): ModelScrollProposal {
  const mode = record.mode;
  if (mode === 'viewport') {
    return parseViewportScrollProposal(record);
  }
  if (mode === 'into-view') {
    return parseScrollIntoViewProposal(record);
  }

  throw new InteractionError('INVALID_INTERACTION_PROPOSAL', 'Scroll proposal mode must be viewport or into-view.');
}

function parseViewportScrollProposal(record: Record<string, unknown>): ModelViewportScrollProposal {
  assertAllowedKeys(record, new Set(['kind', 'mode', 'direction', 'amountPx']));

  return {
    kind: 'scroll',
    mode: 'viewport',
    direction: parseScrollDirection(record.direction),
    amountPx: parseScrollAmount(record.amountPx),
  };
}

function parseScrollIntoViewProposal(record: Record<string, unknown>): ModelScrollIntoViewProposal {
  assertAllowedKeys(record, new Set(['kind', 'mode', 'targetId']));

  return {
    kind: 'scroll',
    mode: 'into-view',
    targetId: parseTargetId(record.targetId, 'targetId'),
  };
}

function assertAllowedKeys(record: Record<string, unknown>, allowedKeys: Set<string>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_MODEL_PROPOSAL_KEYS.has(key)) {
      throw new InteractionError(
        'INVALID_INTERACTION_PROPOSAL',
        `Interaction proposal must not include forbidden field: ${key}`,
      );
    }

    if (!allowedKeys.has(key)) {
      throw new InteractionError(
        'INVALID_INTERACTION_PROPOSAL',
        `Interaction proposal contains unknown field: ${key}`,
      );
    }
  }
}

function parseTargetId(value: unknown, fieldName: string): TargetId {
  if (typeof value !== 'string') {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      `Interaction proposal field ${fieldName} must be a string.`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      `Interaction proposal field ${fieldName} must not be empty.`,
    );
  }

  return trimmed;
}

function parseTypeText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new InteractionError('INVALID_INTERACTION_PROPOSAL', 'Type proposal text must be a string.');
  }

  if (value.length === 0) {
    throw new InteractionError('INVALID_INTERACTION_PROPOSAL', 'Type proposal text must not be empty.');
  }

  if (value.length > MAX_INTERACTION_TYPE_TEXT_LENGTH) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      `Type proposal text exceeds ${MAX_INTERACTION_TYPE_TEXT_LENGTH} characters.`,
    );
  }

  return value;
}

function parseScrollDirection(value: unknown): InteractionScrollDirection {
  if (typeof value !== 'string' || !INTERACTION_SCROLL_DIRECTIONS.includes(value as InteractionScrollDirection)) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      'Scroll proposal direction must be up, down, left, or right.',
    );
  }

  return value as InteractionScrollDirection;
}

function parseScrollAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      'Scroll proposal amountPx must be a finite number.',
    );
  }

  if (!Number.isInteger(value)) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      'Scroll proposal amountPx must be an integer.',
    );
  }

  if (value <= 0) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      'Scroll proposal amountPx must be greater than zero.',
    );
  }

  if (value > MAX_INTERACTION_SCROLL_AMOUNT_PX) {
    throw new InteractionError(
      'INVALID_INTERACTION_PROPOSAL',
      `Scroll proposal amountPx exceeds ${MAX_INTERACTION_SCROLL_AMOUNT_PX}.`,
    );
  }

  return value;
}
