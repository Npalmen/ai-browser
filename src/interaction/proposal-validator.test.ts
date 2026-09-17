import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import {
  MAX_INTERACTION_SCROLL_AMOUNT_PX,
  MAX_INTERACTION_TYPE_TEXT_LENGTH,
} from '../shared/interaction-types';
import { parseModelInteractionProposal } from './proposal-validator';

function assertInvalid(input: unknown, messageIncludes?: string): void {
  assert.throws(
    () => parseModelInteractionProposal(input),
    (error: unknown) => {
      assert.ok(error instanceof InteractionError);
      assert.equal(error.code, 'INVALID_INTERACTION_PROPOSAL');
      if (messageIncludes !== undefined) {
        assert.match(error.message, new RegExp(messageIncludes));
      }
      return true;
    },
  );
}

describe('parseModelInteractionProposal', () => {
  it('accepts a valid click proposal', () => {
    const parsed = parseModelInteractionProposal({ kind: 'click', targetId: 'target-1' });
    assert.deepEqual(parsed, { kind: 'click', targetId: 'target-1' });
  });

  it('accepts a valid type proposal', () => {
    const parsed = parseModelInteractionProposal({
      kind: 'type',
      targetId: 'target-1',
      text: 'hello',
    });
    assert.deepEqual(parsed, { kind: 'type', targetId: 'target-1', text: 'hello' });
  });

  it('accepts a valid select proposal', () => {
    const parsed = parseModelInteractionProposal({
      kind: 'select',
      targetId: 'select-1',
      optionTargetId: 'option-1',
    });
    assert.deepEqual(parsed, {
      kind: 'select',
      targetId: 'select-1',
      optionTargetId: 'option-1',
    });
  });

  it('accepts a valid viewport scroll proposal', () => {
    const parsed = parseModelInteractionProposal({
      kind: 'scroll',
      mode: 'viewport',
      direction: 'down',
      amountPx: 240,
    });
    assert.deepEqual(parsed, {
      kind: 'scroll',
      mode: 'viewport',
      direction: 'down',
      amountPx: 240,
    });
  });

  it('accepts a valid into-view scroll proposal', () => {
    const parsed = parseModelInteractionProposal({
      kind: 'scroll',
      mode: 'into-view',
      targetId: 'target-1',
    });
    assert.deepEqual(parsed, {
      kind: 'scroll',
      mode: 'into-view',
      targetId: 'target-1',
    });
  });

  it('rejects null, array, string, and number inputs', () => {
    assertInvalid(null);
    assertInvalid([]);
    assertInvalid('click');
    assertInvalid(42);
  });

  it('rejects unknown kind and missing kind', () => {
    assertInvalid({ kind: 'hover' }, 'Unknown interaction proposal kind');
    assertInvalid({ targetId: 'target-1' }, 'kind must be a string');
  });

  it('rejects missing targetId and wrong targetId type', () => {
    assertInvalid({ kind: 'click' }, 'targetId');
    assertInvalid({ kind: 'click', targetId: 1 }, 'targetId must be a string');
    assertInvalid({ kind: 'click', targetId: '' }, 'must not be empty');
    assertInvalid({ kind: 'click', targetId: '   ' }, 'must not be empty');
  });

  it('rejects empty type text and oversized type text', () => {
    assertInvalid({ kind: 'type', targetId: 'target-1', text: '' }, 'must not be empty');
    assertInvalid(
      {
        kind: 'type',
        targetId: 'target-1',
        text: 'x'.repeat(MAX_INTERACTION_TYPE_TEXT_LENGTH + 1),
      },
      `${MAX_INTERACTION_TYPE_TEXT_LENGTH}`,
    );
  });

  it('rejects select proposals with missing or empty optionTargetId', () => {
    assertInvalid({ kind: 'select', targetId: 'select-1' }, 'optionTargetId');
    assertInvalid(
      { kind: 'select', targetId: 'select-1', optionTargetId: '' },
      'optionTargetId',
    );
  });

  it('rejects invalid scroll direction and amount', () => {
    assertInvalid(
      { kind: 'scroll', mode: 'viewport', direction: 'diagonal', amountPx: 100 },
      'direction',
    );
    assertInvalid(
      { kind: 'scroll', mode: 'viewport', direction: 'down', amountPx: 0 },
      'greater than zero',
    );
    assertInvalid(
      { kind: 'scroll', mode: 'viewport', direction: 'down', amountPx: -10 },
      'greater than zero',
    );
    assertInvalid(
      { kind: 'scroll', mode: 'viewport', direction: 'down', amountPx: Number.NaN },
      'finite number',
    );
    assertInvalid(
      { kind: 'scroll', mode: 'viewport', direction: 'down', amountPx: Number.POSITIVE_INFINITY },
      'finite number',
    );
    assertInvalid(
      { kind: 'scroll', mode: 'viewport', direction: 'down', amountPx: 1.5 },
      'integer',
    );
    assertInvalid(
      {
        kind: 'scroll',
        mode: 'viewport',
        direction: 'down',
        amountPx: MAX_INTERACTION_SCROLL_AMOUNT_PX + 1,
      },
      `${MAX_INTERACTION_SCROLL_AMOUNT_PX}`,
    );
  });

  it('rejects unknown scroll mode', () => {
    assertInvalid({ kind: 'scroll', mode: 'page' }, 'viewport or into-view');
  });

  it('rejects arbitrary extra properties', () => {
    assertInvalid({ kind: 'click', targetId: 'target-1', extra: true }, 'unknown field');
  });

  it('rejects model-controlled tabId', () => {
    assertInvalid(
      { kind: 'click', targetId: 'target-1', tabId: 'tab-1' },
      'forbidden field: tabId',
    );
  });

  it('rejects model-controlled observationId', () => {
    assertInvalid(
      { kind: 'click', targetId: 'target-1', observationId: 'obs-1' },
      'forbidden field: observationId',
    );
  });

  it('rejects model-controlled documentRevision', () => {
    assertInvalid(
      { kind: 'click', targetId: 'target-1', documentRevision: 'rev-1' },
      'forbidden field: documentRevision',
    );
  });

  it('rejects model-controlled frameId', () => {
    assertInvalid(
      { kind: 'click', targetId: 'target-1', frameId: 'frame-1' },
      'forbidden field: frameId',
    );
  });

  it('rejects model-controlled backendNodeId', () => {
    assertInvalid(
      { kind: 'click', targetId: 'target-1', backendNodeId: 42 },
      'forbidden field: backendNodeId',
    );
  });
});
