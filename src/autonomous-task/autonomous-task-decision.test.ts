import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from '../ai/model-errors';
import {
  MAX_AUTONOMOUS_SUBGOAL_INSTRUCTION_CHARS,
  parseAutonomousTaskDecision,
} from './autonomous-task-decision';

function assertInvalid(input: unknown): void {
  assert.throws(
    () => parseAutonomousTaskDecision(input),
    (error: unknown) => error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
  );
}

describe('parseAutonomousTaskDecision', () => {
  it('parses delegate-subgoal, request-user-input, and complete decisions', () => {
    assert.deepEqual(
      parseAutonomousTaskDecision({
        kind: 'delegate-subgoal',
        taskTabAlias: 'task-tab-1',
        instruction: 'Compare refundable prices',
      }),
      {
        kind: 'delegate-subgoal',
        taskTabAlias: 'task-tab-1',
        instruction: 'Compare refundable prices',
      },
    );
    assert.deepEqual(
      parseAutonomousTaskDecision({
        kind: 'request-user-input',
        question: 'Which account should I use?',
      }),
      {
        kind: 'request-user-input',
        question: 'Which account should I use?',
      },
    );
    assert.deepEqual(
      parseAutonomousTaskDecision({
        kind: 'complete',
        answer: 'The lowest total price is plan B.',
      }),
      {
        kind: 'complete',
        answer: 'The lowest total price is plan B.',
      },
    );
  });

  it('trims delegate-subgoal and request-user-input strings', () => {
    assert.deepEqual(
      parseAutonomousTaskDecision({
        kind: 'delegate-subgoal',
        taskTabAlias: '  task-tab-1  ',
        instruction: '  Open settings  ',
      }),
      {
        kind: 'delegate-subgoal',
        taskTabAlias: 'task-tab-1',
        instruction: 'Open settings',
      },
    );
  });

  it('rejects unknown kinds, missing fields, extra fields, and authority fields', () => {
    assertInvalid({ kind: 'click', taskTabAlias: 'task-tab-1', instruction: 'x' });
    assertInvalid({ kind: 'delegate-subgoal', taskTabAlias: 'task-tab-1' });
    assertInvalid({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-1',
      instruction: 'Buy',
      approved: true,
    });
    assertInvalid({
      kind: 'complete',
      answer: 'Done',
      executionId: 'fake',
    });
    assertInvalid({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-1',
      instruction: 'Continue',
      unlimited: true,
    });
    assertInvalid({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-1',
      instruction: 'Continue',
      targetId: 'target-1',
    });
    assertInvalid(null);
    assertInvalid([]);
  });

  it('rejects empty alias, empty instruction, oversized instruction, and empty question', () => {
    assertInvalid({
      kind: 'delegate-subgoal',
      taskTabAlias: '   ',
      instruction: 'Open settings',
    });
    assertInvalid({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-1',
      instruction: '   ',
    });
    assertInvalid({
      kind: 'delegate-subgoal',
      taskTabAlias: 'task-tab-1',
      instruction: 'x'.repeat(MAX_AUTONOMOUS_SUBGOAL_INSTRUCTION_CHARS + 1),
    });
    assertInvalid({
      kind: 'request-user-input',
      question: '   ',
    });
  });
});
