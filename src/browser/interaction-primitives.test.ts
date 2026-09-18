import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import { MAX_INTERACTION_SCROLL_AMOUNT_PX } from '../shared/interaction-types';
import type {
  CdpAccessibilityTreeResponse,
  CdpDomSnapshotResponse,
} from '../observation/cdp-types';
import type { InteractionCdpClient } from '../observation/interaction-cdp-client';
import {
  assertScrollIntoViewViewport,
  assertViewportScrollRequest,
  executeAdapterClick,
  executeAdapterScrollIntoView,
  executeAdapterSelect,
  executeAdapterType,
  executeAdapterViewportScroll,
} from './interaction-primitives';

function frameTree() {
  return {
    frameTree: {
      frame: { id: 'frame-1', loaderId: 'loader-1', securityOrigin: 'https://example.com' },
    },
  };
}

function boxModel() {
  return { model: { content: [100, 100, 120, 100, 120, 120, 100, 120] } };
}

function liveSelectSources(optionBackendNodeIds: number[], selectedBackendNodeId: number): {
  accessibilityTree: CdpAccessibilityTreeResponse;
  domSnapshot: CdpDomSnapshotResponse;
} {
  const strings = ['HTML', 'SELECT', 'OPTION', 'selected', ''];
  const parentIndex = [-1, 0];
  const nodeType = [1, 1];
  const nodeName = [0, 1];
  const nodeValue = [4, 4];
  const backendNodeId = [1, 10];
  const attributes: number[][] = [[], []];
  const axNodes: CdpAccessibilityTreeResponse['nodes'] = [
    { nodeId: 'select', role: { value: 'combobox' }, backendDOMNodeId: 10 },
  ];

  for (const [index, optionId] of optionBackendNodeIds.entries()) {
    parentIndex.push(1);
    nodeType.push(1);
    nodeName.push(2);
    nodeValue.push(4);
    backendNodeId.push(optionId);
    attributes.push(optionId === selectedBackendNodeId ? [3, 4] : []);
    axNodes.push({
      nodeId: `option-${index}`,
      role: { value: 'option' },
      backendDOMNodeId: optionId,
      properties:
        optionId === selectedBackendNodeId
          ? [{ name: 'selected', value: { type: 'boolean', value: true } }]
          : [],
    });
  }

  return {
    accessibilityTree: { nodes: axNodes },
    domSnapshot: {
      strings,
      documents: [
        {
          frameId: 'frame-1',
          nodes: { parentIndex, nodeType, nodeName, nodeValue, backendNodeId, attributes },
          layout: { nodeIndex: [], bounds: [], styles: [] },
        },
      ],
    },
  };
}

function createCdpStub(
  sources = liveSelectSources([11, 12, 13], 11),
) {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  const cdp: InteractionCdpClient = {
    getFrameTree: async () => {
      calls.push({ method: 'Page.getFrameTree' });
      return frameTree();
    },
    getBoxModel: async (backendNodeId: number) => {
      calls.push({ method: 'DOM.getBoxModel', params: { backendNodeId } });
      return boxModel();
    },
    getAccessibilityTree: async () => {
      calls.push({ method: 'Accessibility.getFullAXTree' });
      return sources.accessibilityTree;
    },
    captureDomSnapshot: async () => {
      calls.push({ method: 'DOMSnapshot.captureSnapshot' });
      return sources.domSnapshot;
    },
    dispatchMouseEvent: async (params) => {
      calls.push({ method: 'Input.dispatchMouseEvent', params: { ...params } });
    },
    dispatchKeyEvent: async (params) => {
      calls.push({ method: 'Input.dispatchKeyEvent', params: { ...params } });
    },
    insertText: async (text: string) => {
      calls.push({ method: 'Input.insertText', params: { text } });
    },
  } as InteractionCdpClient;

  return { cdp, calls };
}

