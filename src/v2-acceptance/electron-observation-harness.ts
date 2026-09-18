import assert from 'node:assert/strict';

import { app, BrowserWindow } from 'electron';

import { ReadOnlyAgent } from '../ai/read-only-agent';
import { ElectronPageObserver } from '../observation/electron-page-observer';
import { TargetRegistry } from '../observation/target-registry';
import {
  acknowledgeAsk,
  appendUserQuestion,
  applyAiAnswerEvent,
  emptyTabAiState,
} from '../app-ui/ai-ui-state';
import { readOnlyController } from './controller-fixtures';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import type { AiAnswerEvent } from '../shared/ai-types';
import { assertRendererSafeEvents, assertSecureModelMessages } from './assert-v2-security';
import {
  V2_ANSWER_DELTAS,
  V2_ANSWER_TEXT,
  V2_FIXTURE_CARD,
  V2_FIXTURE_FACT,
  V2_FIXTURE_HEADING,
  V2_FIXTURE_PASSWORD,
  V2_FIXTURE_PATH,
  V2_INJECTION_CANARY,
  V2_INVALID_TARGET_ID,
  V2_QUESTION,
  V2_TAB_ID,
} from './fixture-constants';
import { RecordingModelRuntime } from './recording-model-runtime';

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for acceptance condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function run(): Promise<void> {
  app.disableHardwareAcceleration();
  await app.whenReady();

  const fixture = await startObservationFixtureServer();
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  const webContents = window.webContents;
  const fixtureUrl = `${fixture.url.replace(/\/$/, '')}${V2_FIXTURE_PATH}`;

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out loading fixture (title=${webContents.getTitle()} url=${webContents.getURL()})`,
          ),
        );
      }, 15000);
      webContents.once('did-fail-load', (_event, code, description) => {
        clearTimeout(timeout);
        reject(new Error(`Fixture failed to load: ${code} ${description}`));
      });
      webContents.once('did-finish-load', () => {
        clearTimeout(timeout);
        resolve();
      });
      void window.loadURL(fixtureUrl);
    });
    const targetRegistry = new TargetRegistry();
    const observer = new ElectronPageObserver({
      resolveWebContents: (tabId) => {
        if (tabId !== V2_TAB_ID) {
          throw new Error(`Unexpected tab ${tabId}`);
        }
        return webContents;
      },
      targetRegistry,
    });

    const observation = await observer.observePage(V2_TAB_ID, { includeScreenshot: false });
    assert.equal(webContents.debugger.isAttached(), false, 'debugger remained attached');
    assert.equal(
      observation.document.url.includes('ai-readonly.html'),
      true,
      `unexpected document url: ${observation.document.url}`,
    );

    const serializedNodes = JSON.stringify(observation.nodes);
    const nodeNames = observation.nodes.map((node) => node.name ?? node.text ?? node.role).join(' | ');
    assert.equal(
      serializedNodes.includes(V2_FIXTURE_HEADING) || nodeNames.includes('verdite'),
      true,
      `missing fixture heading in nodes: ${nodeNames.slice(0, 500)}`,
    );
    assert.equal(
      serializedNodes.includes(V2_FIXTURE_FACT) || serializedNodes.includes('verdite'),
      true,
      `missing fixture fact in nodes: ${nodeNames.slice(0, 500)}`,
    );
    assert.equal(
      serializedNodes.includes(V2_INJECTION_CANARY),
      true,
      `missing injection canary in nodes: ${nodeNames.slice(0, 500)}`,
    );
    assert.equal(serializedNodes.includes(V2_FIXTURE_PASSWORD), false, 'password leaked into observation');
    assert.equal(serializedNodes.includes(V2_FIXTURE_CARD), false, 'card leaked into observation');
    assert.equal(
      observation.nodes.some((node) => node.states?.secret === true),
      true,
      'expected secret fields to be marked',
    );
    assert.equal(serializedNodes.includes(observation.observationId), false);

    const runtime = new RecordingModelRuntime({
      deltas: V2_ANSWER_DELTAS,
      text: V2_ANSWER_TEXT,
      pickExportedTarget: true,
      extraReferencedTargets: [V2_INVALID_TARGET_ID],
    });
    const agent = new ReadOnlyAgent({
      observationSource: {
        observePage: async (tabId, options) => {
          const next = await observer.observePage(tabId, {
            includeScreenshot: options?.includeScreenshot === true,
          });
          assert.equal(webContents.debugger.isAttached(), false);
          return next;
        },
      },
      modelRuntime: runtime,
      allowScreenshotExport: false,
    });

    const events: AiAnswerEvent[] = [];
    const controller = readOnlyController(agent, (event) => {
      events.push(event);
    });

    let ui = appendUserQuestion({}, V2_TAB_ID, V2_QUESTION, 'electron-sub-1');
    const started = controller.startAsk(V2_TAB_ID, V2_QUESTION, 'read');
    assert.equal(started.ok, true);
    if (!started.ok) {
      throw new Error('startAsk failed');
    }
    await waitUntil(() => events.some((event) => event.type === 'answer-finished'));
    for (const event of events) {
      ui = applyAiAnswerEvent(ui, event);
    }
    ui = acknowledgeAsk(ui, V2_TAB_ID, started.askId, 'electron-sub-1');

    const request = runtime.requests[0];
    assert.ok(request);
    assert.equal(request.profile.alias, 'page-standard');
    assertSecureModelMessages(request.messages, {
      question: V2_QUESTION,
      canary: V2_INJECTION_CANARY,
      secrets: [V2_FIXTURE_PASSWORD, V2_FIXTURE_CARD],
    });
    assertRendererSafeEvents(events);
    assert.equal(JSON.stringify(events).includes(V2_INVALID_TARGET_ID), false);

    const tab = ui[V2_TAB_ID] ?? emptyTabAiState();
    assert.equal(tab.entries.filter((entry) => entry.role === 'user').length, 1);
    assert.equal(tab.entries.filter((entry) => entry.role === 'assistant').length, 1);
    assert.equal(tab.entries.find((entry) => entry.role === 'assistant')?.text, V2_ANSWER_TEXT);
    assert.equal(tab.entries.find((entry) => entry.role === 'assistant')?.status, 'complete');
    assert.equal(tab.activeAskId, null);

    console.log('[v2-electron-observation] PASS');
  } finally {
    if (!window.isDestroyed()) {
      window.close();
    }
    await fixture.close();
  }
}

void run()
  .then(() => {
    app.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[v2-electron-observation] FAIL');
    console.error(error instanceof Error ? error.message : error);
    app.exit(1);
  });
