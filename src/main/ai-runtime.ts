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
import type {
  AutonomousTaskAgentRunExecutionPort,
  AutonomousTaskAgentRunExecutionStartResult,
} from '../autonomous-task/agent-run-execution-port';
import { AutonomousTaskChildRunExecutor } from '../autonomous-task/autonomous-task-child-run-executor';
import { AutonomousTaskCoordinator } from '../autonomous-task/autonomous-task-coordinator';
import { AutonomousTaskPlanner } from '../autonomous-task/autonomous-task-planner';
import { AutonomousTaskPlannerExecutor } from '../autonomous-task/autonomous-task-planner-executor';
import { TaskTabStateRegistry } from '../autonomous-task/task-tab-state-registry';
import { ElectronBrowserAdapter } from '../browser/electron-adapter';
import type { BrowserTabCreatedEvent } from '../browser/tab-creation';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
import { AI_SIDE_PANEL_WIDTH_PX, type AiAnswerEvent } from '../shared/ai-types';
import type { AutonomousTaskEvent } from '../shared/autonomous-task-types';
import type { ApprovalEvent } from '../shared/approval-types';
import type { TabId } from '../shared/browser-types';
import { AI_IPC_CHANNELS, APPROVAL_IPC_CHANNELS, AUTONOMOUS_TASK_IPC_CHANNELS } from '../shared/ipc-contract';
import { ApprovalController } from './approval-controller';
import { ApprovalLifecycle } from './approval-lifecycle';
import { ApprovalWorkflowController } from './approval-workflow-controller';
import { AgentRunApprovalBridge } from './agent-run-approval-bridge';
import { AgentRunController } from './agent-run-controller';
import { AgentRunExecutor } from './agent-run-executor';
import { CompositeAgentRunApprovalOutcomePort } from './agent-run-approval-outcome-composite';
import { AiRequestController } from './ai-request-controller';
import { AutonomousTaskApprovalIntegration } from './autonomous-task-approval-integration';
import { AutonomousTaskApprovalPortProxy } from './autonomous-task-approval-port-proxy';
import { AutonomousTaskController } from './autonomous-task-controller';
import { AutonomousTaskLifecycleController } from './autonomous-task-lifecycle-controller';
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
let agentRunExecutor: AgentRunExecutor | null = null;
let adapter: ElectronBrowserAdapter | null = null;
let approvalRuntime: ApprovalRuntime | null = null;
let autonomousTaskController: AutonomousTaskController | null = null;
let autonomousTaskCoordinator: AutonomousTaskCoordinator | null = null;
let autonomousTaskApprovalIntegration: AutonomousTaskApprovalIntegration | null = null;
let autonomousTaskEventListeners = new Set<(event: AutonomousTaskEvent) => void>();

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

export function getAutonomousTaskController(): AutonomousTaskController | null {
  return autonomousTaskController;
}

export function subscribeAutonomousTaskEvents(
  listener: (event: AutonomousTaskEvent) => void,
): () => void {
  autonomousTaskEventListeners.add(listener);
  return () => {
    autonomousTaskEventListeners.delete(listener);
  };
}

export function invalidateApprovalTab(tabId: TabId): void {
  approvalRuntime?.lifecycle.invalidateTab(tabId);
}

export function cancelAgentRunForTrustedChromeNavigation(tabId: TabId): void {
  agentRunController?.cancelForTrustedChromeNavigation(tabId);
}

export function handleAutonomousTaskTabCreated(event: BrowserTabCreatedEvent): void {
  void autonomousTaskController?.handleTabCreated(event)?.catch(() => {
    // Lifecycle bookkeeping failure must not grant authority.
  });
}

export function handleAutonomousTaskGenericNavigation(tabId: TabId): void {
  autonomousTaskController?.handleGenericNavigation(tabId);
}

export async function beforeAutonomousTaskTrustedChromeNavigation(tabId: TabId): Promise<void> {
  await autonomousTaskController?.beforeTrustedChromeNavigation(tabId);
}

export async function handleAutonomousTaskTabClosed(tabId: TabId): Promise<void> {
  await autonomousTaskController?.handleTabClosed(tabId);
}

