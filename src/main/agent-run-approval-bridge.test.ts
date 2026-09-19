import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import { toAgentRunRef } from '../agent-run/agent-run-types';
import { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import { InMemoryApprovalAuditSink } from '../approval/approval-audit';
import { ApprovalManager } from '../approval/approval-manager';
import { PrepareActionService } from '../approval/prepare-action-service';
import { PREPARED_ACTION_TTL_MS, type ApprovalEvent } from '../shared/approval-types';
import type { BoundInteractionProposal } from '../shared/interaction-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import { AgentRunApprovalBridge } from './agent-run-approval-bridge';
import { ApprovalLifecycle } from './approval-lifecycle';

function node(
  overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>,
): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: true,
    visible: true,
    inViewport: true,
    ...overrides,
  };
}

function observation(
  nodes: ObservationNode[],
  overrides: Partial<PageObservation> = {},
): PageObservation {
  return {
    observationId: 'obs-1',
    tabId: 'tab-1',
    capturedAt: 1,
    document: {
      revision: 'rev-1',
      url: 'https://shop.test/checkout',
      title: 'Checkout',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 },
    nodes,
    stats: {
      sourceAxNodeCount: nodes.length,
      sourceDomNodeCount: nodes.length,
      emittedNodeCount: nodes.length,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
    ...overrides,
  };
}

function buyNowPage(): PageObservation {
  return observation([
    node({
      role: 'button',
      tag: 'button',
      targetId: 'target-1',
      name: 'Buy now',
      attributes: { type: 'button' },
    }),
  ]);
}

function boundClick(): BoundInteractionProposal {
  return {
    kind: 'click',
    targetId: 'target-1',
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
  };
}

function createBridgeHarness() {
  const clock = { now: 1_000 };
  const ids = { prepared: 0, approval: 0 };
  const manager = new ApprovalManager({
    now: () => clock.now,
    generatePreparedActionId: () => `prep-${++ids.prepared}`,
    generateApprovalId: () => `appr-${++ids.approval}`,
    generateExecutionId: () => 'exec-1',
  });
  const audit = new InMemoryApprovalAuditSink();
  const events: ApprovalEvent[] = [];
  const coordinator = new AgentRunCoordinator();
  const prepareActionService = new PrepareActionService({ manager, audit });
  const auditRecorder = new ApprovalAuditRecorder({ manager, audit, now: () => clock.now });
  const lifecycle = new ApprovalLifecycle({
    manager,
    auditRecorder,
    emit: (event) => {
      events.push(event);
    },
    now: () => clock.now,
  });
  const prepareCalls = { count: 0 };
  const countingPrepare: Pick<PrepareActionService, 'prepare'> = {
    prepare(input) {
      prepareCalls.count += 1;
      return prepareActionService.prepare(input);
    },
  };
  const bridge = new AgentRunApprovalBridge({
    coordinator,
    prepareActionService: countingPrepare,
    lifecycle,
    manager,
    auditRecorder,
    emit: (event) => {
      events.push(event);
    },
  });
  return {
    clock,
    manager,
    audit,
    events,
    coordinator,
    lifecycle,
    bridge,
    prepareCalls,
  };
}

describe('AgentRunApprovalBridge', () => {
  it('prepares the exact proposal through PrepareActionService and presents it', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const page = buyNowPage();
    const proposal = boundClick();
    const result = harness.bridge.prepareAndPresent({
      ref: toAgentRunRef(run),
      proposal,
      observation: page,
    });

    assert.equal(result.status, 'awaiting-approval');
    if (result.status === 'awaiting-approval') {
      assert.equal(result.approvalId, 'appr-1');
    }
    assert.equal(harness.prepareCalls.count, 1);
    assert.equal(harness.manager.getByApprovalId('appr-1')?.state, 'pending');
    assert.equal(harness.events[0]?.type, 'approval-required');
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'awaiting-approval');
    assert.equal(harness.coordinator.getRun(run.runId)?.approvalCount, 1);
    assert.equal(harness.audit.getEvents()[0]?.eventType, 'prepared');
  });

  it('does not prepare when approval budget is exhausted', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const ref = toAgentRunRef(run);
    harness.coordinator.presentApproval(ref, 'prior-1');
    harness.coordinator.notifyApprovalOutcome('prior-1', 'executed');
    harness.coordinator.presentApproval(ref, 'prior-2');
    harness.coordinator.notifyApprovalOutcome('prior-2', 'executed');

    const result = harness.bridge.prepareAndPresent({
      ref,
      proposal: boundClick(),
      observation: buyNowPage(),
    });
    assert.equal(result.status, 'failed');
    assert.equal(harness.prepareCalls.count, 0);
    assert.equal(harness.manager.getPendingForTab('tab-1'), undefined);
    assert.equal(
      harness.events.some((event) => event.type === 'approval-required'),
      false,
    );
  });

  it('stales only the exact prepared approval if the run is superseded after prepare', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const other = harness.manager.prepare({
      tabId: 'tab-2',
      observationId: 'obs-other',
      documentRevision: 'rev-other',
      targetId: 'target-other',
      category: 'submit',
      summary: { title: 'Other' },
    });
    const countingLifecycle = {
      present: (action: Parameters<ApprovalLifecycle['present']>[0]) => {
        harness.coordinator.startRun('tab-1', 'newer');
        return harness.lifecycle.present(action);
      },
    };
    const bridge = new AgentRunApprovalBridge({
      coordinator: harness.coordinator,
      prepareActionService: new PrepareActionService({
        manager: harness.manager,
        audit: harness.audit,
      }),
      lifecycle: countingLifecycle,
      manager: harness.manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager: harness.manager,
        audit: harness.audit,
        now: () => harness.clock.now,
      }),
      emit: (event) => {
        harness.events.push(event);
      },
    });

    const result = bridge.prepareAndPresent({
      ref: toAgentRunRef(run),
      proposal: boundClick(),
      observation: buyNowPage(),
    });
    assert.equal(result.status, 'ignored');
    assert.equal(harness.manager.getByApprovalId('appr-2')?.state, 'stale');
    assert.equal(harness.manager.getByApprovalId(other.approvalId)?.state, 'pending');
    assert.equal(
      harness.events.some(
        (event) => event.type === 'approval-stale' && event.approvalId === 'appr-2',
      ),
      true,
    );
    assert.equal(harness.coordinator.getRun(run.runId)?.terminalReason, 'SUPERSEDED');
  });

  it('stales the exact approval if prepare succeeds and the run is gone before present', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const prepareActionService = new PrepareActionService({
      manager: harness.manager,
      audit: harness.audit,
    });
    const bridge = new AgentRunApprovalBridge({
      coordinator: harness.coordinator,
      prepareActionService: {
        prepare(input) {
          const action = prepareActionService.prepare(input);
          harness.coordinator.startRun('tab-1', 'newer');
          return action;
        },
      },
      lifecycle: harness.lifecycle,
      manager: harness.manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager: harness.manager,
        audit: harness.audit,
        now: () => harness.clock.now,
      }),
      emit: (event) => {
        harness.events.push(event);
      },
    });

    const result = bridge.prepareAndPresent({
      ref: toAgentRunRef(run),
      proposal: boundClick(),
      observation: buyNowPage(),
    });
    assert.equal(result.status, 'ignored');
    assert.equal(harness.manager.getByApprovalId('appr-1')?.state, 'stale');
    assert.equal(
      harness.events.some((event) => event.type === 'approval-required'),
      false,
    );
  });

  it('returns expired when presentation hits TTL', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const prepareActionService = new PrepareActionService({
      manager: harness.manager,
      audit: harness.audit,
    });
    const bridge = new AgentRunApprovalBridge({
      coordinator: harness.coordinator,
      prepareActionService: {
        prepare(input) {
          const action = prepareActionService.prepare(input);
          harness.clock.now = 1_000 + PREPARED_ACTION_TTL_MS;
          return action;
        },
      },
      lifecycle: harness.lifecycle,
      manager: harness.manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager: harness.manager,
        audit: harness.audit,
        now: () => harness.clock.now,
      }),
      emit: (event) => {
        harness.events.push(event);
      },
    });

    const result = bridge.prepareAndPresent({
      ref: toAgentRunRef(run),
      proposal: boundClick(),
      observation: buyNowPage(),
    });
    assert.equal(result.status, 'expired');
    assert.equal(harness.manager.getByApprovalId('appr-1')?.state, 'expired');
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'running');
  });

  it('does not call tab-wide invalidation and does not put runId on V4 authority', () => {
    const source = readFileSync(path.join(__dirname, 'agent-run-approval-bridge.ts'), 'utf8');
    assert.equal(source.includes('invalidateTab('), false);
    const types = readFileSync(
      path.join(__dirname, '..', 'shared', 'approval-types.ts'),
      'utf8',
    );
    assert.equal(types.includes('runId'), false);
    assert.equal(types.includes('AgentRunRef'), false);
    assert.equal(types.includes('generation'), false);
  });

  it('skips prepare when the optional task hook reports blocked', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const calls: string[] = [];
    const bridge = new AgentRunApprovalBridge({
      coordinator: harness.coordinator,
      prepareActionService: {
        prepare(input) {
          harness.prepareCalls.count += 1;
          return new PrepareActionService({
            manager: harness.manager,
            audit: harness.audit,
          }).prepare(input);
        },
      },
      lifecycle: harness.lifecycle,
      manager: harness.manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager: harness.manager,
        audit: harness.audit,
        now: () => harness.clock.now,
      }),
      emit: (event) => {
        harness.events.push(event);
      },
      taskApproval: {
        beforePrepare() {
          calls.push('before');
          return 'blocked';
        },
        onPresented() {
          calls.push('presented');
          return 'applied';
        },
      },
    });
    const result = bridge.prepareAndPresent({
      ref: toAgentRunRef(run),
      proposal: boundClick(),
      observation: buyNowPage(),
    });
    assert.equal(result.status, 'failed');
    assert.deepEqual(calls, ['before']);
    assert.equal(harness.prepareCalls.count, 0);
    assert.equal(harness.manager.getPendingForTab('tab-1'), undefined);
    assert.equal(
      harness.events.some((event) => event.type === 'approval-required'),
      false,
    );
  });

  it('leaves V5 behavior unchanged when the task hook is unrelated', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const bridge = new AgentRunApprovalBridge({
      coordinator: harness.coordinator,
      prepareActionService: new PrepareActionService({
        manager: harness.manager,
        audit: harness.audit,
      }),
      lifecycle: harness.lifecycle,
      manager: harness.manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager: harness.manager,
        audit: harness.audit,
        now: () => harness.clock.now,
      }),
      emit: (event) => {
        harness.events.push(event);
      },
      taskApproval: {
        beforePrepare() {
          return 'unrelated';
        },
        onPresented() {
          return 'unrelated';
        },
      },
    });
    const result = bridge.prepareAndPresent({
      ref: toAgentRunRef(run),
      proposal: boundClick(),
      observation: buyNowPage(),
    });
    assert.equal(result.status, 'awaiting-approval');
    assert.equal(harness.events[0]?.type, 'approval-required');
  });

  it('stales the exact approval if V4 presents but task correlation cannot commit', () => {
    const harness = createBridgeHarness();
    const run = harness.coordinator.startRun('tab-1', 'buy it');
    const bridge = new AgentRunApprovalBridge({
      coordinator: harness.coordinator,
      prepareActionService: new PrepareActionService({
        manager: harness.manager,
        audit: harness.audit,
      }),
      lifecycle: harness.lifecycle,
      manager: harness.manager,
      auditRecorder: new ApprovalAuditRecorder({
        manager: harness.manager,
        audit: harness.audit,
        now: () => harness.clock.now,
      }),
      emit: (event) => {
        harness.events.push(event);
      },
      taskApproval: {
        beforePrepare() {
          return 'allow';
        },
        onPresented() {
          return 'ignored';
        },
      },
    });
    const result = bridge.prepareAndPresent({
      ref: toAgentRunRef(run),
      proposal: boundClick(),
      observation: buyNowPage(),
    });
    assert.equal(result.status, 'failed');
    assert.equal(harness.manager.getByApprovalId('appr-1')?.state, 'stale');
    assert.equal(harness.coordinator.getRun(run.runId)?.state, 'awaiting-approval');
    assert.equal(
      harness.events.some((event) => event.type === 'approval-stale' && event.approvalId === 'appr-1'),
      true,
    );
  });
});
