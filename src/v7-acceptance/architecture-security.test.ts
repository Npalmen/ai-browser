import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { WORKFLOW_IPC_CHANNELS } from '../shared/ipc-contract';
import {
  FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES,
  WORKFLOW_DEFINITION_KEYS,
  WORKFLOW_OCCURRENCE_KEYS,
} from '../workflows/workflow-store-types';
import { parseWorkflowCreateRequest, parseWorkflowEditRequest } from '../main/workflow-ipc-guards';

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
    normalized.includes('/v7-acceptance/') ||
    normalized.endsWith('.test.ts') ||
    normalized.endsWith('.test.tsx')
  );
}

const LIVE_AUTHORITY = [
  'tabId',
  'taskId',
  'runId',
  'AgentRunRef',
  'generation',
  'targetId',
  'observationId',
  'documentRevision',
  'backendDOMNodeId',
  'frameId',
  'approvalId',
  'preparedActionId',
  'executionId',
  'InteractionGrant',
  'ExecuteGrant',
] as const;

describe('V7 architecture and security gates', () => {
  it('acquires the single-instance lock before workflow initialization and quits losers without a store', () => {
    const main = readSrc('src/main/main.ts');
    const lock = main.indexOf('app.requestSingleInstanceLock()');
    const init = main.indexOf('await initializePersistentWorkflowRuntime');
    const quit = main.indexOf('app.quit()');
    const loser = main.slice(main.indexOf('if (!isPrimaryInstance)'), main.indexOf('} else {'));
    assert.ok(lock >= 0);
    assert.ok(init > lock);
    assert.ok(quit > lock);
    assert.ok(quit < init);
    for (const banned of [
      'WorkflowStore',
      'DurableWorkflowCoordinator',
      'WorkflowScheduler',
      'WorkflowOccurrenceRunner',
      'initializePersistentWorkflowRuntime',
    ]) {
      assert.equal(loser.includes(banned), false, banned);
    }
  });

  it('does not persist live browser or approval authority on the durable schema', () => {
    for (const key of LIVE_AUTHORITY) {
      assert.equal(WORKFLOW_DEFINITION_KEYS.includes(key as never), false, `definition ${key}`);
      assert.equal(WORKFLOW_OCCURRENCE_KEYS.includes(key as never), false, `occurrence ${key}`);
    }
    for (const key of [
      'tabId',
      'taskId',
      'approvalId',
      'preparedActionId',
      'executionId',
      'InteractionGrant',
      'ExecuteGrant',
    ]) {
      assert.equal(
        (FORBIDDEN_WORKFLOW_STORE_FIELD_NAMES as readonly string[]).includes(key),
        true,
        key,
      );
    }
    const occurrence = readSrc('src/workflows/workflow-store-types.ts');
    const block = occurrence.slice(
      occurrence.indexOf('export interface WorkflowOccurrenceRecord'),
      occurrence.indexOf('export interface WorkflowStoreSnapshot'),
    );
    for (const banned of ['WebContents', 'cookie', 'password', 'otp', 'card', 'screenshot', 'coordinates']) {
      assert.equal(block.toLowerCase().includes(banned.toLowerCase()), false, banned);
    }
  });

  it('keeps workflowId and occurrenceId off V3/V4/V5/V6 authority records', () => {
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
      assert.equal(block.includes('workflowId'), false, `${label} workflowId`);
      assert.equal(block.includes('occurrenceId'), false, `${label} occurrenceId`);
    }
  });

  it('strips live authority from renderer workflow product views', () => {
    const types = readSrc('src/shared/workflow-product-types.ts');
    const summary = types.slice(
      types.indexOf('export interface WorkflowSummaryView'),
      types.indexOf('export type WorkflowOccurrenceStateView'),
    );
    const detail = types.slice(
      types.indexOf('export interface WorkflowDetailView'),
      types.indexOf('export type WorkflowGetStateResult'),
    );
    const occurrence = types.slice(
      types.indexOf('export interface WorkflowOccurrenceView'),
      types.indexOf('export interface WorkflowDetailView'),
    );
    for (const [label, block] of [
      ['summary', summary],
      ['detail', detail],
      ['occurrence', occurrence],
    ] as const) {
      for (const banned of [
        ...LIVE_AUTHORITY,
        'triggerKey',
        'ownerRuntimeSessionId',
        'runtimeSessionId',
        'frozenDefinition',
      ]) {
        assert.equal(block.includes(banned), false, `${label} ${banned}`);
      }
    }
  });

  it('keeps the scheduler queue-only and the runner free of interaction/approval primitives', () => {
    const scheduler = readSrc('src/main/workflow-scheduler.ts');
    for (const banned of [
      'WorkflowOccurrenceRunner',
      'BrowserAdapter',
      'AutonomousTaskController',
      'ApprovalManager',
      'ExecuteExecutor',
      'click(',
      'startOccurrence',
    ]) {
      assert.equal(scheduler.includes(banned), false, banned);
    }
    const runner = readSrc('src/main/workflow-occurrence-runner.ts');
    for (const banned of [
      'click(',
      'type(',
      'select(',
      'scroll(',
      'InteractionExecutor',
      'ExecuteExecutor',
      'ApprovalManager',
      'PrepareActionService',
    ]) {
      assert.equal(runner.includes(banned), false, banned);
    }
    assert.match(runner, /createTab/);
    assert.match(runner, /closeTab/);
    const runtime = readSrc('src/main/persistent-workflow-runtime.ts');
    for (const banned of ['adapter.click', 'InteractionExecutor', 'ExecuteExecutor']) {
      assert.equal(runtime.includes(banned), false, banned);
    }
  });

  it('exposes only typed workflow IPC and a fixed preload API', () => {
    const ipc = readSrc('src/main/ipc.ts');
    for (const channel of Object.values(WORKFLOW_IPC_CHANNELS)) {
      if (channel === WORKFLOW_IPC_CHANNELS.stateChanged) {
        continue;
      }
      const start = ipc.indexOf(
        Object.entries(WORKFLOW_IPC_CHANNELS).find(([, value]) => value === channel)?.[0]
          ? `WORKFLOW_IPC_CHANNELS.${Object.entries(WORKFLOW_IPC_CHANNELS).find(([, value]) => value === channel)![0]}`
          : '',
      );
      assert.ok(start >= 0, channel);
      const block = ipc.slice(start, start + 700);
      const sender = block.indexOf('assertTrustedAppSender(event)');
      assert.ok(sender >= 0, `${channel} sender`);
      assert.equal(block.includes('whenBrowserReady'), false, channel);
    }
    assert.equal(ipc.includes('setWorkflowState'), false);
    assert.equal(ipc.includes('setReviewRequired'), false);
    const preload = readSrc('src/preload/app-preload.ts');
    assert.match(preload, /exposeInMainWorld\('workflows'/);
    assert.equal(preload.includes('invoke(channel'), false);
    assert.equal(preload.includes('ipcRenderer.send'), false);
    assert.equal(preload.includes('readFile'), false);
    assert.equal(preload.includes('restore backup'), false);
    const website = readSrc('src/browser/electron-adapter.ts');
    const view = website.slice(
      website.indexOf('private createWebsiteView()'),
      website.indexOf('private createWebsiteView()') + 450,
    );
    assert.equal(view.includes('preload:'), false);
  });

  it('rejects cron, natural language, and renderer-owned review flags at the product boundary', () => {
    const valid = {
      name: 'Nightly',
      objective: 'Check invoices',
      entryPoint: { kind: 'url', url: 'https://example.test/a' },
      trigger: { kind: 'manual' as const },
    };
    assert.equal(parseWorkflowCreateRequest({ ...valid, trigger: { cron: '0 9 * * *' } }).ok, false);
    assert.equal(parseWorkflowCreateRequest({ ...valid, trigger: 'every morning' }).ok, false);
    assert.equal(parseWorkflowCreateRequest({ ...valid, workflowId: 'injected' }).ok, false);
    assert.equal(
      parseWorkflowEditRequest({
        workflowId: 'wf-1',
        name: 'Nightly',
        objective: 'Check invoices',
        entryPoint: { kind: 'url', url: 'https://example.test/a' },
        trigger: { kind: 'manual' },
        reviewRequired: false,
      }).ok,
      false,
    );
  });

  it('keeps Ask/Act/Delegate modes and has no workflow AI mode or workflow approval handlers', () => {
    const modes = readSrc('src/shared/autonomous-task-types.ts');
    assert.match(modes, /export type AiPanelMode = 'read' \| 'interact' \| 'delegate'/);
    const panel = readSrc('src/app-ui/AiSidePanel.tsx');
    assert.match(panel, /onModeChange\('read'\)/);
    assert.match(panel, /onModeChange\('interact'\)/);
    assert.match(panel, /onModeChange\('delegate'\)/);
    assert.equal(panel.includes("onModeChange('workflow')"), false);
    const app = readSrc('src/app-ui/App.tsx');
    assert.match(app, /setRightPanelSurface\('assistant'\)/);
    assert.match(app, /rightPanelSurface === 'workflows'/);
    const workflows = readSrc('src/app-ui/WorkflowsPanel.tsx');
    assert.equal(workflows.includes('decideApproval'), false);
    assert.equal(workflows.includes('onApprove'), false);
    assert.equal(workflows.includes('Approve all'), false);
    assert.equal(workflows.includes('remember approval'), false);
    assert.match(workflows, /Acknowledge and allow future runs/);
    assert.equal(workflows.includes('Retry'), false);
    assert.equal(workflows.includes('>Resume<'), false);
  });

  it('contains no V8 leakage or closed-app execution machinery in production', () => {
    const production = collectTsFiles(path.join(ROOT, 'src')).filter((file) => !isAcceptanceOrTest(file));
    const joined = production
      .filter((file) => {
        const normalized = file.split(path.sep).join('/');
        return (
          normalized.includes('/main/') ||
          normalized.includes('/workflows/') ||
          normalized.includes('/preload/')
        );
      })
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    for (const banned of [
      'public webhook',
      'cloud worker',
      'node-cron',
      'RRULE',
      'cross-device',
      'native desktop automation',
      'multi-agent parallel',
    ]) {
      assert.equal(joined.includes(banned), false, banned);
    }
    assert.equal(joined.includes('daemon'), false);
    const scheduler = readSrc('src/main/workflow-scheduler.ts');
    assert.match(scheduler, /process-local|Trusted due-time calculator/i);
  });

  it('does not add automatic browser-action retry around start or unknown failures', () => {
    const runner = readSrc('src/main/workflow-occurrence-runner.ts');
    assert.match(runner, /never browser/);
    assert.equal(runner.includes('retry click'), false);
    assert.equal(runner.includes('replay'), false);
    const runtime = readSrc('src/main/persistent-workflow-runtime.ts');
    assert.equal(runtime.includes('retry click'), false);
    assert.equal(runtime.includes('auto-resume'), false);
  });
});
