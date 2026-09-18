import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { AI_IPC_CHANNELS } from '../shared/ipc-contract';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function collectTsFiles(directory: string): string[] {
  const entries = readdirSync(directory);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(directory, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      files.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function collectProductionFiles(directories: string[]): string[] {
  const files: string[] = [];
  for (const directory of directories) {
    for (const file of collectTsFiles(path.join(ROOT, directory))) {
      if (file.includes(`${path.sep}v2-acceptance${path.sep}`)) {
        continue;
      }
      if (file.includes(`${path.sep}v3-acceptance${path.sep}`)) {
        continue;
      }
      files.push(file);
    }
  }
  return files;
}

describe('V3 security gates', () => {
  it('keeps forbidden execution paths out of production interaction code', () => {
    const forbidden = [
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'DOM.resolveNode',
      'Target.attachToTarget',
      'Target.setAutoAttach',
      'Target.sendMessageToTarget',
      'executeJavaScript',
    ];
    const files = collectProductionFiles(['src/browser', 'src/interaction', 'src/observation']);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const token of forbidden) {
        assert.equal(source.includes(token), false, `${path.relative(ROOT, file)} leaked ${token}`);
      }
    }
  });

  it('keeps the interaction CDP allowlist closed', () => {
    const cdpClient = readSrc('src/observation/interaction-cdp-client.ts');
    assert.match(cdpClient, /Page\.getFrameTree/);
    assert.match(cdpClient, /DOM\.getBoxModel/);
    assert.match(cdpClient, /Input\.dispatchMouseEvent/);
    assert.match(cdpClient, /Input\.dispatchKeyEvent/);
    assert.match(cdpClient, /Input\.insertText/);
    assert.equal(cdpClient.includes('DOM.resolveNode'), false);
    assert.equal(cdpClient.includes('Runtime.evaluate'), false);
    assert.equal(cdpClient.includes('Target.attachToTarget'), false);
  });

  it('keeps production AI code free of browser interaction authority', () => {
    const forbiddenImports = [
      'BrowserAdapter',
      'ElectronBrowserAdapter',
      'InteractionCdpClient',
      'TargetRegistry',
      "from 'electron'",
      'from "electron"',
      'WebContents',
    ];
    const files = collectProductionFiles(['src/ai']);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const token of forbiddenImports) {
        assert.equal(source.includes(token), false, `${path.relative(ROOT, file)} leaked ${token}`);
      }
    }
  });

  it('preserves Phase 5 IPC and preload isolation', () => {
    const contract = readSrc('src/shared/ipc-contract.ts');
    for (const forbidden of [
      'ai:click',
      'ai:type',
      'ai:select',
      'ai:scroll',
      'ai:execute',
      'ai:grant',
      'ai:proposal',
    ]) {
      assert.equal(contract.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(Object.keys(AI_IPC_CHANNELS), [
      'askCurrentPage',
      'cancelAsk',
      'clearConversation',
      'setPanelOpen',
      'answerEvent',
    ]);

    const preload = readSrc('src/preload/app-preload.ts');
    for (const forbidden of ['click:', 'type:', 'select:', 'scroll:', 'execute:', 'runInteraction']) {
      assert.equal(preload.includes(forbidden), false, forbidden);
    }
    const aiTypes = readSrc('src/shared/ai-types.ts');
    assert.match(aiTypes, /mode: AiRequestMode/);
  });

  it('keeps trusted sender identity exact', () => {
    const security = readSrc('src/main/ipc-security.ts');
    assert.match(security, /sender === mainWebContents/);
    assert.match(security, /senderFrame === mainFrame/);
  });
});
