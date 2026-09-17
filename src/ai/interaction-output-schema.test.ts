import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from './model-errors';
import { MAX_INTERACTION_TYPE_TEXT_LENGTH } from '../shared/interaction-types';
import { parseAgentModelOutput } from './interaction-output-schema';

function isModelOutputInvalid(error: unknown): boolean {
  return error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID';
}

describe('parseAgentModelOutput', () => {
  it('parses a valid answer output', () => {
    const parsed = parseAgentModelOutput({
      kind: 'answer',
      text: 'Hello',
      referencedTargets: ['target-1'],
    });

    assert.equal(parsed.kind, 'answer');
    if (parsed.kind === 'answer') {
      assert.equal(parsed.text, 'Hello');
      assert.deepEqual(parsed.referencedTargets, ['target-1']);
    }
  });

  it('parses a valid interaction click proposal', () => {
    const parsed = parseAgentModelOutput({
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: 'target-1',
      },
    });

    assert.equal(parsed.kind, 'interaction');
    if (parsed.kind === 'interaction') {
      assert.equal(parsed.proposal.kind, 'click');
      assert.equal(parsed.proposal.targetId, 'target-1');
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
});