export function handleAutonomousTaskRendererCrash(tabId: TabId): void {
  void autonomousTaskController?.handleRendererCrash(tabId)?.catch(() => {
    // Lifecycle bookkeeping failure must not grant authority.
  });
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
  const taskApprovalProxy = new AutonomousTaskApprovalPortProxy();
  const approvalOutcome = new CompositeAgentRunApprovalOutcomePort({
    task: taskApprovalProxy,
    agentRun: agentRunCoordinator,
  });
  const lifecycle = new ApprovalLifecycle({
    manager,
    auditRecorder: recorder,
    emit: emitApprovalEvent,
    notifyAgentRunOutcome: (approvalId, outcome) => {
      approvalOutcome.notifyApprovalOutcome(approvalId, outcome);
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
    agentRun: approvalOutcome,
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
    taskApproval: taskApprovalProxy,
  });
  const loop = new SafeAgentLoop({
    coordinator: agentRunCoordinator,
    stepAgent,
    interactionExecutor,
    approvalPort: approvalBridge,
  });
  agentRunExecutor = new AgentRunExecutor({
    coordinator: agentRunCoordinator,
    loop,
    manager,
    lifecycle,
  });

  let autonomousTaskLifecycle: AutonomousTaskLifecycleController | null = null;
  agentRunController = new AgentRunController({
    executor: agentRunExecutor,
    conversationStore: new ConversationStore(),
    emit: emitAiAnswerEvent,
    canStartManualAct: (tabId) => autonomousTaskLifecycle?.canStartManualAct(tabId) !== false,
  });
  controller = new AiRequestController({
    readAgent,
    agentRuns: agentRunController,
    emit: emitAiAnswerEvent,
  });

  const taskCoordinator = new AutonomousTaskCoordinator();
  const tabState = new TaskTabStateRegistry();
  const taskPlanner = new AutonomousTaskPlanner({
    coordinator: taskCoordinator,
    runtime: gatewayRuntime,
  });
  const plannerExecutor = new AutonomousTaskPlannerExecutor({ planner: taskPlanner });
  const childRuns = new AutonomousTaskChildRunExecutor({
    coordinator: taskCoordinator,
    agentRuns: asChildAgentRunPort(agentRunExecutor),
    tabState,
  });
  const taskApprovalIntegration = new AutonomousTaskApprovalIntegration({
    coordinator: taskCoordinator,
    childRuns,
    tabState,
    onTaskChanged: (taskId) => {
      autonomousTaskController?.handleTaskChanged(taskId);
    },
  });
  taskApprovalProxy.bind(taskApprovalIntegration);
  autonomousTaskLifecycle = new AutonomousTaskLifecycleController({
    coordinator: taskCoordinator,
    tabState,
    planner: plannerExecutor,
    childRuns,
    browser: browserAdapter,
    manualRuns: {
      isActive: (tabId) => agentRunController?.isActive(tabId) === true,
    },
  });
  autonomousTaskController = new AutonomousTaskController({
    coordinator: taskCoordinator,
    lifecycle: autonomousTaskLifecycle,
    planner: plannerExecutor,
    childRuns,
    emit: emitAutonomousTaskEvent,
  });
  autonomousTaskCoordinator = taskCoordinator;
  autonomousTaskApprovalIntegration = taskApprovalIntegration;

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
  autonomousTaskController?.dispose();
  autonomousTaskApprovalIntegration?.dispose();
  autonomousTaskCoordinator?.dispose();
  controller?.dispose();
  agentRunExecutor?.dispose();
  controller = null;
  agentRunController = null;
  agentRunExecutor = null;
  adapter = null;
  approvalRuntime = null;
  autonomousTaskController = null;
  autonomousTaskCoordinator = null;
  autonomousTaskApprovalIntegration = null;
  autonomousTaskEventListeners.clear();
}

function asChildAgentRunPort(executor: AgentRunExecutor): AutonomousTaskAgentRunExecutionPort {
  return {
    start: async (tabId, instruction, options) => {
      const started = await executor.start(tabId, instruction, options);
      return started as AutonomousTaskAgentRunExecutionStartResult;
    },
    cancel: (ref, reason) => executor.cancel(ref, reason),
    cancelAndWait: (ref, reason) => executor.cancelAndWait(ref, reason),
  };
}

function emitAiAnswerEvent(event: AiAnswerEvent): void {
  sendToTrustedAppRenderer(AI_IPC_CHANNELS.answerEvent, event);
}

function emitApprovalEvent(event: ApprovalEvent): void {
  sendToTrustedAppRenderer(APPROVAL_IPC_CHANNELS.event, event);
}

function emitAutonomousTaskEvent(event: AutonomousTaskEvent): void {
  sendToTrustedAppRenderer(AUTONOMOUS_TASK_IPC_CHANNELS.event, event);
  for (const listener of autonomousTaskEventListeners) {
    try {
      listener(event);
    } catch {
      // Workflow observers must not break V6 emission.
    }
  }
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
