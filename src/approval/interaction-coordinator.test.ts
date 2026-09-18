import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ApprovalManager } from './approval-manager';
import { InMemoryApprovalAuditSink } from './approval-audit';
import { InteractionCoordinator } from './interaction-coordinator';
import { PrepareActionService } from './prepare-action-service';
import type { PreparedAction } from '../shared/approval-types';
import { InteractionError } from '../shared/interaction-errors';
import type {
  BoundInteractionProposal,
  InteractionResult,
} from '../shared/interaction-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import type { InteractionExecutionPort, InteractiveExecutionResult } from '../ai/interactive-agent';
import type { PageState } from '../shared/browser-types';

function pageState(): PageState {
  return {
    tabId: 'tab-1',
    url: 'https://shop.test/checkout',
    title: 'Checkout',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

function node(overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: true,
    visible: true,
    inViewport: true,
    ...overrides,
  };
}

function observation(nodes: ObservationNode[]): PageObservation {
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
  };
}

function buyButton(): ObservationNode {
  return node({
    role: 'button',
    tag: 'button',
    targetId: 'target-1',
    name: 'Buy now',
    attributes: { type: 'button' },
  });
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

function boundSelect(): BoundInteractionProposal {
  return {
    kind: 'select',
    targetId: 'target-1',
    optionTargetId: 'option-1',
    tabId: 'tab-1',
    observationId: 'obs-1',
    documentRevision: 'rev-1',
  };
}

function denied(errorCode: InteractionResult['errorCode']): InteractionResult {
  return {
    actionId: 'action-1',
    status: 'denied',
    pageState: pageState(),
    errorCode,
  };
}

function succeeded(): InteractionResult {
  return {
    actionId: 'action-1',
    status: 'succeeded',
    pageState: pageState(),
  };
}

function createHarness(v3Result: InteractiveExecutionResult) {
  const manager = new ApprovalManager({
    now: () => 1_000,
    generatePreparedActionId: () => 'prep-1',
    generateApprovalId: () => 'appr-1',
  });
  const audit = new InMemoryApprovalAuditSink();
  const prepareActionService = new PrepareActionService({ manager, audit });
  const presented: PreparedAction[] = [];
  const adapterClicks: number[] = [];
  const v3: InteractionExecutionPort = {
    async execute() {
      return v3Result;
    },
  };
  const coordinator = new InteractionCoordinator({
    interactionExecutor: v3,
    prepareActionService,
    approvalPresenter: {
      present(action) {
        presented.push(action);
        return true;
      },
    },
  });
  return {
    coordinator,
    manager,
    presented,
    adapterClicks,
    page: observation([buyButton()]),
  };
}

describe('InteractionCoordinator', () => {
  it('prepares and presents a deferred consequential click without executing', async () => {
    const harness = createHarness(denied('DEFERRED_TO_EXECUTE'));
    const result = await harness.coordinator.execute({
      proposal: boundClick(),
      observation: harness.page,
    });

    assert.deepEqual(result, { status: 'approval-required' });
    assert.equal(harness.presented.length, 1);
    assert.equal(harness.manager.getByApprovalId('appr-1')?.state, 'pending');
    assert.equal(harness.adapterClicks.length, 0);
    assert.equal(JSON.stringify(result).includes('approvalId'), false);
    assert.equal(JSON.stringify(result).includes('targetId'), false);
    assert.equal(JSON.stringify(result).includes('ExecuteGrant'), false);
  });

  it('returns TARGET_SENSITIVE denials unchanged', async () => {
    const v3Denial = denied('TARGET_SENSITIVE');
    const harness = createHarness(v3Denial);
    const result = await harness.coordinator.execute({
      proposal: boundClick(),
      observation: harness.page,
    });

    assert.equal(result, v3Denial);
    assert.equal(harness.presented.length, 0);
    assert.equal(harness.manager.getPendingForTab('tab-1'), undefined);
  });

  it('returns successful V3 results unchanged', async () => {
    const v3Success = succeeded();
    const harness = createHarness(v3Success);
    const result = await harness.coordinator.execute({
      proposal: boundClick(),
      observation: harness.page,
    });

    assert.equal(result, v3Success);
    assert.equal(harness.presented.length, 0);
    assert.equal(harness.manager.getPendingForTab('tab-1'), undefined);
  });

  it('does not prepare deferred select proposals', async () => {
    const v3Denial = denied('DEFERRED_TO_EXECUTE');
    const harness = createHarness(v3Denial);
    const result = await harness.coordinator.execute({
      proposal: boundSelect(),
      observation: harness.page,
    });

    assert.equal(result, v3Denial);
    assert.equal(harness.presented.length, 0);
    assert.equal(harness.manager.getPendingForTab('tab-1'), undefined);
  });

  it('does not prepare when the request is cancelled before V4 preparation', async () => {
    const harness = createHarness(denied('DEFERRED_TO_EXECUTE'));
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        harness.coordinator.execute({
          proposal: boundClick(),
          observation: harness.page,
          signal: controller.signal,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'REQUEST_CANCELLED');
        return true;
      },
    );
    assert.equal(harness.presented.length, 0);
    assert.equal(harness.manager.getPendingForTab('tab-1'), undefined);
  });
});
