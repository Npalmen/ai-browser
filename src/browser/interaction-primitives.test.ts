import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import { MAX_INTERACTION_SCROLL_AMOUNT_PX } from '../shared/interaction-types';
import type { InteractionCdpClient } from '../observation/interaction-cdp-client';
import {
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

function createCdpStub() {
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

  it('selects by clicking select then option centers', async () => {
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
        backendNodeId: 11,
        documentRevision: 'frame-1:loader-1',
      },
    });

    const mouseEvents = calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
    assert.equal(mouseEvents.length, 6);
    assert.equal(calls.filter((call) => call.method === 'DOM.getBoxModel').length, 2);
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
