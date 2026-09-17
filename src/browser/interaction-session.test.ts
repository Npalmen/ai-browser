import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import { InteractionSessionManager } from './interaction-session';

function createWebContentsStub(options: { attached?: boolean; destroyed?: boolean } = {}) {
  let attached = options.attached ?? false;
  const destroyed = options.destroyed ?? false;

  return {
    isDestroyed: () => destroyed,
    isDevToolsOpened: () => false,
    debugger: {
      isAttached: () => attached && !destroyed,
      attach: () => {
        attached = true;
      },
      detach: () => {
        attached = false;
      },
      on: () => undefined,
      removeListener: () => undefined,
    },
    once: () => undefined,
    removeListener: () => undefined,
  };
}

describe('InteractionSessionManager', () => {
  it('rejects when debugger is already attached', async () => {
    const manager = new InteractionSessionManager();
    const webContents = createWebContentsStub({ attached: true });

    await assert.rejects(
      () =>
        manager.withSession('tab-1', webContents as never, async () => 'ok'),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'INTERACTION_FAILED');
        return true;
      },
    );
  });

  it('rejects concurrent interaction on the same tab', async () => {
    const manager = new InteractionSessionManager();
    const webContents = createWebContentsStub();

    const first = manager.withSession('tab-1', webContents as never, async () => {
      await assert.rejects(
        () => manager.withSession('tab-1', webContents as never, async () => 'nested'),
        (error: unknown) => {
          assert.ok(error instanceof InteractionError);
          assert.equal(error.code, 'INTERACTION_IN_PROGRESS');
          return true;
        },
      );
      return 'done';
    });

    await first;
  });
});
