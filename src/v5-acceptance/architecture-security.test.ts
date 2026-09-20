import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseAgentModelOutput } from '../ai/interaction-output-schema';
import { ModelError } from '../ai/model-errors';
import {
  MAX_AGENT_LOOP_ACTION_ATTEMPTS,
  MAX_AGENT_LOOP_APPROVALS,
  MAX_AGENT_LOOP_MODEL_STEPS,
  MAX_AGENT_LOOP_SEMANTIC_ACTIONS,
} from '../agent-run/agent-run-types';
import { TRUSTED_RUN_PROGRESS_OPEN } from '../ai/trusted-run-progress';
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
    normalized.includes('/v5-acceptance/') ||
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

describe('V5 architecture and security gates', () => {
  it('locks exact conservative loop budgets', () => {
    assert.equal(MAX_AGENT_LOOP_SEMANTIC_ACTIONS, 6);
    assert.equal(MAX_AGENT_LOOP_ACTION_ATTEMPTS, 10);
    assert.equal(MAX_AGENT_LOOP_MODEL_STEPS, 12);
    assert.equal(MAX_AGENT_LOOP_APPROVALS, 2);
  });

  it('rejects malicious model authority fields as MODEL_OUTPUT_INVALID', () => {
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

  it('keeps model contracts free of grant and approval authority fields', () => {
    for (const relative of [
      'src/ai/interaction-output-schema.ts',
      'src/ai/interaction-context-builder.ts',
      'src/ai/trusted-run-progress.ts',
    ]) {
      const source = readSrc(relative);
      for (const token of [
        'ExecuteGrant',
        'InteractionGrant',
        'claimExecuteGrant',
        'executionId',
        'runId',
        'approvalId',
      ]) {
        assert.equal(source.includes(token), false, `${relative} leaked ${token}`);
      }
    }
  });

  it('keeps V4 authority types free of runId correlation', () => {
    const approvalTypes = readSrc('src/shared/approval-types.ts');
    const prepared = approvalTypes.slice(
      approvalTypes.indexOf('export interface PreparedAction'),
      approvalTypes.indexOf('export interface ApprovalDecision'),
    );
    const grant = approvalTypes.slice(
      approvalTypes.indexOf('export interface ExecuteGrant'),
      approvalTypes.indexOf('export type ExecuteResult'),
    );
    for (const block of [prepared, grant]) {
      for (const token of ['runId', 'generation', 'AgentRunRef']) {
        assert.equal(block.includes(token), false, token);
      }
    }
  });

  it('exposes only approval:decide and approval:event channels', () => {
    assert.deepEqual(Object.keys(APPROVAL_IPC_CHANNELS), ['decide', 'event']);
    const ipc = readSrc('src/main/ipc.ts');
    for (const forbidden of [
      'agent:execute',
      'agent:resume',
      'agent:click',
      'run:execute',
      'run:resume',
      'ai:execute',
      'approval:execute',
    ]) {
      assert.equal(ipc.includes(forbidden), false, forbidden);
    }
  });

  it('keeps askCurrentPage input free of target and proposal authority', () => {
    const guards = readSrc('src/main/ai-ipc-guards.ts');
    assert.match(guards, /tabId/);
    assert.match(guards, /question/);
    assert.match(guards, /mode/);
    assert.equal(guards.includes('targetId'), false);
    assert.equal(guards.includes('proposal'), false);
    assert.equal(guards.includes('runId'), false);
  });

  it('serializes agent-run events without authority handles', () => {
    const aiTypes = readSrc('src/shared/ai-types.ts');
    const block = aiTypes.slice(
      aiTypes.indexOf("type: 'agent-run-started'"),
      aiTypes.indexOf("type: 'agent-run-execution-state-unknown'") + 260,
    );
    for (const token of [
      'targetId',
      'observationId',
      'documentRevision',
      'approvalId',
      'preparedActionId',
      'executionId',
      'InteractionGrant',
      'ExecuteGrant',
      'backendNodeId',
      'frameId',
      'proposal',
    ]) {
      assert.equal(block.includes(token), false, token);
    }
    assert.match(block, /askId/);
    assert.match(block, /runId/);
    assert.match(block, /tabId/);
  });

  it('production Act uses AgentRunController and not InteractiveAgent.interact', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    assert.match(runtime, /new AgentRunController\(/);
    assert.match(runtime, /new SafeAgentLoop\(/);
    assert.match(runtime, /new InteractiveStepAgent\(/);
    assert.match(runtime, /interactionExecutor,/);
    assert.equal(runtime.includes('new InteractiveAgent('), false);
    assert.equal(runtime.includes('InteractiveAgent.interact'), false);
    assert.equal(runtime.split('new AgentRunCoordinator(').length - 1, 1);
    assert.equal(runtime.split('new ApprovalManager(').length - 1, 1);
  });

  it('isolates SafeAgentLoop and AgentRunController from browser and grant authority', () => {
    const loop = readSrc('src/agent-run/safe-agent-loop.ts');
    const controller = readSrc('src/main/agent-run-controller.ts');
    for (const source of [loop, controller]) {
      for (const token of [
        'BrowserAdapter',
        'ExecuteExecutor',
        'claimExecuteGrant',
        'Electron',
        'ipcMain',
        'React',
      ]) {
        assert.equal(source.includes(token), false, token);
      }
    }
  });

  it('keeps trusted progress summaries free of authority canaries', () => {
    const progress = readSrc('src/ai/trusted-run-progress.ts');
    assert.match(progress, new RegExp(TRUSTED_RUN_PROGRESS_OPEN));
    for (const token of [
      'targetId',
      'optionTargetId',
      'documentRevision',
      'approvalId',
      'executionId',
      'runId',
      'backendNodeId',
      'frameId',
    ]) {
      assert.equal(progress.includes(token), false, token);
    }
  });

  it('does not add production CDP or page-script authority', () => {
    const forbidden = [
      'Runtime.evaluate',
      'Runtime.callFunctionOn',
      'DOM.resolveNode',
      'Target.attachToTarget',
      'executeJavaScript',
    ];
    const files = collectProductionFiles([
      'src/browser',
      'src/interaction',
      'src/observation',
      'src/approval',
      'src/agent-run',
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

  it('does not add AgentRun persistence or background autonomy', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    const controller = readSrc('src/main/agent-run-controller.ts');
    for (const source of [runtime, controller]) {
      assert.equal(source.includes('localStorage'), false);
      assert.equal(source.includes('indexedDB'), false);
      assert.equal(source.includes('setInterval'), false);
    }
  });

  it('exposes only ask, cancel, clear, panel, and answerEvent AI IPC channels', () => {
    assert.deepEqual(Object.keys(AI_IPC_CHANNELS), [
      'askCurrentPage',
      'cancelAsk',
      'clearConversation',
      'setPanelOpen',
      'answerEvent',
    ]);
  });
});