describe('interaction primitives', () => {
  it('clicks using live box center after preflight', async () => {
    const { cdp, calls } = createCdpStub();

    const result = await executeAdapterClick(cdp, {
      target: {
        tabId: 'tab-1',
        frameId: 'frame-1',
        backendNodeId: 42,
        documentRevision: 'frame-1:loader-1',
      },
      observedBounds: { x: 100, y: 100, width: 20, height: 20 },
    });

    assert.equal(result.primitive, 'click');
    const mouseEvents = calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseEvents.length, 3);
    assert.equal(mouseEvents[1]?.params?.type, 'mousePressed');
    assert.equal(mouseEvents[2]?.params?.type, 'mouseReleased');
    assert.equal(mouseEvents[1]?.params?.x, 110);
    assert.equal(mouseEvents[1]?.params?.y, 110);
  });

  it('fails click when geometry drifts beyond tolerance', async () => {
    const { cdp } = createCdpStub();

    await assert.rejects(
      () =>
        executeAdapterClick(cdp, {
          target: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 42,
            documentRevision: 'frame-1:loader-1',
          },
          observedBounds: { x: 0, y: 0, width: 20, height: 20 },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_STALE');
        return true;
      },
    );
  });

  it('types using focus click, select-all, delete, and insertText', async () => {
    const { cdp, calls } = createCdpStub();

    await executeAdapterType(cdp, {
      target: {
        tabId: 'tab-1',
        frameId: 'frame-1',
        backendNodeId: 42,
        documentRevision: 'frame-1:loader-1',
      },
      text: 'hello',
    });

    const methods = calls.map((call) => call.method);
    assert.ok(methods.includes('Input.insertText'));
    assert.equal(calls.find((call) => call.method === 'Input.insertText')?.params?.text, 'hello');
    assert.ok(methods.filter((method) => method === 'Input.dispatchKeyEvent').length >= 4);
  });

  it('rejects oversized type text defensively', async () => {
    const { cdp } = createCdpStub();

    await assert.rejects(
      () =>
        executeAdapterType(cdp, {
          target: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 42,
            documentRevision: 'frame-1:loader-1',
          },
          text: 'x'.repeat(2_001),
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'INVALID_INTERACTION_PROPOSAL');
        return true;
      },
    );
  });

  it('selects by live backend identity, not filtered catalog position', async () => {
    const { cdp, calls } = createCdpStub();

    await executeAdapterSelect(cdp, {
      selectTarget: {
        tabId: 'tab-1',
        frameId: 'frame-1',
        backendNodeId: 10,
        documentRevision: 'frame-1:loader-1',
      },
      optionTarget: {
        tabId: 'tab-1',
        frameId: 'frame-1',
        backendNodeId: 13,
        documentRevision: 'frame-1:loader-1',
      },
    });

    const methods = calls.map((call) => call.method);
    assert.equal(methods.includes('Accessibility.getFullAXTree'), true);
    assert.equal(methods.includes('DOMSnapshot.captureSnapshot'), true);
    const preflightIndex = methods.indexOf('Accessibility.getFullAXTree');
    const mouseIndex = methods.indexOf('Input.dispatchMouseEvent');
    assert.ok(preflightIndex >= 0 && mouseIndex > preflightIndex);

    const mouseEvents = calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseEvents.length, 3);
    assert.equal(calls.filter((call) => call.method === 'DOM.getBoxModel').length, 1);
    const keyEvents = calls.filter((call) => call.method === 'Input.dispatchKeyEvent');
    assert.equal(keyEvents.filter((call) => call.params?.key === 'ArrowDown').length, 4);
    assert.equal(keyEvents.filter((call) => call.params?.key === 'Enter').length, 2);
  });

  it('fails closed before mouse input when the granted option is gone', async () => {
    const { cdp, calls } = createCdpStub(liveSelectSources([11, 12], 11));

    await assert.rejects(
      () =>
        executeAdapterSelect(cdp, {
          selectTarget: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 10,
            documentRevision: 'frame-1:loader-1',
          },
          optionTarget: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 13,
            documentRevision: 'frame-1:loader-1',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_NOT_FOUND');
        return true;
      },
    );

    assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 0);
    assert.equal(calls.filter((call) => call.method === 'Input.dispatchKeyEvent').length, 0);
  });

  it('scrolls viewport with bounded wheel deltas and rejects oversized amounts', () => {
    assert.throws(
      () =>
        assertViewportScrollRequest({
          tabId: 'tab-1',
          documentRevision: 'frame-1:loader-1',
          direction: 'down',
          amountPx: 700,
          viewportWidth: 800,
          viewportHeight: 600,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'INVALID_INTERACTION_PROPOSAL');
        return true;
      },
    );

    assert.throws(
      () =>
        assertViewportScrollRequest({
          tabId: 'tab-1',
          documentRevision: 'frame-1:loader-1',
          direction: 'down',
          amountPx: MAX_INTERACTION_SCROLL_AMOUNT_PX + 1,
          viewportWidth: 800,
          viewportHeight: 600,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'INVALID_INTERACTION_PROPOSAL');
        return true;
      },
    );
  });

  it('maps scroll directions to wheel deltas', async () => {
    const { cdp, calls } = createCdpStub();

    await executeAdapterViewportScroll(cdp, {
      tabId: 'tab-1',
      documentRevision: 'frame-1:loader-1',
      direction: 'down',
      amountPx: 120,
      viewportWidth: 800,
      viewportHeight: 600,
    });

    const wheel = calls.find((call) => call.method === 'Input.dispatchMouseEvent');
    assert.equal(wheel?.params?.type, 'mouseWheel');
    assert.equal(wheel?.params?.deltaY, 120);
  });

  it('scrolls into view with a bounded delta and succeeds when already visible', async () => {
    const { cdp, calls } = createCdpStub();

    await executeAdapterScrollIntoView(cdp, {
      target: {
        tabId: 'tab-1',
        frameId: 'frame-1',
        backendNodeId: 42,
        documentRevision: 'frame-1:loader-1',
      },
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
      observedBounds: { x: 100, y: 100, width: 20, height: 20 },
    });

    assert.equal(
      calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mouseWheel').length,
      0,
    );
  });

  it('rejects cross-tab select requests before dispatching mouse input', async () => {
    const { cdp, calls } = createCdpStub();

    await assert.rejects(
      () =>
        executeAdapterSelect(cdp, {
          selectTarget: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 10,
            documentRevision: 'frame-1:loader-1',
          },
          optionTarget: {
            tabId: 'tab-2',
            frameId: 'frame-1',
            backendNodeId: 11,
            documentRevision: 'frame-1:loader-1',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_STALE');
        return true;
      },
    );

    assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 0);
  });

  it('rejects select requests with mismatched document revisions before dispatching mouse input', async () => {
    const { cdp, calls } = createCdpStub();

    await assert.rejects(
      () =>
        executeAdapterSelect(cdp, {
          selectTarget: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 10,
            documentRevision: 'frame-1:loader-1',
          },
          optionTarget: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 11,
            documentRevision: 'frame-1:loader-2',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_STALE');
        return true;
      },
    );

    assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 0);
  });

  it('rejects select requests with mismatched frames before dispatching mouse input', async () => {
    const { cdp, calls } = createCdpStub();

    await assert.rejects(
      () =>
        executeAdapterSelect(cdp, {
          selectTarget: {
            tabId: 'tab-1',
            frameId: 'frame-1',
            backendNodeId: 10,
            documentRevision: 'frame-1:loader-1',
          },
          optionTarget: {
            tabId: 'tab-1',
            frameId: 'frame-2',
            backendNodeId: 11,
            documentRevision: 'frame-1:loader-1',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'UNSUPPORTED_FRAME');
        return true;
      },
    );

    assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 0);
  });

  it('rejects invalid scrollIntoView viewport values before dispatching mouse input', async () => {
    const { cdp, calls } = createCdpStub();
    const request = {
      target: {
        tabId: 'tab-1',
        frameId: 'frame-1',
        backendNodeId: 42,
        documentRevision: 'frame-1:loader-1',
      },
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
      observedBounds: { x: 100, y: 100, width: 20, height: 20 },
    };

    const invalidViewports = [
      { width: Number.NaN, height: 600, scrollX: 0, scrollY: 0 },
      { width: 800, height: Number.POSITIVE_INFINITY, scrollX: 0, scrollY: 0 },
      { width: 0, height: 600, scrollX: 0, scrollY: 0 },
      { width: 800, height: -1, scrollX: 0, scrollY: 0 },
      { width: 800, height: 600, scrollX: Number.NaN, scrollY: 0 },
      { width: 800, height: 600, scrollX: 0, scrollY: Number.NEGATIVE_INFINITY },
    ];

    for (const viewport of invalidViewports) {
      await assert.rejects(
        () => executeAdapterScrollIntoView(cdp, { ...request, viewport }),
        (error: unknown) => {
          assert.ok(error instanceof InteractionError);
          assert.equal(error.code, 'INTERACTION_FAILED');
          return true;
        },
      );
    }

    assert.equal(calls.filter((call) => call.method === 'Input.dispatchMouseEvent').length, 0);
  });

  it('validates scrollIntoView viewport dimensions defensively', () => {
    assert.throws(
      () => assertScrollIntoViewViewport({ width: 0, height: 600, scrollX: 0, scrollY: 0 }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'INTERACTION_FAILED');
        return true;
      },
    );
  });

  it('fails closed for unsupported cross-origin frames', async () => {
    const { cdp, calls } = createCdpStub();
    const originalGetFrameTree = cdp.getFrameTree.bind(cdp);
    cdp.getFrameTree = async () => {
      calls.push({ method: 'Page.getFrameTree' });
      return {
        frameTree: {
          frame: { id: 'frame-1', loaderId: 'loader-1', securityOrigin: 'https://example.com' },
          childFrames: [
            {
              frame: {
                id: 'frame-2',
                loaderId: 'loader-2',
                securityOrigin: 'https://other.test',
              },
            },
          ],
        },
      };
    };

    await assert.rejects(
      () =>
        executeAdapterClick(cdp, {
          target: {
            tabId: 'tab-1',
            frameId: 'frame-2',
            backendNodeId: 42,
            documentRevision: 'frame-1:loader-1',
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'UNSUPPORTED_FRAME');
        return true;
      },
    );
  });
});
