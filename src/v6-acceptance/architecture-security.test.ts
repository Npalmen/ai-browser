import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseAutonomousTaskDecision } from '../autonomous-task/autonomous-task-decision';
import {
  MAX_AUTONOMOUS_TASK_APPROVALS,
  MAX_AUTONOMOUS_TASK_CHILD_RUNS,
  MAX_AUTONOMOUS_TASK_OWNED_TABS,
  MAX_AUTONOMOUS_TASK_PLANNER_STEPS,
} from '../autonomous-task/autonomous-task-types';
import { ModelError } from '../ai/model-errors';
import { APPROVAL_IPC_CHANNELS, AI_IPC_CHANNELS, AUTONOMOUS_TASK_IPC_CHANNELS } from '../shared/ipc-contract';

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
    normalized.includes('/v6-acceptance/') ||
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

describe('V6 architecture and security gates', () => {
  it('locks exact conservative task budgets', () => {
    assert.equal(MAX_AUTONOMOUS_TASK_PLANNER_STEPS, 8);
    assert.equal(MAX_AUTONOMOUS_TASK_CHILD_RUNS, 4);
    assert.equal(MAX_AUTONOMOUS_TASK_OWNED_TABS, 3);
    assert.equal(MAX_AUTONOMOUS_TASK_APPROVALS, 4);
  });

  it('rejects malicious planner authority fields as MODEL_OUTPUT_INVALID', () => {
    for (const field of [
      { approved: true },
      { targetId: 't' },
      { backendNodeId: 1 },
      { approvalId: 'a' },
      { executionId: 'e' },
      { grant: 'g' },
      { ExecuteGrant: {} },
    ]) {
      assert.throws(
        () =>
          parseAutonomousTaskDecision({
            kind: 'delegate-subgoal',
            taskTabAlias: 'task-tab-1',
            instruction: 'Work',
            ...field,
          }),
        (error: unknown) => error instanceof ModelError && error.code === 'MODEL_OUTPUT_INVALID',
      );
    }
  });

  it('keeps taskId off V3/V4/V5 browser authority types', () => {
    const approval = readSrc('src/shared/approval-types.ts');
    const prepared = approval.slice(
      approval.indexOf('export interface PreparedAction '),
      approval.indexOf('export interface ApprovalDecision'),
    );
    const decision = approval.slice(
      approval.indexOf('export interface ApprovalDecision'),
      approval.indexOf('export interface ExecuteGrant'),
    );
    const grant = approval.slice(
      approval.indexOf('export interface ExecuteGrant'),
      approval.indexOf('export type ExecuteResult'),
    );
    const interaction = readSrc('src/shared/interaction-types.ts');
    const interactionGrant = interaction.slice(
      interaction.indexOf('export interface InteractionGrant'),
      interaction.indexOf('export interface InteractionResult'),
    );
    const agentRun = readSrc('src/agent-run/agent-run-types.ts');
    const runRef = agentRun.slice(
      agentRun.indexOf('export interface AgentRunRef'),
      agentRun.indexOf('export interface AgentRunSnapshot'),
    );
    const click = readSrc('src/browser/interaction-adapter-types.ts');
    for (const [label, block] of [
      ['PreparedAction', prepared],
      ['ApprovalDecision', decision],
      ['ExecuteGrant', grant],
      ['InteractionGrant', interactionGrant],
      ['AgentRunRef', runRef],
      ['AdapterClickRequest', click],
    ] as const) {
      assert.equal(block.includes('taskId'), false, `${label} leaked taskId`);
    }
  });

  it('isolates the planner from browser and approval authority', () => {
    for (const relative of [
      'src/autonomous-task/autonomous-task-planner.ts',
      'src/autonomous-task/autonomous-task-planner-context.ts',
      'src/autonomous-task/autonomous-task-decision.ts',
      'src/autonomous-task/autonomous-task-planner-executor.ts',
    ]) {
      const source = readSrc(relative);
      for (const token of [
        'BrowserAdapter',
        'ApprovalManager',
        'claimExecuteGrant',
        'Electron',
        'ipcMain',
      ]) {
        assert.equal(source.includes(token), false, `${relative} leaked ${token}`);
      }
      assert.equal(source.includes("from '../browser"), false, relative);
      assert.equal(source.includes("from '../approval"), false, relative);
      assert.equal(source.includes("from '../main"), false, relative);
    }
  });

  it('keeps AutonomousTaskController free of click and approval decide', () => {
    const source = readSrc('src/main/autonomous-task-controller.ts');
    assert.equal(source.includes('.click('), false);
    assert.equal(source.includes('.type('), false);
    assert.equal(source.includes('.select('), false);
    assert.equal(source.includes('.scroll('), false);
    assert.equal(source.includes('ApprovalWorkflowController'), false);
    assert.equal(source.includes('.decide('), false);
    assert.match(source, /childRuns\.execute\(/);
  });

  it('routes child execution only through the V5 AgentRun executor port', () => {
    const child = readSrc('src/autonomous-task/autonomous-task-child-run-executor.ts');
    assert.match(child, /agentRuns\.start\(/);
    assert.equal(child.includes('BrowserAdapter'), false);
    assert.equal(child.includes('SafeAgentLoop'), false);
    assert.equal(child.includes('ConversationStore'), false);
    const runtime = readSrc('src/main/ai-runtime.ts');
    assert.match(runtime, /asChildAgentRunPort\(agentRunExecutor\)/);
    assert.equal(runtime.split('new AgentRunExecutor(').length - 1, 1);
    assert.equal(runtime.split('new AgentRunCoordinator(').length - 1, 1);
    assert.equal(runtime.split('new ApprovalManager(').length - 1, 1);
  });

  it('exposes only lifecycle AutonomousTask IPC', () => {
    assert.deepEqual(Object.keys(AUTONOMOUS_TASK_IPC_CHANNELS), [
      'start',
      'pause',
      'resume',
      'stop',
      'reply',
      'getState',
      'event',
    ]);
    const ipc = readSrc('src/main/ipc.ts');
    for (const forbidden of [
      'execute-child',
      'execute-action',
      'approve-task',
      'adopt-tab',
      'set-budget',
      'autonomous-task:execute',
      'autonomous-task:approve',
    ]) {
      assert.equal(ipc.includes(forbidden), false, forbidden);
    }
    assert.deepEqual(Object.keys(APPROVAL_IPC_CHANNELS), ['decide', 'event']);
    assert.deepEqual(Object.keys(AI_IPC_CHANNELS), [
      'askCurrentPage',
      'cancelAsk',
      'clearConversation',
      'setPanelOpen',
      'answerEvent',
    ]);
  });

  it('does not persist tasks or add schedules', () => {
    const files = collectProductionFiles(['src/autonomous-task', 'src/main']);
    for (const file of files) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      if (!relative.includes('autonomous-task') && relative !== 'src/main/ai-runtime.ts') {
        continue;
      }
      const source = readFileSync(file, 'utf8');
      for (const token of [
        'localStorage',
        'indexedDB',
        'sqlite',
        'createWriteStream',
        'cron',
        'setInterval',
        'runAt',
        'webhook',
      ]) {
        if (token === 'setInterval' && relative.endsWith('autonomous-task-controller.test.ts')) {
          continue;
        }
        assert.equal(source.includes(token), false, `${relative} leaked ${token}`);
      }
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
      'src/autonomous-task',
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

  it('keeps Ask as ReadOnlyAgent and Act as AgentRunController', () => {
    const runtime = readSrc('src/main/ai-runtime.ts');
    assert.match(runtime, /new ReadOnlyAgent\(/);
    assert.match(runtime, /new AgentRunController\(/);
    assert.match(runtime, /new AutonomousTaskController\(/);
    assert.equal(runtime.includes('new InteractiveAgent('), false);
  });
});
