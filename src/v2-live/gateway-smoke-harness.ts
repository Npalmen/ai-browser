import { app, BrowserWindow } from 'electron';

import { ModelError } from '../ai/model-errors';
import { AiSdkGatewayRuntime } from '../ai/providers/ai-sdk-gateway';
import { ReadOnlyAgent } from '../ai/read-only-agent';
import { ElectronPageObserver } from '../observation/electron-page-observer';
import { TargetRegistry } from '../observation/target-registry';
import { startObservationFixtureServer } from '../../scripts/observation-fixture-server';
import { V2_FIXTURE_PATH, V2_QUESTION, V2_TAB_ID } from '../v2-acceptance/fixture-constants';

async function run(): Promise<void> {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (typeof key !== 'string' || key.trim() === '') {
    console.log('[v2-gateway-smoke] SKIPPED_NO_KEY');
    return;
  }

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
        reject(new Error('Timed out loading localhost fixture'));
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

    const agent = new ReadOnlyAgent({
      observationSource: {
        observePage: async (tabId, options) =>
          observer.observePage(tabId, {
            includeScreenshot: options?.includeScreenshot === true,
          }),
      },
      modelRuntime: new AiSdkGatewayRuntime(),
      allowScreenshotExport: false,
    });

    const answer = await agent.answer({
      tabId: V2_TAB_ID,
      question: V2_QUESTION,
      taskClass: 'page_question',
      needsVision: false,
      privacy: 'remoteAllowed',
    });

    if (!answer.text.trim()) {
      console.log('[v2-gateway-smoke] FAIL empty-answer');
      process.exitCode = 1;
      return;
    }

    console.log(`[v2-gateway-smoke] PASS alias=${answer.alias}`);
  } catch (error: unknown) {
    const code = error instanceof ModelError ? error.code : 'UNKNOWN';
    if (code === 'MODEL_UNAVAILABLE' || code === 'MODEL_RATE_LIMITED' || code === 'MODEL_TIMEOUT') {
      console.log(`[v2-gateway-smoke] EXTERNAL_${code}`);
      process.exitCode = 1;
      return;
    }
    console.log('[v2-gateway-smoke] FAIL');
    process.exitCode = 1;
  } finally {
    if (!window.isDestroyed()) {
      window.close();
    }
    await fixture.close();
  }
}

void run()
  .then(() => {
    const code = typeof process.exitCode === 'number' ? process.exitCode : 0;
    app.exit(code);
  })
  .catch(() => {
    app.exit(1);
  });
