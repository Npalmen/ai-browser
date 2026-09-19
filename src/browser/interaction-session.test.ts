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
    focus: () => undefined,
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

  it('clears in-flight state when debugger attach fails and allows a subsequent interaction', async () => {
    const manager = new InteractionSessionManager();
    let attachAttempts = 0;
    let attached = false;
    let detachCalled = false;

    const webContents = {
      isDestroyed: () => false,
      isDevToolsOpened: () => false,
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attachAttempts += 1;
          if (attachAttempts === 1) {
            throw new Error('attach failed');
          }
          attached = true;
        },
        detach: () => {
          attached = false;
          detachCalled = true;
        },
        on: () => undefined,
        removeListener: () => undefined,
      },
      once: () => undefined,
      removeListener: () => undefined,
    };

    await assert.rejects(
      () => manager.withSession('tab-1', webContents as never, async () => 'ok'),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'INTERACTION_FAILED');
        return true;
      },
    );
    assert.equal(manager.isInteractionInProgress('tab-1'), false);
    assert.equal(detachCalled, false);

    const result = await manager.withSession('tab-1', webContents as never, async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(manager.isInteractionInProgress('tab-1'), false);
    assert.equal(detachCalled, true);
  });

  it('clears in-flight state and detaches owned debugger when action fails', async () => {
    const manager = new InteractionSessionManager();
    let attached = false;
    let detachCalls = 0;

    const webContents = {
      isDestroyed: () => false,
      isDevToolsOpened: () => false,
      debugger: {
        isAttached: () => attached,
        attach: () => {
          attached = true;
        },
        detach: () => {
          attached = false;
          detachCalls += 1;
        },
        on: () => undefined,
        removeListener: () => undefined,
      },
      once: () => undefined,
      removeListener: () => undefined,
    };

    await assert.rejects(
      () =>
        manager.withSession('tab-1', webContents as never, async () => {
          throw new Error('action failed');
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'action failed');
        return true;
      },
    );
    assert.equal(manager.isInteractionInProgress('tab-1'), false);
    assert.equal(attached, false);
    assert.equal(detachCalls, 1);

    const result = await manager.withSession('tab-1', webContents as never, async () => 'ok');
    assert.equal(result, 'ok');
    assert.equal(manager.isInteractionInProgress('tab-1'), false);
    assert.equal(detachCalls, 2);
  });
});
