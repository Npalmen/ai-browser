import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundInteractionProposal } from '../shared/interaction-types';
import {
  assertGrantMatchesProposal,
  isAllowPolicyDecision,
  issueInteractionGrant,
} from './interaction-grant';

const clickProposal: BoundInteractionProposal = {
  kind: 'click',
  targetId: 'target-1',
  tabId: 'tab-1',
  observationId: 'obs-1',
  documentRevision: 'rev-1',
};

describe('interaction grant', () => {
  it('issues a frozen grant from an allow decision', () => {
    const grant = issueInteractionGrant(
      { outcome: 'ALLOW_INTERACT', authority: 'INTERACT' },
      clickProposal,
      'action-1',
      100,
    );

    assert.equal(grant.actionId, 'action-1');
    assert.equal(grant.authority, 'INTERACT');
    assert.equal(grant.kind, 'click');
    assert.equal(grant.targetId, 'target-1');
    assert.equal(grant.issuedAt, 100);
    assert.equal(Object.isFrozen(grant), true);
  });

  it('correlates grant identity with the bound proposal', () => {
    const grant = issueInteractionGrant(
      { outcome: 'ALLOW_NAVIGATE', authority: 'NAVIGATE' },
      clickProposal,
      'action-2',
      200,
    );

    assertGrantMatchesProposal(grant, clickProposal);
  });

  it('does not include typed text in grants', () => {
    const typeProposal: BoundInteractionProposal = {
      kind: 'type',
      targetId: 'target-1',
      text: 'AUDIT_TYPED_SECRET_DO_NOT_STORE',
      tabId: 'tab-1',
      observationId: 'obs-1',
      documentRevision: 'rev-1',
    };

    const grant = issueInteractionGrant(
      { outcome: 'ALLOW_INTERACT', authority: 'INTERACT' },
      typeProposal,
      'action-3',
      300,
    );

    assert.equal(JSON.stringify(grant).includes('AUDIT_TYPED_SECRET_DO_NOT_STORE'), false);
  });

  it('cannot issue grants from deny or defer decisions at the type level', () => {
    assert.equal(isAllowPolicyDecision({ outcome: 'DENY', errorCode: 'INTERACTION_DENIED' }), false);
    assert.equal(
      isAllowPolicyDecision({ outcome: 'DEFER_EXECUTE', errorCode: 'DEFERRED_TO_EXECUTE' }),
      false,
    );
  });
});
