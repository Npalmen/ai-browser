import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import type { TrustedAgentApprovalOutcome } from '../agent-run/approval-outcome';
import { CompositeAgentRunApprovalOutcomePort } from './agent-run-approval-outcome-composite';

describe('CompositeAgentRunApprovalOutcomePort', () => {
  it('handles task outcome before AgentRun outcome on the same stack', () => {
    const order: string[] = [];
    let taskSawRun = false;
    const composite = new CompositeAgentRunApprovalOutcomePort({
      task: {
        notifyApprovalOutcome() {
          order.push('task');
          taskSawRun = order.includes('agentRun');
        },
      },
      agentRun: {
        beginApprovedExecution() {
          return 'proceed';
        },
        notifyApprovalOutcome() {
          order.push('agentRun');
        },
      },
    });
    composite.notifyApprovalOutcome('appr-1', 'executed');
    assert.deepEqual(order, ['task', 'agentRun']);
    assert.equal(taskSawRun, false);
  });

  it('delegates beginApprovedExecution only to the AgentRun port', () => {
    const calls: string[] = [];
    const composite = new CompositeAgentRunApprovalOutcomePort({
      task: {
        notifyApprovalOutcome() {
          calls.push('task-notify');
        },
      },
      agentRun: {
        beginApprovedExecution() {
          calls.push('begin');
          return 'proceed';
        },
        notifyApprovalOutcome() {
          calls.push('agent-notify');
        },
      },
    });
    assert.equal(composite.beginApprovedExecution('appr-1'), 'proceed');
    assert.deepEqual(calls, ['begin']);
  });

  it('still notifies AgentRun when the task sidecar throws', () => {
    const outcomes: TrustedAgentApprovalOutcome[] = [];
    const composite = new CompositeAgentRunApprovalOutcomePort({
      task: {
        notifyApprovalOutcome() {
          throw new Error('task sidecar failed');
        },
      },
      agentRun: {
        beginApprovedExecution() {
          return 'unrelated';
        },
        notifyApprovalOutcome(_approvalId, outcome) {
          outcomes.push(outcome);
        },
      },
    });
    composite.notifyApprovalOutcome('appr-1', 'rejected');
    assert.deepEqual(outcomes, ['rejected']);
  });

  it('does not require AgentRunCoordinator to know about AutonomousTask', () => {
    const coordinator = new AgentRunCoordinator();
    const run = coordinator.startRun('tab-1', 'act');
    coordinator.presentApproval({ runId: run.runId, tabId: run.tabId, generation: run.generation }, 'appr-1');
    const composite = new CompositeAgentRunApprovalOutcomePort({
      task: {
        notifyApprovalOutcome() {},
      },
      agentRun: coordinator,
    });
    composite.notifyApprovalOutcome('appr-1', 'rejected');
    assert.equal(coordinator.getRun(run.runId)?.state, 'blocked');
    assert.equal(coordinator.getRun(run.runId)?.terminalReason, 'APPROVAL_REJECTED');
  });
});
