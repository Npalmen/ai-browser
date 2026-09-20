import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from './model-errors';
import { MAX_INTERACTION_TYPE_TEXT_LENGTH } from '../shared/interaction-types';
import {
  MAX_ON_SUCCESS_TEXT_LENGTH,
  parseAgentModelOutput,
  trustedCannotCompleteCopy,
} from './interaction-output-schema';

function isModelOutputInvalid(error: unknown): boolean {
  return error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID';
}

describe('parseAgentModelOutput', () => {
  it('parses a valid answer output', () => {
    const parsed = parseAgentModelOutput({
      kind: 'answer',
      disposition: 'needs-clarification',
      text: 'Which button?',
      referencedTargets: ['target-1'],
    });

    assert.equal(parsed.kind, 'answer');
    if (parsed.kind === 'answer') {
      assert.equal(parsed.disposition, 'needs-clarification');
      assert.equal(parsed.text, 'Which button?');
      assert.deepEqual(parsed.referencedTargets, ['target-1']);
    }
  });

  it('defaults missing answer disposition to task-complete', () => {
    const parsed = parseAgentModelOutput({
      kind: 'answer',
      text: 'Jag klickade på WebDriverIO.',
      referencedTargets: [],
    });
    assert.equal(parsed.kind, 'answer');
    if (parsed.kind === 'answer') {
      assert.equal(parsed.disposition, 'task-complete');
    }
  });

  it('parses cannot-complete with a structured reason and ignores success-style text', () => {
    const parsed = parseAgentModelOutput({
      kind: 'answer',
      disposition: 'cannot-complete',
      cannotCompleteReason: 'target-not-found',
      text: 'Clicked WebdriverIO.',
      referencedTargets: [],
    });
    assert.equal(parsed.kind, 'answer');
    if (parsed.kind === 'answer') {
      assert.equal(parsed.disposition, 'cannot-complete');
      assert.equal(parsed.cannotCompleteReason, 'target-not-found');
      assert.equal(trustedCannotCompleteCopy('target-not-found'), "I couldn't find the requested target.");
    }
  });

  it('defaults missing cannotCompleteReason to other', () => {
    const parsed = parseAgentModelOutput({
      kind: 'answer',
      disposition: 'cannot-complete',
      referencedTargets: [],
    });
    assert.equal(parsed.kind, 'answer');
    if (parsed.kind === 'answer') {
      assert.equal(parsed.cannotCompleteReason, 'other');
    }
  });

  it('rejects informational as an Act answer disposition', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'answer',
          disposition: 'informational',
          text: 'No browser action was performed.',
          referencedTargets: [],
        }),
      isModelOutputInvalid,
    );
  });

  it('rejects invalid answer dispositions', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'answer',
          disposition: 'clicked',
          text: 'x',
          referencedTargets: [],
        }),
      isModelOutputInvalid,
    );
  });

  it('parses a valid interaction click proposal', () => {
    const parsed = parseAgentModelOutput({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: 'target-1',
      },
      continuation: 'complete-on-success',
      onSuccessText: 'WebDriverIO har öppnats.',
    });

    assert.equal(parsed.kind, 'interaction');
    if (parsed.kind === 'interaction') {
      assert.equal(parsed.proposal.kind, 'click');
      assert.equal(parsed.proposal.targetId, 'target-1');
      assert.equal(parsed.continuation, 'complete-on-success');
      assert.equal(parsed.onSuccessText, 'WebDriverIO har öppnats.');
    }
  });

  it('defaults missing continuation to continue and never treats it as authority', () => {
    const parsed = parseAgentModelOutput({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: 'target-1',
      },
    });
    assert.equal(parsed.kind, 'interaction');
    if (parsed.kind === 'interaction') {
      assert.equal(parsed.continuation, 'continue');
    }
  });

  it('forces scroll proposals to continuation continue', () => {
    const parsed = parseAgentModelOutput({
      kind: 'interaction',
      proposal: {
        kind: 'scroll',
        mode: 'viewport',
        direction: 'down',
        amountPx: 400,
      },
      continuation: 'complete-on-success',
    });
    assert.equal(parsed.kind, 'interaction');
    if (parsed.kind === 'interaction') {
      assert.equal(parsed.continuation, 'continue');
    }
  });

  it('rejects forbidden authority fields at the top level', () => {
    for (const field of [
      'tabId',
      'observationId',
      'documentRevision',
      'frameId',
      'backendNodeId',
      'actionId',
      'grant',
      'authority',
    ]) {
      assert.throws(
        () =>
          parseAgentModelOutput({
            kind: 'answer',
            text: 'x',
            referencedTargets: [],
            [field]: 'evil',
          }),
        isModelOutputInvalid,
      );
    }
  });

  it('rejects forbidden authority fields inside proposal', () => {
    for (const field of ['tabId', 'observationId', 'documentRevision', 'frameId', 'backendNodeId']) {
      assert.throws(
        () =>
          parseAgentModelOutput({
            kind: 'interaction',
            proposal: {
              kind: 'click',
              targetId: 'target-1',
              [field]: 'evil',
            },
          }),
        isModelOutputInvalid,
      );
    }
  });

  it('rejects extra top-level fields on answer output', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'answer',
          text: 'x',
          referencedTargets: [],
          extra: true,
        }),
      isModelOutputInvalid,
    );
  });

  it('rejects extra answer fields', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'answer',
          text: 'x',
          referencedTargets: [],
          reasoning: 'hidden',
        }),
      isModelOutputInvalid,
    );
  });

  it('rejects unknown kind values', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'actions',
          items: [],
        }),
      isModelOutputInvalid,
    );
  });

  it('rejects oversized type text', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'interaction',
          proposal: {
            kind: 'type',
            targetId: 'target-1',
            text: 'x'.repeat(MAX_INTERACTION_TYPE_TEXT_LENGTH + 1),
          },
        }),
      isModelOutputInvalid,
    );
  });

  it('rejects oversized onSuccessText', () => {
    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'interaction',
          proposal: { kind: 'click', targetId: 'target-1' },
          continuation: 'complete-on-success',
          onSuccessText: 'x'.repeat(MAX_ON_SUCCESS_TEXT_LENGTH + 1),
        }),
      isModelOutputInvalid,
    );
  });
});
