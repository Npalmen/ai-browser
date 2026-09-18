import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { BrowserAdapter } from '../browser/browser-adapter';
import type { AdapterClickRequest } from '../browser/interaction-adapter-types';
import { TabNotFoundError } from '../browser/tab-registry';
import { TargetRegistry } from '../observation/target-registry';
import { ApprovalError } from '../shared/approval-errors';
import type { ExecuteGrant } from '../shared/approval-types';
import { InteractionError } from '../shared/interaction-errors';
import type { PageObservation } from '../shared/observation-types';
import { ApprovalAuditRecorder } from './approval-audit-recorder';
import {
  InMemoryApprovalAuditSink,
  type ApprovalAuditEvent,
  type ApprovalAuditSink,
} from './approval-audit';
import { ApprovalManager } from './approval-manager';
import { ExecuteExecutor } from './execute-executor';

const ROOT = path.resolve(__dirname, '..', '..');
const FORBIDDEN_AUDIT = [
  'backendNodeId',
  'frameId',
  'coordinate',
  'DOM.getBoxModel',
  'Input.dispatchMouseEvent',
  'PageObservation',
  'password',
  'OTP',
  'card data',
  'model output',
  'model reasoning',
  'Submit order now',
  'V4_SECRET_PAGE_TEXT',
];

interface ClickControl {
  beforeHook?: (request: AdapterClickRequest) => Promise<void> | void;
  afterHookError?: unknown;
  beforeHookError?: unknown;
  hold?: {
    started: () => void;
    wait: Promise<void>;
  };
}

