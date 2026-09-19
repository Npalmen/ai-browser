import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { TargetRegistry } from '../observation/target-registry';
import { parseAutonomousTaskStartRequest, parseAutonomousTaskIdRequest, parseAutonomousTaskReplyRequest } from '../main/autonomous-task-ipc-guards';
import { AUTONOMOUS_TASK_IPC_CHANNELS } from '../shared/ipc-contract';
import {
  answerRuntime,
  collectKeys,
  complete,
  createV6FakeAdapter,
  createV6ProductChain,
  namedButtonPage,
  seedRegistry,
  waitUntil,
} from './chain-helpers';
import { V6_TAB_A, V6_TASK_ID } from './fixture-constants';
import { RecordingPlannerRuntime } from './recording-planner-runtime';

const ROOT = path.resolve(__dirname, '..', '..');
const FORBIDDEN_RENDERER_KEYS = [
  'generation',
  'runId',
  'AgentRunRef',
  'approvalId',
  'preparedActionId',
  'executionId',
  'targetId',
  'observationId',
  'documentRevision',
  'backendDOMNodeId',
  'frameId',
  'InteractionGrant',
  'ExecuteGrant',
];

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('V6 product security acceptance', () => {
  it('keeps renderer events free of authority handles and raw planner instruction', async () => {
    const page = namedButtonPage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime([complete('Renderer-safe answer.')]),
      childRuntime: answerRuntime('unused'),
      observation: page,
      browserState,
    });
    chain.controller.start('Keep events safe');
    await waitUntil(() => chain.coordinator.getTask(V6_TASK_ID)?.state === 'completed');
    assert.ok(chain.taskEvents.length > 0);
    for (const event of chain.taskEvents) {
      const keys = collectKeys(event);
      for (const forbidden of FORBIDDEN_RENDERER_KEYS) {
        assert.equal(keys.has(forbidden), false, forbidden);
      }
      assert.ok(keys.has('taskId'));
      assert.equal(JSON.stringify(event).includes('delegate-subgoal'), false);
    }
    const view = chain.controller.getState()[0];
    assert.ok(view);
    assert.ok(Array.isArray(view.ownedTabIds));
    chain.dispose();
  });

  it('Ask still uses ReadOnlyAgent without creating an AgentRun or AutonomousTask', async () => {
    const page = namedButtonPage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime(),
      childRuntime: answerRuntime('Read-only answer.'),
      observation: page,
      browserState,
    });
    const started = chain.aiController.startAsk(V6_TAB_A, 'What is this page?', 'read');
    assert.equal(started.ok, true);
    await waitUntil(() =>
      chain.aiEvents.some((event) => event.type === 'answer-finished' || event.type === 'answer-error'),
    );
    assert.equal(chain.coordinator.getActiveTask(), undefined);
    assert.equal(chain.concurrent.runIds.length, 0);
    assert.equal(chain.plannerRuntime.requests.length, 0);
    chain.dispose();
  });

  it('Act still uses AgentRunController without creating an AutonomousTask', async () => {
    const page = namedButtonPage('Safe control A', 'target-a');
    const registry = new TargetRegistry();
    seedRegistry(registry, page);
    const { adapter, browserState } = createV6FakeAdapter({ observePage: async () => page });
    const chain = createV6ProductChain({
      adapter,
      targetRegistry: registry,
      plannerRuntime: new RecordingPlannerRuntime(),
      childRuntime: answerRuntime('Act answer.'),
      observation: page,
      browserState,
    });
    const started = chain.aiController.startAsk(V6_TAB_A, 'Summarize then stop', 'interact');
    assert.equal(started.ok, true);
    await waitUntil(() => chain.aiEvents.some((event) => event.type === 'agent-run-completed'));
    assert.equal(chain.coordinator.getActiveTask(), undefined);
    assert.equal(chain.conversationStore.get(V6_TAB_A)?.turns.length, 1);
    chain.dispose();
  });

  it('validates AutonomousTask IPC payloads and rejects authority fields', () => {
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'Compare fares' }).ok, true);
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'x', generation: 1 }).ok, false);
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'x', approvalId: 'a' }).ok, false);
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'x', targetId: 't' }).ok, false);
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'x', approved: true }).ok, false);
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'x', plannerLimit: 99 }).ok, false);
    assert.equal(parseAutonomousTaskIdRequest({ taskId: V6_TASK_ID }).ok, true);
    assert.equal(parseAutonomousTaskIdRequest({ taskId: V6_TASK_ID, generation: 2 }).ok, false);
    assert.equal(parseAutonomousTaskReplyRequest({ taskId: V6_TASK_ID, reply: 'economy' }).ok, true);
    assert.equal(
      parseAutonomousTaskReplyRequest({ taskId: V6_TASK_ID, reply: 'yes', approved: true }).ok,
      false,
    );
    const ipc = readSrc('src/main/ipc.ts');
    assert.match(ipc, /assertTrustedAppSender/);
    for (const channel of Object.values(AUTONOMOUS_TASK_IPC_CHANNELS)) {
      if (channel.endsWith(':event')) {
        continue;
      }
      const index = ipc.indexOf(`ipcMain.handle(${channel.includes('start') ? 'AUTONOMOUS_TASK_IPC_CHANNELS.start' : 'AUTONOMOUS_TASK_IPC_CHANNELS'}`);
      void index;
    }
    assert.match(ipc, /assertTrustedAppSender\(event\);/);
    assert.match(ipc, /parseAutonomousTaskStartRequest/);
    assert.match(ipc, /parseAutonomousTaskIdRequest/);
    assert.match(ipc, /parseAutonomousTaskReplyRequest/);
  });

  it('keeps Ask, Act, and Delegate product modes with a single ApprovalCard', () => {
    const panel = readSrc('src/app-ui/AiSidePanel.tsx');
    assert.match(panel, />\s*Ask\s*</);
    assert.match(panel, />\s*Act\s*</);
    assert.match(panel, />\s*Delegate\s*</);
    assert.match(panel, /<ApprovalCard/);
    assert.equal((panel.match(/<ApprovalCard/g) ?? []).length, 1);
    assert.match(panel, /props\.onDelegate\(\)/);
    assert.match(panel, /props\.onAsk\(\)/);
    const enterBlock = panel.slice(panel.indexOf('handleKeyDown'), panel.indexOf('return ('));
    assert.equal(enterBlock.includes('decideApproval'), false);
    assert.equal(enterBlock.includes('onApprove'), false);

    const app = readSrc('src/app-ui/App.tsx');
    assert.match(app, /startAutonomousTask\(\{ objective \}\)/);
    assert.match(app, /askCurrentPage\(\{ tabId, question, mode \}\)/);
    const closeBlock = app.slice(app.indexOf('handleClosePanel'), app.indexOf('updateActiveTabAi'));
    assert.equal(closeBlock.includes('pauseAutonomousTask'), false);
    assert.equal(closeBlock.includes('stopAutonomousTask'), false);
    const clearBlock = app.slice(app.indexOf('handleClear'), app.indexOf('handleDelegate'));
    assert.equal(clearBlock.includes('stopAutonomousTask'), false);
    assert.match(app, /tab-task-owned/);
    assert.match(app, /ai-toggle-badge/);

    const card = readSrc('src/app-ui/AutonomousTaskCard.tsx');
    assert.equal(card.includes('Retry'), false);
    assert.match(card, /AUTONOMOUS_TASK_EXECUTION_UNKNOWN_COPY/);
  });
});
