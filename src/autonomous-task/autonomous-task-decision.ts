import { ModelError } from '../ai/model-errors';

export const MAX_AUTONOMOUS_SUBGOAL_INSTRUCTION_CHARS = 4000;

export interface AutonomousTaskDelegateSubgoalDecision {
  readonly kind: 'delegate-subgoal';
  readonly taskTabAlias: string;
  readonly instruction: string;
}

export interface AutonomousTaskRequestUserInputDecision {
  readonly kind: 'request-user-input';
  readonly question: string;
}

export interface AutonomousTaskCompleteDecision {
  readonly kind: 'complete';
  readonly answer: string;
}

export type AutonomousTaskDecision =
  | AutonomousTaskDelegateSubgoalDecision
  | AutonomousTaskRequestUserInputDecision
  | AutonomousTaskCompleteDecision;

const FORBIDDEN_DECISION_KEYS = new Set([
  'targetId',
  'observationId',
  'documentRevision',
  'backendNodeId',
  'frameId',
  'approvalId',
  'preparedActionId',
  'executionId',
  'grant',
  'InteractionGrant',
  'ExecuteGrant',
  'authority',
  'approved',
  'policyOutcome',
  'browserCoordinates',
  'cdpCommand',
  'runId',
  'taskId',
  'generation',
  'budget',
  'unlimited',
]);

export const AUTONOMOUS_TASK_DECISION_JSON_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'delegate-subgoal' },
        taskTabAlias: { type: 'string', minLength: 1 },
        instruction: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_AUTONOMOUS_SUBGOAL_INSTRUCTION_CHARS,
        },
      },
      required: ['kind', 'taskTabAlias', 'instruction'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'request-user-input' },
        question: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'question'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'complete' },
        answer: { type: 'string' },
      },
      required: ['kind', 'answer'],
    },
  ],
};

export function parseAutonomousTaskDecision(input: unknown): AutonomousTaskDecision {
  try {
    return parseAutonomousTaskDecisionInternal(input);
  } catch (error: unknown) {
    if (error instanceof ModelError) {
      throw error;
    }
    throw new ModelError('MODEL_OUTPUT_INVALID', 'The planner output was invalid.', { cause: error });
  }
}

function parseAutonomousTaskDecisionInternal(input: unknown): AutonomousTaskDecision {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'The planner output must be an object.');
  }

  const record = input as Record<string, unknown>;
  assertNoForbiddenKeys(record);

  const kind = record.kind;
  if (kind === 'delegate-subgoal') {
    return parseDelegateSubgoal(record);
  }
  if (kind === 'request-user-input') {
    return parseRequestUserInput(record);
  }
  if (kind === 'complete') {
    return parseComplete(record);
  }

  throw new ModelError('MODEL_OUTPUT_INVALID', 'The planner output kind is invalid.');
}

function parseDelegateSubgoal(record: Record<string, unknown>): AutonomousTaskDelegateSubgoalDecision {
  assertAllowedKeys(record, new Set(['kind', 'taskTabAlias', 'instruction']));
  const taskTabAlias = requireTrimmedNonEmptyString(record.taskTabAlias, 'taskTabAlias');
  const instruction = requireTrimmedNonEmptyString(record.instruction, 'instruction');
  if (instruction.length > MAX_AUTONOMOUS_SUBGOAL_INSTRUCTION_CHARS) {
    throw new ModelError(
      'MODEL_OUTPUT_INVALID',
      `Delegated instruction exceeds ${MAX_AUTONOMOUS_SUBGOAL_INSTRUCTION_CHARS} characters.`,
    );
  }
  return {
    kind: 'delegate-subgoal',
    taskTabAlias,
    instruction,
  };
}

function parseRequestUserInput(record: Record<string, unknown>): AutonomousTaskRequestUserInputDecision {
  assertAllowedKeys(record, new Set(['kind', 'question']));
  const question = requireTrimmedNonEmptyString(record.question, 'question');
  return {
    kind: 'request-user-input',
    question,
  };
}

function parseComplete(record: Record<string, unknown>): AutonomousTaskCompleteDecision {
  assertAllowedKeys(record, new Set(['kind', 'answer']));
  if (typeof record.answer !== 'string') {
    throw new ModelError('MODEL_OUTPUT_INVALID', 'Planner answer must be a string.');
  }
  return {
    kind: 'complete',
    answer: record.answer,
  };
}

function assertNoForbiddenKeys(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_DECISION_KEYS.has(key)) {
      throw new ModelError('MODEL_OUTPUT_INVALID', `Planner output must not include forbidden field: ${key}`);
    }
  }
}

function assertAllowedKeys(record: Record<string, unknown>, allowedKeys: Set<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new ModelError('MODEL_OUTPUT_INVALID', `Planner output contains unknown field: ${key}`);
    }
  }
}

function requireTrimmedNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ModelError('MODEL_OUTPUT_INVALID', `${label} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ModelError('MODEL_OUTPUT_INVALID', `${label} must be a non-empty string.`);
  }
  return trimmed;
}
