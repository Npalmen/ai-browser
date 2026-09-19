import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

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

describe('V2 architecture and preload security', () => {
  it('keeps browser and observation free of AI SDK imports', () => {
    const forbidden = /from ['"]ai['"]|from ['"]@ai-sdk\/|from ['"]\.\.\/ai\/|from ['"]\.\.\/\.\.\/ai\//;
    for (const directory of ['src/browser', 'src/observation']) {
      for (const file of collectTsFiles(path.join(ROOT, directory))) {
        const source = readFileSync(file, 'utf8');
        assert.equal(forbidden.test(source), false, file);
      }
    }
  });

  it('confines the production ai SDK import to the Gateway adapter', () => {
    const files = collectTsFiles(path.join(ROOT, 'src'));
    const aiImports = files.filter((file) => {
      if (file.includes(`${path.sep}v2-acceptance${path.sep}`)) {
        return false;
      }
      const source = readFileSync(file, 'utf8');
      return /from ['"]ai['"]/.test(source);
    });
    assert.deepEqual(
      aiImports.map((file) => path.relative(ROOT, file).replaceAll('\\', '/')),
      ['src/ai/providers/ai-sdk-gateway.ts'],
    );
  });

  it('keeps package production dependencies limited to ai', () => {
    const pkg = JSON.parse(readSrc('package.json')) as {
      dependencies?: Record<string, string>;
    };
    assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['ai']);
    assert.equal('zod' in (pkg.dependencies ?? {}), false);
    assert.equal('@ai-sdk/openai' in (pkg.dependencies ?? {}), false);
    assert.equal('@ai-sdk/anthropic' in (pkg.dependencies ?? {}), false);
  });

  it('exposes browserShell, aiAssistant, and workflows from preload', () => {
    const preload = readSrc('src/preload/app-preload.ts');
    assert.match(preload, /exposeInMainWorld\('browserShell'/);
    assert.match(preload, /exposeInMainWorld\('aiAssistant'/);
    assert.match(preload, /exposeInMainWorld\('workflows'/);
    assert.equal(preload.includes("exposeInMainWorld('ipcRenderer'"), false);
    assert.match(preload, /askCurrentPage:/);
    assert.match(preload, /cancelAsk:/);
    assert.match(preload, /clearConversation:/);
    assert.match(preload, /setPanelOpen:/);
    assert.match(preload, /onAnswerEvent:/);
    assert.match(preload, /AI_IPC_CHANNELS\.askCurrentPage/);
    assert.match(preload, /AI_IPC_CHANNELS\.cancelAsk/);
    assert.match(preload, /AI_IPC_CHANNELS\.clearConversation/);
    assert.match(preload, /AI_IPC_CHANNELS\.setPanelOpen/);
    assert.match(preload, /AI_IPC_CHANNELS\.answerEvent/);
    assert.match(preload, /WORKFLOW_IPC_CHANNELS\.getState/);
    assert.equal(preload.includes('invoke(channel'), false);
    assert.equal(preload.includes('readFile'), false);
    assert.equal(preload.includes('writeFile'), false);
    for (const forbidden of [
      'generate(',
      'callModel',
      'sendPrompt',
      'observePage',
      'ipcRenderer.send',
      'providerOptions',
      'system prompt',
    ]) {
      assert.equal(preload.includes(forbidden), false, forbidden);
    }
  });

  it('keeps website WebContents sandboxed without preload', () => {
    const adapter = readSrc('src/browser/electron-adapter.ts');
    const blockStart = adapter.indexOf('private createWebsiteView()');
    assert.ok(blockStart >= 0);
    const block = adapter.slice(blockStart, blockStart + 450);
    assert.match(block, /nodeIntegration:\s*false/);
    assert.match(block, /contextIsolation:\s*true/);
    assert.match(block, /sandbox:\s*true/);
    assert.match(block, /webSecurity:\s*true/);
    assert.match(block, /webviewTag:\s*false/);
    assert.equal(block.includes('preload:'), false);
  });

  it('requires sender and mainFrame identity together', () => {
    const security = readSrc('src/main/ipc-security.ts');
    assert.match(security, /sender === mainWebContents/);
    assert.match(security, /senderFrame === mainFrame/);
    assert.equal(security.includes('same origin'), false);
    assert.equal(security.includes('event.senderFrame === event.sender.mainFrame'), false);
  });

  it('does not add AI browser actions', () => {
    const agent = readSrc('src/ai/read-only-agent.ts');
    for (const primitive of ['click(', 'type(', 'select(', 'scroll(', 'PREPARE_ACTION', 'EXECUTE']) {
      assert.equal(agent.includes(primitive), false, primitive);
    }
    const runtime = readSrc('src/main/ai-runtime.ts');
    assert.match(runtime, /allowScreenshotExport:\s*false/);
  });

  it('does not expose primitive interaction IPC channels', () => {
    const contract = readSrc('src/shared/ipc-contract.ts');
    for (const forbidden of [
      'ai:click',
      'ai:type',
      'ai:select',
      'ai:scroll',
      'ai:execute',
      'ai:run-proposal',
      'ai:grant',
    ]) {
      assert.equal(contract.includes(forbidden), false, forbidden);
    }
    const preload = readSrc('src/preload/app-preload.ts');
    for (const forbidden of ['click:', 'type:', 'select:', 'scroll:', 'execute:', 'runInteraction']) {
      assert.equal(preload.includes(forbidden), false, forbidden);
    }
  });

  it('renders assistant output as React text children', () => {
    const panel = readSrc('src/app-ui/AiSidePanel.tsx');
    assert.equal(panel.includes('dangerouslySetInnerHTML'), false);
    assert.equal(panel.includes('innerHTML'), false);
    assert.match(panel, /\{entry\.text\}/);
  });
});
