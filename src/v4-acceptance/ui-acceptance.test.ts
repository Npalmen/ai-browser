import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { ApprovalEvent, PendingApprovalView } from '../shared/approval-types';
import {
  applyApprovalEvent,
  isApprovalBusy,
  markApprovalDeciding,
  type ApprovalUiState,
} from '../app-ui/approval-ui-state';

const ROOT = path.resolve(__dirname, '..', '..');
const TAB = 'v4-tab-a';
const APPROVAL_A = 'appr-a';
const APPROVAL_B = 'appr-b';

function view(overrides: Partial<PendingApprovalView> = {}): PendingApprovalView {
  return {
    approvalId: APPROVAL_A,
    tabId: TAB,
    category: 'purchase',
    title: 'Confirm purchase',
    description: 'Buy now',
    origin: 'http://127.0.0.1',
    expiresAt: 2_000,
    ...overrides,
  };
}

describe('V4 approval UI acceptance', () => {
  it('maps renderer events through pending, deciding, approved, executing, and completed', () => {
    let state: ApprovalUiState = {};
    state = applyApprovalEvent(state, { type: 'approval-required', approval: view() });
    assert.equal(state[TAB]?.status, 'pending');
    state = markApprovalDeciding(state, TAB, APPROVAL_A);
    assert.equal(state[TAB]?.status, 'deciding');
    assert.equal(isApprovalBusy(state[TAB]?.status ?? 'idle'), true);
    state = applyApprovalEvent(state, {
      type: 'approval-resolved',
      approvalId: APPROVAL_A,
      tabId: TAB,
      decision: 'approve',
      state: 'approved',
    });
    assert.equal(state[TAB]?.status, 'approved');
    state = applyApprovalEvent(state, {
      type: 'execution-started',
      approvalId: APPROVAL_A,
      tabId: TAB,
    });
    assert.equal(state[TAB]?.status, 'executing');
    state = applyApprovalEvent(state, {
      type: 'execution-completed',
      approvalId: APPROVAL_A,
      tabId: TAB,
    });
    assert.equal(state[TAB]?.status, 'completed');
  });

  it('maps reject, expiry, stale, failed, and unknown terminal states', () => {
    const sequences: Array<{ event: ApprovalEvent; status: string }> = [
      {
        event: {
          type: 'approval-resolved',
          approvalId: APPROVAL_A,
          tabId: TAB,
          decision: 'reject',
          state: 'rejected',
        },
        status: 'rejected',
      },
      {
        event: { type: 'approval-expired', approvalId: APPROVAL_A, tabId: TAB },
        status: 'expired',
      },
      {
        event: { type: 'approval-stale', approvalId: APPROVAL_A, tabId: TAB },
        status: 'stale',
      },
      {
        event: {
          type: 'execution-failed',
          approvalId: APPROVAL_A,
          tabId: TAB,
          status: 'failed',
          error: { code: 'EXECUTION_FAILED', message: 'The approved action could not be performed.' },
        },
        status: 'failed',
      },
      {
        event: {
          type: 'execution-failed',
          approvalId: APPROVAL_A,
          tabId: TAB,
          status: 'execution-attempted-state-unknown',
          error: {
            code: 'EXECUTION_STATE_UNKNOWN',
            message:
              'The action may have been performed, but the final page state could not be confirmed. Do not retry automatically.',
          },
        },
        status: 'unknown',
      },
    ];

    for (const sequence of sequences) {
      let state = applyApprovalEvent({}, { type: 'approval-required', approval: view() });
      state = applyApprovalEvent(state, sequence.event);
      assert.equal(state[TAB]?.status, sequence.status);
    }
  });

  it('ignores late events for an older approvalId on the same tab', () => {
    let state = applyApprovalEvent({}, { type: 'approval-required', approval: view() });
    state = applyApprovalEvent(state, {
      type: 'approval-required',
      approval: view({ approvalId: APPROVAL_B }),
    });
    state = applyApprovalEvent(state, {
      type: 'approval-stale',
      approvalId: APPROVAL_A,
      tabId: TAB,
    });
    assert.equal(state[TAB]?.approval?.approvalId, APPROVAL_B);
    assert.equal(state[TAB]?.status, 'pending');
  });

  it('shows unknown copy that forbids automatic retry and hides approval buttons', () => {
    const card = readFileSync(path.join(ROOT, 'src/app-ui/ApprovalCard.tsx'), 'utf8');
    assert.match(
      card,
      /The action may have been performed, but the final page state could not be confirmed\. Do not retry automatically\./,
    );
    assert.equal(card.includes('Retry'), false);
    assert.equal(card.includes('Approve again'), false);
    assert.match(
      card,
      /props\.status === 'pending' \|\| props\.status === 'deciding'/,
    );
    assert.match(card, /disabled=\{props\.busy\}/);
    assert.equal(card.includes('dangerouslySetInnerHTML'), false);
    assert.equal(card.includes('innerHTML'), false);
    assert.match(card, /\{props\.approval\.title\}/);
    assert.match(card, />\s*Approve\s*</);
    assert.match(card, />\s*Reject\s*</);
  });

  it('keeps Enter in the AI textarea bound to Ask/Act, never Approve', () => {
    const panel = readFileSync(path.join(ROOT, 'src/app-ui/AiSidePanel.tsx'), 'utf8');
    const app = readFileSync(path.join(ROOT, 'src/app-ui/App.tsx'), 'utf8');
    const card = readFileSync(path.join(ROOT, 'src/app-ui/ApprovalCard.tsx'), 'utf8');
    assert.match(panel, /event\.key === 'Enter'/);
    assert.match(panel, /props\.onAsk\(\)/);
    assert.equal(panel.includes('decideApproval'), false);
    assert.equal(panel.includes('onApprove'), true);
    assert.equal(card.includes('onKeyDown'), false);
    assert.equal(card.includes("key === 'Enter'"), false);
    assert.match(app, /decideApproval\(\{ approvalId, decision \}\)/);
    assert.match(app, /handleApprovalDecision\('approve'\)/);
    assert.equal(card.includes('setTimeout'), false);
    assert.equal(panel.includes('setTimeout'), false);
    assert.equal(card.includes('decideApproval'), false);
    assert.equal(app.includes('handleApprovalDecision(\'approve\')'), true);
  });
});
