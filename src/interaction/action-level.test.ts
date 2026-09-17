import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { interactionPolicyRequirement } from './action-level';

describe('interactionPolicyRequirement', () => {
  it('maps scroll to NAVIGATE', () => {
    assert.equal(
      interactionPolicyRequirement({
        kind: 'scroll',
        mode: 'viewport',
        direction: 'down',
        amountPx: 100,
      }),
      'NAVIGATE',
    );
  });

  it('maps type and select to INTERACT', () => {
    assert.equal(
      interactionPolicyRequirement({ kind: 'type', targetId: 'target-1', text: 'hello' }),
      'INTERACT',
    );
    assert.equal(
      interactionPolicyRequirement({
        kind: 'select',
        targetId: 'select-1',
        optionTargetId: 'option-1',
      }),
      'INTERACT',
    );
  });

  it('does not assign click an unconditional authority level', () => {
    assert.equal(
      interactionPolicyRequirement({ kind: 'click', targetId: 'target-1' }),
      'SEMANTIC_POLICY',
    );
  });
});
