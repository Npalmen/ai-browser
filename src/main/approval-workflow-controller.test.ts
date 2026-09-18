import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import { InMemoryApprovalAuditSink } from '../approval/approval-audit';
import { ApprovalManager } from '../approval/approval-manager';
import { ExecuteExecutor } from '../approval/execute-executor';
import type { BrowserAdapter } from '../browser/browser-adapter';
import { TargetRegistry } from '../observation/target-registry';
import { PREPARED_ACTION_TTL_MS, type ApprovalEvent, type ExecuteGrant, type ExecuteResult } from '../shared/approval-types';
import type { PageObservation } from '../shared/observation-types';
import { ApprovalController } from './approval-controller';
import { ApprovalLifecycle } from './approval-lifecycle';
import { ApprovalWorkflowController } from './approval-workflow-controller';

const ROOT = path.resolve(__dirname, '..', '..');
const FORBIDDEN = [
  'preparedActionId',
  'targetId',
  'observationId',
  'documentRevision',
  'executionId',
  'ExecuteGrant',
  'authority',
  'backendNodeId',
  'frameId',
  'proposal',
  'PageObservation',
  'CDP',
];

function observation(): PageObservation {
  return {
    observationId: 'obs-fresh',
    tabId: 'tab-1',
    capturedAt: 2,
    document: {
      revision: 'rev-fresh',
      url: 'https://example.test/after',
      title: 'After',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 },
    nodes: [],
    stats: {
      sourceAxNodeCount: 0,
      sourceDomNodeCount: 0,
      emittedNodeCount: 0,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
  };
}

function targetRecord() {
  return {
    targetId: 'target-1',
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    frameId: 'frame-1',
    backendNodeId: 42,
  };
}

function createFakeAdapter() {
  const counts = { click: 0, observePage: 0 };
  const adapter: BrowserAdapter = {
    createTab: async () => 'tab-1',
    closeTab: async () => undefined,
    activateTab: async () => undefined,
    navigate: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    getPageState: async () => {
      throw new Error('unused');
    },
    observePage: async () => {
      counts.observePage += 1;
      return observation();
    },
    click: async (request) => {
      counts.click += 1;
      request.onBeforeInputDispatch?.();
      return { primitive: 'click' };
    },
    type: async () => {
      throw new Error('unused');
    },
    select: async () => {
      throw new Error('unused');
    },
    scroll: async () => {
      throw new Error('unused');
    },
    scrollIntoView: async () => {
      throw new Error('unused');
    },
  };
  return { adapter, counts };
}

function createManager(clock: { now: number }) {
  return new ApprovalManager({
    now: () => clock.now,
    generatePreparedActionId: () => 'prep-1',
    generateApprovalId: () => 'appr-1',
    generateExecutionId: () => 'exec-1',
  });
}

function prepare(manager: ApprovalManager, tabId = 'tab-1') {
  return manager.prepare({
    tabId,
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    targetId: 'target-1',
    category: 'submit',
    summary: { title: 'Submit form', description: 'Send now', origin: 'https://shop.test' },
  });
}

function createDecisionController(
  manager: ApprovalManager,
  audit: InMemoryApprovalAuditSink,
  events: ApprovalEvent[],
  emit: (event: ApprovalEvent) => void = (event) => {
    events.push(event);
  },
) {
  return new ApprovalController({
    manager,
    auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
    emit,
  });
}

describe('ApprovalWorkflowController', () => {
  it('approves, claims once, executes once, and emits renderer-safe events', async () => {
    const clock = { now: 1_000 };
    const manager = createManager(clock);
    const audit = new InMemoryApprovalAuditSink();
    const events: ApprovalEvent[] = [];
    const fake = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const action = prepare(manager);
    const workflow = new ApprovalWorkflowController({
      decisionController: createDecisionController(manager, audit, events),
      manager,
      executeExecutor: new ExecuteExecutor({
        adapter: fake.adapter,
        targetRegistry: registry,
        manager,
        auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      }),
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
    });

    const result = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.decision, 'approve');
    }
    assert.equal(fake.counts.click, 1);
    assert.equal(fake.counts.observePage, 1);
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'executed');
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval-resolved', 'execution-started', 'execution-completed'],
    );
    const serialized = JSON.stringify(events);
    for (const token of FORBIDDEN) {
      assert.equal(serialized.includes(token), false, token);
    }
  });

  it('rejects without claiming or executing', async () => {
    const manager = createManager({ now: 1_000 });
    const audit = new InMemoryApprovalAuditSink();
    const events: ApprovalEvent[] = [];
    let executeCount = 0;
    const action = prepare(manager);
    const originalClaim = manager.claimExecuteGrant.bind(manager);
    let claimCount = 0;
    manager.claimExecuteGrant = (approvalId: string) => {
      claimCount += 1;
      return originalClaim(approvalId);
    };
    const workflow = new ApprovalWorkflowController({
      decisionController: createDecisionController(manager, audit, events),
      manager,
      executeExecutor: {
        async execute() {
          executeCount += 1;
          return { executionId: 'exec-1', status: 'executed' };
        },
      },
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
    });

    const result = await workflow.decide({ approvalId: action.approvalId, decision: 'reject' });
    assert.equal(result.ok, true);
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'rejected');
    assert.equal(claimCount, 0);
    assert.equal(executeCount, 0);
    assert.equal(events[0]?.type, 'approval-resolved');
  });

  it('does not execute a duplicate approve', async () => {
    const manager = createManager({ now: 1_000 });
    const audit = new InMemoryApprovalAuditSink();
    const events: ApprovalEvent[] = [];
    const fake = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const action = prepare(manager);
    const workflow = new ApprovalWorkflowController({
      decisionController: createDecisionController(manager, audit, events),
      manager,
      executeExecutor: new ExecuteExecutor({
        adapter: fake.adapter,
        targetRegistry: registry,
        manager,
        auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      }),
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
    });

    const first = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    const second = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(fake.counts.click, 1);
  });

  it('lets exactly one competing approve/reject win', async () => {
    const manager = createManager({ now: 1_000 });
    const audit = new InMemoryApprovalAuditSink();
    const events: ApprovalEvent[] = [];
    let executeCount = 0;
    const action = prepare(manager);
    const workflow = new ApprovalWorkflowController({
      decisionController: createDecisionController(manager, audit, events),
      manager,
      executeExecutor: {
        async execute() {
          executeCount += 1;
          return { executionId: 'exec-1', status: 'executed' };
        },
      },
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
    });

    const results = await Promise.all([
      workflow.decide({ approvalId: action.approvalId, decision: 'approve' }),
      workflow.decide({ approvalId: action.approvalId, decision: 'reject' }),
    ]);
    const successes = results.filter((result) => result.ok);
    assert.equal(successes.length, 1);
    if (successes[0]?.ok && successes[0].decision === 'reject') {
      assert.equal(executeCount, 0);
      assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'rejected');
    } else {
      assert.equal(executeCount, 1);
    }
  });

  it('expires at claim without executing', async () => {
    const clock = { now: 1_000 };
    const manager = createManager(clock);
    const audit = new InMemoryApprovalAuditSink();
    const events: ApprovalEvent[] = [];
    let executeCount = 0;
    const action = prepare(manager);
    const workflow = new ApprovalWorkflowController({
      decisionController: createDecisionController(manager, audit, events),
      manager,
      executeExecutor: {
        async execute() {
          executeCount += 1;
          return { executionId: 'exec-1', status: 'executed' };
        },
      },
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
      beforeClaim: () => {
        clock.now = 1_000 + PREPARED_ACTION_TTL_MS;
      },
    });

    const result = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(result.ok, true);
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'expired');
    assert.equal(executeCount, 0);
    assert.equal(events.some((event) => event.type === 'approval-expired'), true);
    assert.equal(events.some((event) => event.type === 'execution-started'), false);
  });

  it('stales before claim without executing', async () => {
    const clock = { now: 1_000 };
    const manager = createManager(clock);
    const audit = new InMemoryApprovalAuditSink();
    const events: ApprovalEvent[] = [];
    let executeCount = 0;
    const action = prepare(manager);
    const lifecycle = new ApprovalLifecycle({
      manager,
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
    });
    const workflow = new ApprovalWorkflowController({
      decisionController: createDecisionController(manager, audit, events),
      manager,
      executeExecutor: {
        async execute() {
          executeCount += 1;
          return { executionId: 'exec-1', status: 'executed' };
        },
      },
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
      beforeClaim: () => {
        lifecycle.invalidateTab('tab-1');
      },
    });

    const result = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(result.ok, true);
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'stale');
    assert.equal(executeCount, 0);
    assert.equal(events.some((event) => event.type === 'approval-stale'), true);
    assert.equal(audit.getEvents().filter((event) => event.eventType === 'stale').length, 1);
  });

  it('maps execute results to renderer-safe events', async () => {
    const cases: Array<{ status: ExecuteResult['status']; event: ApprovalEvent['type']; errorCode?: string }> = [
      { status: 'executed', event: 'execution-completed' },
      { status: 'stale', event: 'execution-failed', errorCode: 'APPROVAL_STALE' },
      { status: 'failed', event: 'execution-failed', errorCode: 'EXECUTION_FAILED' },
      {
        status: 'execution-attempted-state-unknown',
        event: 'execution-failed',
        errorCode: 'EXECUTION_STATE_UNKNOWN',
      },
    ];

    for (const testCase of cases) {
      const manager = new ApprovalManager({
        now: () => 1_000,
        generatePreparedActionId: () => 'prep-1',
        generateApprovalId: () => 'appr-1',
        generateExecutionId: () => 'exec-1',
      });
      const audit = new InMemoryApprovalAuditSink();
      const events: ApprovalEvent[] = [];
      const action = prepare(manager);
      const workflow = new ApprovalWorkflowController({
        decisionController: createDecisionController(manager, audit, events),
        manager,
        executeExecutor: {
          async execute(grant: ExecuteGrant): Promise<ExecuteResult> {
            if (testCase.status === 'executed') {
              return { executionId: grant.executionId, status: 'executed' };
            }
            return {
              executionId: grant.executionId,
              status: testCase.status,
              errorCode: 'INTERNAL_RAW_SHOULD_NOT_LEAK',
            };
          },
        },
        auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
        emit: (event) => {
          events.push(event);
        },
      });

      const result = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
      assert.equal(result.ok, true);
      const last = events.at(-1);
      assert.equal(last?.type, testCase.event);
      const serialized = JSON.stringify(events);
      assert.equal(serialized.includes('INTERNAL_RAW_SHOULD_NOT_LEAK'), false);
      for (const token of FORBIDDEN) {
        assert.equal(serialized.includes(token), false, token);
      }
      if (last?.type === 'execution-failed') {
        assert.equal(last.error.code, testCase.errorCode);
        assert.equal(last.status, testCase.status);
      }
    }
  });

  it('does not retry after execution-attempted-state-unknown', async () => {
    const manager = createManager({ now: 1_000 });
    const audit = new InMemoryApprovalAuditSink();
    const events: ApprovalEvent[] = [];
    let executeCount = 0;
    const action = prepare(manager);
    const workflow = new ApprovalWorkflowController({
      decisionController: createDecisionController(manager, audit, events),
      manager,
      executeExecutor: {
        async execute(grant) {
          executeCount += 1;
          return {
            executionId: grant.executionId,
            status: 'execution-attempted-state-unknown',
          };
        },
      },
      auditRecorder: new ApprovalAuditRecorder({ manager, audit }),
      emit: (event) => {
        events.push(event);
      },
    });

    const first = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    const second = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(executeCount, 1);
  });

  it('still claims and executes once when audit and emit throw after approve', async () => {
    const manager = createManager({ now: 1_000 });
    const action = prepare(manager);
    const fake = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const throwingRecorder = new ApprovalAuditRecorder({
      manager,
      audit: {
        append() {
          throw new Error('audit sink unavailable');
        },
        getEvents() {
          return [];
        },
        clear() {},
      },
    });
    const workflow = new ApprovalWorkflowController({
      decisionController: new ApprovalController({
        manager,
        auditRecorder: throwingRecorder,
        emit: () => {
          throw new Error('renderer emit failed');
        },
      }),
      manager,
      executeExecutor: new ExecuteExecutor({
        adapter: fake.adapter,
        targetRegistry: registry,
        manager,
        auditRecorder: throwingRecorder,
      }),
      auditRecorder: throwingRecorder,
      emit: () => {
        throw new Error('renderer emit failed');
      },
    });

    const result = await workflow.decide({ approvalId: action.approvalId, decision: 'approve' });
    assert.equal(result.ok, true);
    assert.equal(fake.counts.click, 1);
    assert.equal(manager.getByApprovalId(action.approvalId)?.state, 'executed');
  });

  it('keeps decision-only composition out of renderer and IPC', () => {
    const source = readFileSync(path.join(ROOT, 'src/main/approval-controller.ts'), 'utf8');
    assert.equal(source.includes('claimExecuteGrant('), false);
    assert.equal(source.includes('ExecuteExecutor'), false);
    const preload = readFileSync(path.join(ROOT, 'src/preload/app-preload.ts'), 'utf8');
    assert.equal(preload.includes('claimExecuteGrant'), false);
    assert.equal(preload.includes('executeApproval'), false);
    const ui = readFileSync(path.join(ROOT, 'src/app-ui/ApprovalCard.tsx'), 'utf8');
    assert.equal(ui.includes('claimExecuteGrant'), false);
    assert.equal(ui.includes('targetId'), false);
    assert.equal(ui.includes('dangerouslySetInnerHTML'), false);
  });
});