function observation(tabId = 'tab-1', observationId = 'obs-fresh'): PageObservation {
  return {
    observationId,
    tabId,
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

function targetRecord(overrides: Partial<{
  targetId: string;
  tabId: string;
  observationId: string;
  documentRevision: string;
  frameId: string;
  backendNodeId: number;
}> = {}) {
  return {
    targetId: 'target-1',
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    frameId: 'frame-1',
    backendNodeId: 42,
    ...overrides,
  };
}

function createFakeAdapter(options: {
  click?: ClickControl;
  observePage?: () => Promise<PageObservation>;
  observeError?: unknown;
} = {}): {
  adapter: BrowserAdapter;
  counts: { click: number; hook: number; input: number; observePage: number };
  lastClick?: AdapterClickRequest;
} {
  const counts = { click: 0, hook: 0, input: 0, observePage: 0 };
  const state: { lastClick?: AdapterClickRequest } = {};

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
      if (options.observeError !== undefined) {
        throw options.observeError;
      }
      if (options.observePage) {
        return options.observePage();
      }
      return observation();
    },
    click: async (request) => {
      counts.click += 1;
      state.lastClick = request;
      if (options.click?.hold) {
        options.click.hold.started();
        await options.click.hold.wait;
      }
      if (options.click?.beforeHook) {
        await options.click.beforeHook(request);
      }
      if (options.click?.beforeHookError !== undefined) {
        throw options.click.beforeHookError;
      }
      if (request.onBeforeInputDispatch) {
        counts.hook += 1;
        request.onBeforeInputDispatch();
      }
      if (options.click?.afterHookError !== undefined) {
        throw options.click.afterHookError;
      }
      counts.input += 1;
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

  return {
    adapter,
    counts,
    get lastClick() {
      return state.lastClick;
    },
  };
}

class ThrowingAuditSink implements ApprovalAuditSink {
  append(): void {
    throw new Error('audit sink unavailable');
  }

  getEvents(): ReadonlyArray<ApprovalAuditEvent> {
    return Object.freeze([]);
  }

  clear(): void {}
}

class DeferredHold {
  readonly promise: Promise<void>;
  resolve!: () => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

function createHarness(
  adapter: BrowserAdapter,
  registry = new TargetRegistry(),
  audit: ApprovalAuditSink = new InMemoryApprovalAuditSink(),
) {
  const clock = { now: 1_000 };
  const manager = new ApprovalManager({
    now: () => clock.now,
    generatePreparedActionId: () => 'prep-1',
    generateApprovalId: () => 'appr-1',
    generateExecutionId: () => 'exec-1',
  });
  const auditRecorder = new ApprovalAuditRecorder({
    manager,
    audit,
    now: () => clock.now,
  });
  const executor = new ExecuteExecutor({
    adapter,
    targetRegistry: registry,
    manager,
    auditRecorder,
  });

  const action = manager.prepare({
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
    targetId: 'target-1',
    category: 'submit',
    summary: { title: 'Submit order now', description: 'V4_SECRET_PAGE_TEXT' },
  });
  manager.decide(action.approvalId, 'approve');
  const grant = manager.claimExecuteGrant(action.approvalId);

  return { clock, manager, audit, auditRecorder, executor, registry, grant, action };
}

function snapshotFacts(manager: ApprovalManager, approvalId: string) {
  const snapshot = manager.getSnapshot(approvalId);
  assert.ok(snapshot);
  return {
    state: snapshot.action.state,
    ...snapshot.facts,
    executionId: snapshot.executionGrant?.executionId,
  };
}

function eventTypes(events: ReadonlyArray<ApprovalAuditEvent>): string[] {
  return events.map((event) => event.eventType);
}

function assertCorrelation(events: ReadonlyArray<ApprovalAuditEvent>, grant: ExecuteGrant): void {
  for (const event of events) {
    if (
      event.eventType === 'execute-grant-issued' ||
      event.eventType === 'execution-attempted' ||
      event.eventType === 'executed' ||
      event.eventType === 'execution-failed' ||
      event.eventType === 'post-observation-failed' ||
      (event.eventType === 'stale' && event.grantClaimed)
    ) {
      assert.equal(event.preparedActionId, grant.preparedActionId);
      assert.equal(event.approvalId, grant.approvalId);
      assert.equal(event.executionId, grant.executionId);
    }
  }
}

function assertNoForbiddenAudit(events: ReadonlyArray<ApprovalAuditEvent>): void {
  const serialized = JSON.stringify(events);
  for (const token of FORBIDDEN_AUDIT) {
    assert.equal(serialized.includes(token), false, `audit leaked ${token}`);
  }
}

describe('ExecuteExecutor', () => {
  it('executes an approved click once against the exact current TargetRecord', async () => {
    const fake = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant, audit } = createHarness(fake.adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'executed');
    assert.equal(result.executionId, 'exec-1');
    assert.equal(fake.counts.click, 1);
    assert.equal(fake.counts.hook, 1);
    assert.equal(fake.counts.input, 1);
    assert.equal(fake.counts.observePage, 1);
    assert.equal(fake.lastClick?.target.backendNodeId, 42);
    assert.equal(fake.lastClick?.target.frameId, 'frame-1');
    assert.equal(fake.lastClick?.observedBounds, undefined);
    assert.deepEqual(snapshotFacts(manager, grant.approvalId), {
      state: 'executed',
      grantIssued: true,
      grantClaimed: true,
      adapterPrimitiveInvoked: true,
      postObservationSucceeded: true,
      executionId: 'exec-1',
    });
    assert.deepEqual(eventTypes(audit.getEvents()), [
      'execute-grant-issued',
      'execution-attempted',
      'executed',
    ]);
    assertCorrelation(audit.getEvents(), grant);
    assertNoForbiddenAudit(audit.getEvents());

    await assert.rejects(
      () => executor.execute(grant),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalError);
        assert.equal(error.code, 'INVALID_APPROVAL_TRANSITION');
        return true;
      },
    );
    assert.equal(fake.counts.click, 1);
    assert.equal(fake.counts.observePage, 1);
  });

  it('marks stale when the current registry observation differs', async () => {
    const { adapter, counts } = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-other', [targetRecord({ observationId: 'obs-other' })]);
    const { executor, manager, grant, audit } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(counts.click, 0);
    assert.equal(counts.observePage, 0);
    assert.deepEqual(snapshotFacts(manager, grant.approvalId), {
      state: 'stale',
      grantIssued: true,
      grantClaimed: true,
      adapterPrimitiveInvoked: false,
      postObservationSucceeded: false,
      executionId: 'exec-1',
    });
    assert.deepEqual(eventTypes(audit.getEvents()), ['execute-grant-issued', 'stale']);
    assert.equal(audit.getEvents()[1]?.grantClaimed, true);
    assert.equal(audit.getEvents()[1]?.adapterPrimitiveInvoked, false);
    assert.equal(audit.getEvents()[1]?.executionId, 'exec-1');
    assert.throws(
      () => manager.claimExecuteGrant(grant.approvalId),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalError);
        assert.equal(error.code, 'EXECUTE_GRANT_ALREADY_CLAIMED');
        return true;
      },
    );
  });

  it('marks stale when the exact target is missing', async () => {
    const { adapter, counts } = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', []);
    const { executor, manager, grant } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(counts.click, 0);
    assert.equal(counts.observePage, 0);
    assert.equal(manager.getByApprovalId(grant.approvalId)?.state, 'stale');
  });

  it('marks stale when documentRevision does not match the grant', async () => {
    const { adapter, counts } = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord({ documentRevision: 'rev-other' })]);
    const { executor, grant } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(counts.click, 0);
  });

  it('aborts before input when TargetRegistry is replaced during adapter preflight', async () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { adapter, counts } = createFakeAdapter({
      click: {
        beforeHook: () => {
          registry.replaceObservation('tab-1', 'obs-2', []);
        },
      },
    });
    const { executor, manager, grant, audit } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(counts.click, 1);
    assert.equal(counts.hook, 1);
    assert.equal(counts.input, 0);
    assert.equal(counts.observePage, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'stale');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, false);
    assert.deepEqual(eventTypes(audit.getEvents()), ['execute-grant-issued', 'stale']);
  });

  it('maps PAGE_CHANGED before the hook to stale', async () => {
    const { adapter, counts } = createFakeAdapter({
      click: { beforeHookError: new InteractionError('PAGE_CHANGED', 'page changed') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant, audit } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(result.errorCode, 'PAGE_CHANGED');
    assert.equal(counts.hook, 0);
    assert.equal(counts.input, 0);
    assert.equal(counts.observePage, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, false);
    assert.deepEqual(eventTypes(audit.getEvents()), ['execute-grant-issued', 'stale']);
  });

  it('maps TARGET_NOT_FOUND before the hook to stale', async () => {
    const { adapter, counts } = createFakeAdapter({
      click: { beforeHookError: new InteractionError('TARGET_NOT_FOUND', 'missing') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, grant } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(counts.hook, 0);
    assert.equal(counts.observePage, 0);
  });

  it('maps TabNotFoundError before the hook to stale', async () => {
    const { adapter, counts } = createFakeAdapter({
      click: { beforeHookError: new TabNotFoundError('tab-1') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, grant } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(result.errorCode, 'TAB_NOT_FOUND');
    assert.equal(counts.hook, 0);
  });

  it('maps mechanical INTERACTION_FAILED before the hook to failed', async () => {
    const { adapter, counts } = createFakeAdapter({
      click: { beforeHookError: new InteractionError('INTERACTION_FAILED', 'debugger') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant, audit } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'INTERACTION_FAILED');
    assert.equal(counts.hook, 0);
    assert.equal(counts.observePage, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'failed');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, false);
    assert.deepEqual(eventTypes(audit.getEvents()), ['execute-grant-issued', 'execution-failed']);
    assert.throws(
      () => manager.claimExecuteGrant(grant.approvalId),
      (error: unknown) => error instanceof ApprovalError,
    );
  });

  it('maps UNSUPPORTED_FRAME before the hook to failed', async () => {
    const { adapter } = createFakeAdapter({
      click: { beforeHookError: new InteractionError('UNSUPPORTED_FRAME', 'iframe') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, grant } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'UNSUPPORTED_FRAME');
  });

  it('treats post-hook adapter rejection as unknown even for PAGE_CHANGED', async () => {
    const { adapter, counts } = createFakeAdapter({
      click: { afterHookError: new InteractionError('PAGE_CHANGED', 'after dispatch') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant, audit } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'execution-attempted-state-unknown');
    assert.equal(counts.hook, 1);
    assert.equal(counts.input, 0);
    assert.equal(counts.observePage, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'execution-attempted-state-unknown');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, true);
    assert.equal(snapshotFacts(manager, grant.approvalId).postObservationSucceeded, false);
    assert.deepEqual(eventTypes(audit.getEvents()), ['execute-grant-issued', 'execution-attempted']);
    assert.equal(eventTypes(audit.getEvents()).includes('stale'), false);
    assert.equal(eventTypes(audit.getEvents()).includes('execution-failed'), false);
    assert.equal(eventTypes(audit.getEvents()).includes('post-observation-failed'), false);
  });

  it('treats post-hook TARGET_NOT_FOUND as unknown', async () => {
    const { adapter } = createFakeAdapter({
      click: { afterHookError: new InteractionError('TARGET_NOT_FOUND', 'after dispatch') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, grant } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'execution-attempted-state-unknown');
  });

  it('marks unknown when observePage fails after a successful click', async () => {
    const { adapter, counts } = createFakeAdapter({
      observeError: new Error('observe failed'),
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant, audit } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'execution-attempted-state-unknown');
    assert.equal(counts.click, 1);
    assert.equal(counts.observePage, 1);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'execution-attempted-state-unknown');
    assert.equal(snapshotFacts(manager, grant.approvalId).postObservationSucceeded, false);
    assert.deepEqual(eventTypes(audit.getEvents()), [
      'execute-grant-issued',
      'execution-attempted',
      'post-observation-failed',
    ]);
  });

  it('marks unknown when the post-click observation has the wrong tabId', async () => {
    const { adapter, counts } = createFakeAdapter({
      observePage: async () => observation('tab-other'),
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant } = createHarness(adapter, registry);

    const result = await executor.execute(grant);
    assert.equal(result.status, 'execution-attempted-state-unknown');
    assert.equal(counts.observePage, 1);
    assert.equal(manager.getByApprovalId(grant.approvalId)?.state, 'execution-attempted-state-unknown');
  });

  it('allows only one in-flight adapter click for the same executionId', async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let notifyStarted!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const { adapter, counts } = createFakeAdapter({
      click: {
        hold: {
          started: () => notifyStarted(),
          wait,
        },
      },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, grant } = createHarness(adapter, registry);

    const pending = Promise.allSettled([executor.execute(grant), executor.execute(grant)]);
    await firstEntered;
    assert.equal(counts.click, 1);
    release();
    const settled = await pending;
    const fulfilled = settled.filter((entry) => entry.status === 'fulfilled');
    const rejected = settled.filter((entry) => entry.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((fulfilled[0] as PromiseFulfilledResult<{ status: string }>).value.status, 'executed');
    assert.ok(rejected[0].status === 'rejected' && rejected[0].reason instanceof ApprovalError);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, 'EXECUTE_IN_PROGRESS');
    assert.equal(counts.click, 1);
    assert.equal(counts.input, 1);
  });

  it('returns stale if the manager is invalidated during adapter preflight', async () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    let invalidate!: () => void;
    const { adapter, counts } = createFakeAdapter({
      click: {
        beforeHook: () => invalidate(),
      },
    });
    const { executor, manager, grant } = createHarness(adapter, registry);
    invalidate = () => {
      manager.invalidateObservation(grant.tabId, grant.observationId);
    };

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(counts.input, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'stale');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, false);
  });

  it('rejects a forged grant without adapter work or manager mutation', async () => {
    const { adapter, counts } = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant } = createHarness(adapter, registry);
    const before = snapshotFacts(manager, grant.approvalId);

    const forgedFields: Array<keyof ExecuteGrant> = [
      'targetId',
      'tabId',
      'observationId',
      'documentRevision',
      'executionId',
      'preparedActionId',
    ];
    for (const field of forgedFields) {
      const forged = Object.freeze({
        ...grant,
        [field]: field === 'issuedAt' ? grant.issuedAt : `${grant[field]}-forged`,
      }) as ExecuteGrant;
      await assert.rejects(
        () => executor.execute(forged),
        (error: unknown) => {
          assert.ok(error instanceof ApprovalError);
          assert.equal(error.code, 'INVALID_EXECUTE_GRANT');
          return true;
        },
      );
    }

    assert.equal(counts.click, 0);
    assert.equal(counts.observePage, 0);
    assert.deepEqual(snapshotFacts(manager, grant.approvalId), before);
    assert.equal(manager.getSnapshot(grant.approvalId)?.executionGrant?.executionId, grant.executionId);
  });

  it('does not emit grant-issued audit for a forged grant', async () => {
    const { adapter } = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, grant, audit } = createHarness(adapter, registry);

    await assert.rejects(() =>
      executor.execute(Object.freeze({ ...grant, targetId: 'forged-target' })),
    );
    assert.deepEqual(eventTypes(audit.getEvents()), []);
  });

  it('still executes exactly once when grant-issued audit append throws', async () => {
    const fake = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant } = createHarness(fake.adapter, registry, new ThrowingAuditSink());

    const result = await executor.execute(grant);
    assert.equal(result.status, 'executed');
    assert.equal(fake.counts.click, 1);
    assert.equal(fake.counts.hook, 1);
    assert.equal(fake.counts.observePage, 1);
    assert.deepEqual(snapshotFacts(manager, grant.approvalId), {
      state: 'executed',
      grantIssued: true,
      grantClaimed: true,
      adapterPrimitiveInvoked: true,
      postObservationSucceeded: true,
      executionId: 'exec-1',
    });

    await assert.rejects(
      () => executor.execute(grant),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalError);
        assert.equal(error.code, 'INVALID_APPROVAL_TRANSITION');
        return true;
      },
    );
    assert.equal(fake.counts.click, 1);
    assert.equal(fake.counts.observePage, 1);
    assert.equal(manager.getByApprovalId(grant.approvalId)?.state, 'executed');
  });

  it('does not leave a claimed grant reusable when grant-issued audit throws', async () => {
    const fake = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant } = createHarness(fake.adapter, registry, new ThrowingAuditSink());

    await assert.doesNotReject(() => executor.execute(grant));
    assert.notEqual(manager.getByApprovalId(grant.approvalId)?.state, 'executing');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, true);

    await assert.rejects(() => executor.execute(grant));
    assert.equal(fake.counts.click, 1);
  });

  it('still marks stale when audit append throws and the registry is stale', async () => {
    const { adapter, counts } = createFakeAdapter();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-other', [targetRecord({ observationId: 'obs-other' })]);
    const { executor, manager, grant } = createHarness(adapter, registry, new ThrowingAuditSink());

    const result = await executor.execute(grant);
    assert.equal(result.status, 'stale');
    assert.equal(counts.click, 0);
    assert.equal(counts.observePage, 0);
    assert.deepEqual(snapshotFacts(manager, grant.approvalId), {
      state: 'stale',
      grantIssued: true,
      grantClaimed: true,
      adapterPrimitiveInvoked: false,
      postObservationSucceeded: false,
      executionId: 'exec-1',
    });

    await assert.rejects(() => executor.execute(grant));
    assert.equal(counts.click, 0);
    assert.throws(
      () => manager.claimExecuteGrant(grant.approvalId),
      (error: unknown) => {
        assert.ok(error instanceof ApprovalError);
        assert.equal(error.code, 'EXECUTE_GRANT_ALREADY_CLAIMED');
        return true;
      },
    );
  });

  it('still marks failed when audit append throws and click fails before the hook', async () => {
    const { adapter, counts } = createFakeAdapter({
      click: { beforeHookError: new InteractionError('INTERACTION_FAILED', 'debugger') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant } = createHarness(adapter, registry, new ThrowingAuditSink());

    const result = await executor.execute(grant);
    assert.equal(result.status, 'failed');
    assert.equal(counts.hook, 0);
    assert.equal(counts.observePage, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'failed');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, false);

    await assert.rejects(() => executor.execute(grant));
    assert.equal(counts.click, 1);
  });

  it('still marks unknown when audit append throws and click fails after the hook', async () => {
    const { adapter, counts } = createFakeAdapter({
      click: { afterHookError: new InteractionError('PAGE_CHANGED', 'after dispatch') },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant } = createHarness(adapter, registry, new ThrowingAuditSink());

    const result = await executor.execute(grant);
    assert.equal(result.status, 'execution-attempted-state-unknown');
    assert.equal(counts.click, 1);
    assert.equal(counts.hook, 1);
    assert.equal(counts.observePage, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'execution-attempted-state-unknown');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, true);

    await assert.rejects(() => executor.execute(grant));
    assert.equal(counts.click, 1);
  });

  it('does not append a second stale audit when lifecycle already invalidated during preflight', async () => {
    const started = new DeferredHold();
    const release = new DeferredHold();
    const { adapter, counts } = createFakeAdapter({
      click: {
        hold: {
          started: () => started.resolve(),
          wait: release.promise,
        },
        beforeHookError: new InteractionError('TARGET_STALE', 'registry replaced'),
      },
    });
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [targetRecord()]);
    const { executor, manager, grant, audit, auditRecorder } = createHarness(adapter, registry);

    const pending = executor.execute(grant);
    await started.promise;
    const changed = manager.invalidateTab('tab-1');
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.action.state, 'stale');
    auditRecorder.recordStale(grant.approvalId);
    release.resolve();

    const result = await pending;
    assert.equal(result.status, 'stale');
    assert.equal(counts.click, 1);
    assert.equal(counts.hook, 0);
    assert.equal(counts.input, 0);
    assert.equal(counts.observePage, 0);
    assert.equal(snapshotFacts(manager, grant.approvalId).state, 'stale');
    assert.equal(snapshotFacts(manager, grant.approvalId).adapterPrimitiveInvoked, false);
    assert.deepEqual(eventTypes(audit.getEvents()), ['execute-grant-issued', 'stale']);
  });

  it('keeps ExecuteExecutor free of renderer surfaces and new CDP methods', () => {
    const source = readFileSync(path.join(ROOT, 'src/approval/execute-executor.ts'), 'utf8');
    for (const token of [
      'executeJavaScript',
      'Runtime.',
      'DOM.resolveNode',
      'Target.attachToTarget',
      'Target.setAutoAttach',
      'Target.sendMessageToTarget',
      'approval:execute',
      'claimExecuteGrant(',
      'decide(',
      'prepare(',
    ]) {
      assert.equal(source.includes(token), false, token);
    }
  });
});
