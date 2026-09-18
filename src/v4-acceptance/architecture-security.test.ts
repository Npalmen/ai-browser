import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseAgentModelOutput } from '../ai/interaction-output-schema';
import { ModelError } from '../ai/model-errors';
import { parseApprovalDecideRequest } from '../main/approval-ipc-guards';
import { APPROVAL_IPC_CHANNELS, AI_IPC_CHANNELS } from '../shared/ipc-contract';

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
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function isAcceptanceOrTest(file: string): boolean {
  const normalized = file.split(path.sep).join('/');
  return (
    normalized.includes('/v2-acceptance/') ||
    normalized.includes('/v3-acceptance/') ||
    normalized.includes('/v4-acceptance/') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx')
  );
}

function collectProductionFiles(directories: string[]): string[] {
  const files: string[] = [];
  for (const directory of directories) {
    for (const file of collectTsFiles(path.join(ROOT, directory))) {
      if (!isAcceptanceOrTest(file)) {
        files.push(file);
      }
    }
  }
  return files;
}

describe('V4 architecture and security gates', () => {
  it('keeps model output contracts free of approval authority fields', () => {
    const schema = readSrc('src/ai/interaction-output-schema.ts');
    const context = readSrc('src/ai/interaction-context-builder.ts');
    const validator = readSrc('src/interaction/proposal-validator.ts');
    for (const source of [schema, context, validator]) {
      for (const token of [
        'approvalId',
        'executionId',
        'ExecuteGrant',
        "authority: 'EXECUTE'",
        'approved: true',
        'claimExecuteGrant',
      ]) {
        assert.equal(source.includes(token), false, token);
      }
    }

    assert.throws(
      () =>
        parseAgentModelOutput({
          kind: 'interaction',
          proposal: {
            kind: 'click',
            targetId: 'target',
            approved: true,
            authority: 'EXECUTE',
            approvalId: 'fake',
          },
        }),
      (error: unknown) => error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
    );
  });

  it('exposes only approval:decide and approval:event channels', () => {
    assert.deepEqual(Object.keys(APPROVAL_IPC_CHANNELS), ['decide', 'event']);
    assert.deepEqual(Object.values(APPROVAL_IPC_CHANNELS), ['approval:decide', 'approval:event']);
    const contract = readSrc('src/shared/ipc-contract.ts');
    const ipc = readSrc('src/main/ipc.ts');
    for (const source of [contract, ipc]) {
      for (const forbidden of [
        'approval:execute',
        'approval:click',
        'approval:grant',
        'approval:create',
        'approval:prepare',
        'approval:target',
        'ai:execute',
        'ai:click',
        'ai:grant',
        'ai:proposal',
      ]) {
        assert.equal(source.includes(forbidden), false, forbidden);
      }
    }
    assert.deepEqual(Object.keys(AI_IPC_CHANNELS), [
      'askCurrentPage',
      'cancelAsk',
      'clearConversation',
      'setPanelOpen',
      'answerEvent',
    ]);
  });

  it('accepts only approvalId and decision from the untrusted renderer', () => {
    const parsed = parseApprovalDecideRequest({ approvalId: 'appr-1', decision: 'approve' });
    assert.equal(parsed.ok, true);

    for (const extra of [
      'targetId',
      'tabId',
      'observationId',
      'documentRevision',
      'preparedActionId',
      'executionId',
      'authority',
      'proposal',
      'grant',
    ]) {
      const rejected = parseApprovalDecideRequest({
        approvalId: 'appr-1',
        decision: 'approve',
        [extra]: 'injected',
      });
      assert.equal(rejected.ok, false, extra);
    }
  });

  it('limits preload to decideApproval and onApprovalEvent', () => {
    const preload = readSrc('src/preload/app-preload.ts');
    assert.match(preload, /decideApproval:/);
    assert.match(preload, /onApprovalEvent:/);
    for (const forbidden of [
      'click:',
      'execute:',
      'executeApproval',
      'claimGrant',
      'runGrant',
      'prepareApproval',
      'target:',
      'proposal:',
    ]) {
      assert.equal(preload.includes(forbidden), false, forbidden);
    }

    const websiteView = readSrc('src/browser/electron-adapter.ts');
    const viewBlockStart = websiteView.indexOf('private createWebsiteView()');
    assert.ok(viewBlockStart >= 0);
    const viewBlock = websiteView.slice(viewBlockStart, viewBlockStart + 450);
    assert.equal(viewBlock.includes('preload:'), false);
  });

  it('keeps AI events and renderer approval events free of execution handles', () => {
    const aiTypes = readSrc('src/shared/ai-types.ts');
    const approvalRequired = aiTypes.slice(
      aiTypes.indexOf("type: 'interaction-approval-required'"),
      aiTypes.indexOf("type: 'interaction-approval-required'") + 220,
    );
    for (const token of ['approvalId', 'targetId', 'preparedActionId', 'executionId', 'grant']) {
      assert.equal(approvalRequired.includes(token), false, token);
    }

    const approvalTypes = readSrc('src/shared/approval-types.ts');
    const pendingView = approvalTypes.slice(
      approvalTypes.indexOf('export interface PendingApprovalView'),
      approvalTypes.indexOf('export type ApprovalSafeErrorCode'),
    );
    assert.match(pendingView, /approvalId/);
    assert.match(pendingView, /tabId/);
    assert.match(pendingView, /category/);
    assert.match(pendingView, /title/);
    assert.match(pendingView, /expiresAt/);
    for (const token of [
      'preparedActionId',
      'targetId',
      'observationId',
      'documentRevision',
      'executionId',
      'ExecuteGrant',
      'backendNodeId',
      'frameId',
      'proposal',
      'authority',
    ]) {
      assert.equal(pendingView.includes(token), false, token);
    }
  });

  it('instantiates exactly one production ApprovalManager and shares it', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    assert.equal(runtime.split('new ApprovalManager(').length - 1, 1);
    assert.match(runtime, /new PrepareActionService\(\{ manager/);
    assert.match(runtime, /new ApprovalLifecycle\(\{[\s\S]*manager,/);
    assert.match(runtime, /new ApprovalController\(\{[\s\S]*manager,/);
    assert.match(runtime, /new ApprovalWorkflowController\(\{[\s\S]*manager,/);
    assert.match(runtime, /new ExecuteExecutor\(\{[\s\S]*manager,/);
    assert.match(runtime, /disposeAiRuntime/);
    assert.equal(runtime.includes('localStorage'), false);
    assert.equal(runtime.includes('indexedDB'), false);
  });

  it('does not add production CDP or page-script authority', () => {
    const forbidden = [
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'DOM.resolveNode',
      'Target.attachToTarget',
      'Target.setAutoAttach',
      'Target.sendMessageToTarget',
      'executeJavaScript',
    ];
    const files = collectProductionFiles([
      'src/browser',
      'src/interaction',
      'src/observation',
      'src/approval',
      'src/main',
      'src/ai',
      'src/app-ui',
    ]);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const token of forbidden) {
        assert.equal(source.includes(token), false, `${path.relative(ROOT, file)} leaked ${token}`);
      }
    }
  });
});
