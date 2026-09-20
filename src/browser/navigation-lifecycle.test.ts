import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  TabNavigationLifecycle,
  getNavigationLifecycle,
  navigationWaitToError,
} from './navigation-lifecycle';

describe('TabNavigationLifecycle', () => {
  it('does not treat a pre-navigation loading=false snapshot as settled', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    const pending = lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 80 });
    await Promise.resolve();
    lifecycle.noteMainFrameNavigationStart('tab-1');
    lifecycle.noteMainFrameNavigationSettled('tab-1');
    const result = await pending;
    assert.equal(result.status, 'settled');
    if (result.status === 'settled') {
      assert.equal(result.kind, 'main-frame');
      assert.equal(result.generation > marker.generation, true);
    }
  });

  it('detects a navigation that starts before the click promise resolves', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    lifecycle.noteMainFrameNavigationStart('tab-1');
    lifecycle.noteMainFrameNavigationSettled('tab-1');
    const result = await lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 20 });
    assert.equal(result.status, 'settled');
  });

  it('times out when no newer transition occurs', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    const result = await lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 15 });
    assert.equal(result.status, 'timeout');
    if (result.status === 'timeout') {
      assert.equal(result.started, false);
    }
  });

  it('times out as started when a transition never settles', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    lifecycle.noteMainFrameNavigationStart('tab-1');
    const result = await lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 15 });
    assert.equal(result.status, 'timeout');
    if (result.status === 'timeout') {
      assert.equal(result.started, true);
    }
  });

  it('preserves cancellation during an in-flight wait', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    const controller = new AbortController();
    const pending = lifecycle.waitForNavigationAfter('tab-1', marker, {
      timeoutMs: 200,
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'cancelled');
    assert.equal(navigationWaitToError(result).code, 'REQUEST_CANCELLED');
  });

  it('treats same-document navigation as a settled transition', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    lifecycle.noteSameDocumentNavigation('tab-1');
    const result = await lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 20 });
    assert.equal(result.status, 'settled');
    if (result.status === 'settled') {
      assert.equal(result.kind, 'same-document');
    }
  });

  it('does not double-count in-place start plus did-navigate-in-page', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    lifecycle.noteMainFrameNavigationStart('tab-1', { sameDocument: true });
    lifecycle.noteSameDocumentNavigation('tab-1');
    const result = await lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 20 });
    assert.equal(result.status, 'settled');
    if (result.status === 'settled') {
      assert.equal(result.generation, marker.generation + 1);
      assert.equal(result.kind, 'same-document');
    }
  });

  it('settles immediately when the source tab opens a converted popup', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    const pending = lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 80 });
    lifecycle.notePopupOpenedFrom('tab-1');
    const result = await pending;
    assert.equal(result.status, 'settled');
    if (result.status === 'settled') {
      assert.equal(result.kind, 'popup');
    }
  });

  it('waits for the latest inflight generation to settle', async () => {
    const lifecycle = new TabNavigationLifecycle();
    const marker = lifecycle.captureMarker('tab-1');
    lifecycle.noteMainFrameNavigationStart('tab-1');
    lifecycle.noteMainFrameNavigationStart('tab-1');
    const pending = lifecycle.waitForNavigationAfter('tab-1', marker, { timeoutMs: 80 });
    lifecycle.noteMainFrameNavigationSettled('tab-1');
    const result = await pending;
    assert.equal(result.status, 'settled');
  });
});

describe('navigation lifecycle wiring isolation', () => {
  it('keeps marker APIs off BrowserAdapter, IPC, preload, and the model', () => {
    const root = path.resolve(__dirname, '..', '..');
    const adapterInterface = readFileSync(path.join(root, 'src/browser/browser-adapter.ts'), 'utf8');
    const ipc = readFileSync(path.join(root, 'src/main/ipc.ts'), 'utf8');
    const contract = readFileSync(path.join(root, 'src/shared/ipc-contract.ts'), 'utf8');
    const preload = readFileSync(path.join(root, 'src/preload/app-preload.ts'), 'utf8');
    const electronAdapter = readFileSync(path.join(root, 'src/browser/electron-adapter.ts'), 'utf8');

    for (const token of ['captureNavigationMarker', 'waitForNavigationAfter']) {
      assert.equal(adapterInterface.includes(token), false, `BrowserAdapter leaked ${token}`);
      assert.equal(ipc.includes(token), false, `ipc leaked ${token}`);
      assert.equal(contract.includes(token), false, `ipc-contract leaked ${token}`);
      assert.equal(preload.includes(token), false, `preload leaked ${token}`);
      assert.equal(electronAdapter.includes(token), true, `ElectronBrowserAdapter missing ${token}`);
    }

    const handlerStart = electronAdapter.indexOf('private attachWebContentsHandlers');
    const handlerEnd = electronAdapter.indexOf('private publishState');
    const handlers = electronAdapter.slice(handlerStart, handlerEnd);
    assert.match(handlers, /did-start-navigation/);
    assert.match(handlers, /did-navigate-in-page/);
    assert.match(handlers, /did-stop-loading/);
    assert.match(handlers, /did-fail-load/);
    assert.match(handlers, /noteMainFrameNavigationStart/);
    assert.match(handlers, /noteSameDocumentNavigation/);
    assert.match(handlers, /noteMainFrameNavigationSettled/);
    assert.match(handlers, /notePopupOpenedFrom/);

    const popupHandler = electronAdapter.slice(
      electronAdapter.indexOf('setWindowOpenHandler'),
      electronAdapter.indexOf("webContents.on('render-process-gone'"),
    );
    assert.ok(popupHandler.indexOf('notePopupOpenedFrom') < popupHandler.indexOf('createTabInternal'));
  });

  it('does not treat duck-typed adapters without both methods as a lifecycle port', () => {
    assert.equal(getNavigationLifecycle({}), undefined);
    assert.equal(
      getNavigationLifecycle({
        captureNavigationMarker: () => ({ tabId: 't', generation: 0, popupGeneration: 0 }),
      }),
      undefined,
    );
  });
});
