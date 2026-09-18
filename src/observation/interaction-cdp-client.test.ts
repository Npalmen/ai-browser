import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import { InteractionCdpClient } from './interaction-cdp-client';

function createDebuggerStub() {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let attached = true;
  let destroyed = false;

  const debuggerApi = {
    isAttached: () => attached && !destroyed,
    sendCommand: async (method: string, params?: Record<string, unknown>) => {
      if (destroyed) {
        throw new Error('destroyed');
      }
      commands.push({ method, params });
      if (method === 'Page.getFrameTree') {
        return {
          frameTree: {
            frame: { id: 'frame-1', loaderId: 'loader-1', securityOrigin: 'https://example.com' },
          },
        };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } };
      }
      return {};
    },
    attach: () => {
      attached = true;
    },
    detach: () => {
      attached = false;
    },
  };

  const webContents = {
    isDestroyed: () => destroyed,
    debugger: debuggerApi,
  };

  return {
    webContents,
    commands,
    destroy: () => {
      destroyed = true;
      attached = false;
    },
  };
}

describe('InteractionCdpClient', () => {
  it('issues only allowlisted commands through typed methods', async () => {
    const stub = createDebuggerStub();
    const client = new InteractionCdpClient(stub.webContents as never);

    await client.getFrameTree();
    await client.getBoxModel(42);
    await client.dispatchMouseEvent({ type: 'mousePressed', x: 1, y: 2, button: 'left' });
    await client.dispatchKeyEvent({
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
    await client.insertText('hello');
    await client.getAccessibilityTree();
    await client.captureDomSnapshot();

    assert.deepEqual(
      stub.commands.map((command) => command.method),
      [
        'Page.getFrameTree',
        'DOM.getBoxModel',
        'Input.dispatchMouseEvent',
        'Input.dispatchKeyEvent',
        'Input.insertText',
        'Accessibility.getFullAXTree',
        'DOMSnapshot.captureSnapshot',
      ],
    );
    assert.equal(stub.commands[1]?.params?.backendNodeId, 42);
  });

  it('maps destroyed contents and debugger failures to InteractionError', async () => {
    const stub = createDebuggerStub();
    const client = new InteractionCdpClient(stub.webContents as never);
    stub.destroy();

    await assert.rejects(
      () => client.getFrameTree(),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'INTERACTION_FAILED');
        return true;
      },
    );
  });
});
