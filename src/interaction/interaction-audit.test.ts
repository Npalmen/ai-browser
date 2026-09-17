import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BoundInteractionProposal } from '../shared/interaction-types';
import { buildPolicyAuditEvent, InMemoryInteractionAuditSink } from './interaction-audit';
import { InteractionExecutor } from './interaction-executor';
import { TargetRegistry } from '../observation/target-registry';
import type { BrowserAdapter } from '../browser/browser-adapter';
import type { PageObservation } from '../shared/observation-types';

function observation(): PageObservation {
  return {
    observationId: 'obs-1',
    tabId: 'tab-1',
    capturedAt: 1,
    document: {
      revision: 'rev-1',
      url: 'https://example.com',
      title: 'Example',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 },
    nodes: [
      {
        frameId: 'frame-1',
        role: 'textbox',
        tag: 'input',
        interactive: true,
        visible: true,
        inViewport: true,
        targetId: 'target-1',
        states: { editable: true, secret: true },
        attributes: { type: 'password' },
      },
    ],
    stats: {
      sourceAxNodeCount: 1,
      sourceDomNodeCount: 1,
      emittedNodeCount: 1,
      truncated: false,
      redactedValueCount: 1,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
  };
}

describe('interaction audit', () => {
  it('records metadata-only policy events', () => {
    const sink = new InMemoryInteractionAuditSink();
    const proposal: BoundInteractionProposal = {
      kind: 'click',
      targetId: 'target-1',
      tabId: 'tab-1',
      observationId: 'obs-1',
      documentRevision: 'rev-1',
    };

    sink.append(
      buildPolicyAuditEvent({
        actionId: 'action-1',
        timestamp: 1,
        proposal,
        policyOutcome: 'DENY',
        resultStatus: 'denied',
        errorCode: 'INTERACTION_DENIED',
      }),
    );

    const serialized = JSON.stringify(sink.getEvents());
    assert.equal(serialized.includes('backendNodeId'), false);
    assert.equal(serialized.includes('frameId'), false);
    assert.equal(serialized.includes('screenshot'), false);
  });

  it('does not store typed proposal text in audit events', async () => {
    const audit = new InMemoryInteractionAuditSink();
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [
      {
        targetId: 'target-1',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
        frameId: 'frame-1',
        backendNodeId: 1,
      },
    ]);

    const adapter: BrowserAdapter = {
      createTab: async () => 'tab-1',
      closeTab: async () => undefined,
      activateTab: async () => undefined,
      navigate: async () => undefined,
      back: async () => undefined,
      forward: async () => undefined,
      reload: async () => undefined,
      getPageState: async () => ({
        tabId: 'tab-1',
        url: 'https://example.com',
        title: 'Example',
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }),
      observePage: async () => observation(),
      click: async () => ({ primitive: 'click' }),
      type: async () => ({ primitive: 'type' }),
      select: async () => ({ primitive: 'select' }),
      scroll: async () => ({ primitive: 'scroll' }),
      scrollIntoView: async () => ({ primitive: 'scroll' }),
    };

    const executor = new InteractionExecutor({
      adapter,
      targetRegistry: registry,
      audit,
      generateActionId: () => 'action-audit',
      now: () => 1,
    });

    await executor.execute({
      proposal: {
        kind: 'type',
        targetId: 'target-1',
        text: 'AUDIT_TYPED_SECRET_DO_NOT_STORE',
        tabId: 'tab-1',
        observationId: 'obs-1',
        documentRevision: 'rev-1',
      },
      observation: observation(),
    });

    const serialized = JSON.stringify(audit.getEvents());
    assert.equal(serialized.includes('AUDIT_TYPED_SECRET_DO_NOT_STORE'), false);
    assert.equal(serialized.includes('backendNodeId'), false);
    assert.equal(serialized.includes('axNodeId'), false);
    assert.equal(serialized.includes('frameId'), false);
    assert.equal(serialized.includes('screenshot'), false);
  });
});
