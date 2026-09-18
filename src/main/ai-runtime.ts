import { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import { InMemoryApprovalAuditSink } from '../approval/approval-audit';
import { ApprovalManager } from '../approval/approval-manager';
import { ExecuteExecutor } from '../approval/execute-executor';
import { PrepareActionService } from '../approval/prepare-action-service';
import { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import { SafeAgentLoop } from '../agent-run/safe-agent-loop';
import { InteractiveStepAgent } from '../ai/interactive-step-agent';
import { ReadOnlyAgent } from '../ai/read-only-agent';
import { ConversationStore } from '../ai/conversation-store';
import { AiSdkGatewayRuntime } from '../ai/providers/ai-sdk-gateway';
import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
import { AI_SIDE_PANEL_WIDTH_PX, type AiAnswerEvent } from '../shared/ai-types';
import type { ApprovalEvent } from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';
import { AI_IPC_CHANNELS, APPROVAL_IPC_CHANNELS } from '../shared/ipc-contract';
import { ApprovalController } from './approval-controller';
import { ApprovalLifecycle } from './approval-lifecycle';
import { ApprovalWorkflowController } from './approval-workflow-controller';
import { AgentRunApprovalBridge } from './agent-run-approval-bridge';
import { AgentRunController } from './agent-run-controller';
import { AiRequestController } from './ai-request-controller';
import { getMainBrowserWindow } from './browser-runtime';

interface ApprovalRuntime {
  manager: ApprovalManager;
  audit: InMemoryApprovalAuditSink;
  recorder: ApprovalAuditRecorder;
  lifecycle: ApprovalLifecycle;
  controller: ApprovalController;
  workflow: ApprovalWorkflowController;
}

let controller: AiRequestController | null = null;
let agentRunController: AgentRunController | null = null;
let adapter: ElectronBrowserAdapter | null = null;
let approvalRuntime: ApprovalRuntime | null = null;

export function getAiController(): AiRequestController | null {
  return controller;
}

export function getAgentRunController(): AgentRunController | null {
  return agentRunController;
}

export function getApprovalController(): ApprovalController | null {
  return approvalRuntime?.controller ?? null;
}

export function getApprovalWorkflowController(): ApprovalWorkflowController | null {
  return approvalRuntime?.workflow ?? null;
}

export function invalidateApprovalTab(tabId: TabId): void {
  approvalRuntime?.lifecycle.invalidateTab(tabId);
}

export function cancelAgentRunForTrustedChromeNavigation(tabId: TabId): void {
  agentRunController?.cancelForTrustedChromeNavigation(tabId);
}

export function initializeAiRuntime(browserAdapter: ElectronBrowserAdapter): void {
  disposeAiRuntime();
  adapter = browserAdapter;
  const gatewayRuntime = new AiSdkGatewayRuntime();
  const observationSource = {
    observePage: (tabId: string, options?: Parameters<ElectronBrowserAdapter['observePage']>[1]) =>
      browserAdapter.observePage(tabId, options),
  };
  const readAgent = new ReadOnlyAgent({
    observationSource,
    modelRuntime: gatewayRuntime,
    allowScreenshotExport: false,
  });

  const manager = new ApprovalManager();
  const audit = new InMemoryApprovalAuditSink();
  const recorder = new ApprovalAuditRecorder({ manager, audit });
  const agentRunCoordinator = new AgentRunCoordinator();
  const lifecycle = new ApprovalLifecycle({
    manager,
    auditRecorder: recorder,
    emit: emitApprovalEvent,
    notifyAgentRunOutcome: (approvalId, outcome) => {
      agentRunCoordinator.notifyApprovalOutcome(approvalId, outcome);
    },
  });
  const prepareActionService = new PrepareActionService({ manager, audit });
  const interactionExecutor = new InteractionExecutor({
    adapter: browserAdapter,
    targetRegistry: browserAdapter.getInteractionTargetRegistry(),
    audit: new InMemoryInteractionAuditSink(),
  });
  const executeExecutor = new ExecuteExecutor({
    adapter: browserAdapter,
    targetRegistry: browserAdapter.getInteractionTargetRegistry(),
    manager,
    auditRecorder: recorder,
  });
  const decisionController = new ApprovalController({
    manager,
    auditRecorder: recorder,
    emit: emitApprovalEvent,
  });
  const workflow = new ApprovalWorkflowController({
    decisionController,
    manager,
    executeExecutor,
    auditRecorder: recorder,
    emit: emitApprovalEvent,
    agentRun: agentRunCoordinator,
  });
  const stepAgent = new InteractiveStepAgent({
    observationSource,
    modelRuntime: gatewayRuntime,
    allowScreenshotExport: false,
  });
  const approvalBridge = new AgentRunApprovalBridge({
    coordinator: agentRunCoordinator,
    prepareActionService,
    lifecycle,
    manager,
    auditRecorder: recorder,
    emit: emitApprovalEvent,
  });
  const loop = new SafeAgentLoop({
    coordinator: agentRunCoordinator,
    stepAgent,
    interactionExecutor,
    approvalPort: approvalBridge,
  });
  agentRunController = new AgentRunController({
    coordinator: agentRunCoordinator,
    loop,
    conversationStore: new ConversationStore(),
    manager,
    lifecycle,
    emit: emitAiAnswerEvent,
  });
  controller = new AiRequestController({
    readAgent,
    agentRuns: agentRunController,
    emit: emitAiAnswerEvent,
  });

  approvalRuntime = {
    manager,
    audit,
    recorder,
    lifecycle,
    controller: decisionController,
    workflow,
  };
}

export function setAiPanelOpen(open: boolean): void {
  if (!adapter) {
    throw new Error('AI runtime not initialized');
  }
  adapter.setWebsiteRightInset(open ? AI_SIDE_PANEL_WIDTH_PX : 0);
}

export function disposeAiRuntime(): void {
  controller?.dispose();
  controller = null;
  agentRunController = null;
  adapter = null;
  approvalRuntime = null;
}

function emitAiAnswerEvent(event: AiAnswerEvent): void {
  sendToTrustedAppRenderer(AI_IPC_CHANNELS.answerEvent, event);
}

function emitApprovalEvent(event: ApprovalEvent): void {
  sendToTrustedAppRenderer(APPROVAL_IPC_CHANNELS.event, event);
}

function sendToTrustedAppRenderer(channel: string, payload: unknown): void {
  const window = getMainBrowserWindow();
  if (!window || window.isDestroyed()) {
    return;
  }
  const webContents = window.webContents;
  if (webContents.isDestroyed()) {
    return;
  }
  webContents.send(channel, payload);
}
