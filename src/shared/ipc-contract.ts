import type {
  AiAnswerEvent,
  AiAskCurrentPageInput,
  AiAskStartResult,
  AiCancelAskInput,
  AiCancelAskResult,
  AiClearConversationResult,
  AiSetPanelOpenResult,
} from './ai-types';
import type {
  AutonomousTaskControlResult,
  AutonomousTaskEvent,
  AutonomousTaskGetStateResult,
  AutonomousTaskIdInput,
  AutonomousTaskReplyInput,
  AutonomousTaskStartInput,
  AutonomousTaskStartResult,
} from './autonomous-task-types';
import type {
  ApprovalDecideInput,
  ApprovalDecideResult,
  ApprovalEvent,
} from './approval-types';
import type { BrowserState, TabId } from './browser-types';
export type { WorkflowsApi } from './workflow-product-types';

export const BROWSER_IPC_CHANNELS = {
  getState: 'browser:get-state',
  createTab: 'browser:create-tab',
  closeTab: 'browser:close-tab',
  activateTab: 'browser:activate-tab',
  navigate: 'browser:navigate',
  back: 'browser:back',
  forward: 'browser:forward',
  reload: 'browser:reload',
  stateChanged: 'browser:state-changed',
} as const;

export const AI_IPC_CHANNELS = {
  askCurrentPage: 'ai:ask-current-page',
  cancelAsk: 'ai:cancel-ask',
  clearConversation: 'ai:clear-conversation',
  setPanelOpen: 'ai:set-panel-open',
  answerEvent: 'ai:answer-event',
} as const;

export const APPROVAL_IPC_CHANNELS = {
  decide: 'approval:decide',
  event: 'approval:event',
} as const;

export const AUTONOMOUS_TASK_IPC_CHANNELS = {
  start: 'autonomous-task:start',
  pause: 'autonomous-task:pause',
  resume: 'autonomous-task:resume',
  stop: 'autonomous-task:stop',
  reply: 'autonomous-task:reply',
  getState: 'autonomous-task:get-state',
  event: 'autonomous-task:event',
} as const;

export interface BrowserShellApi {
  getBrowserState(): Promise<BrowserState>;

  createTab(): Promise<TabId>;
  closeTab(tabId: TabId): Promise<void>;
  activateTab(tabId: TabId): Promise<void>;

  navigate(tabId: TabId, url: string): Promise<void>;
  back(tabId: TabId): Promise<void>;
  forward(tabId: TabId): Promise<void>;
  reload(tabId: TabId): Promise<void>;

  onStateChanged(listener: (state: BrowserState) => void): () => void;
}

export const WORKFLOW_IPC_CHANNELS = {
  getState: 'workflow:get-state',
  getDetail: 'workflow:get-detail',
  create: 'workflow:create',
  edit: 'workflow:edit',
  setEnabled: 'workflow:set-enabled',
  runNow: 'workflow:run-now',
  acknowledgeReview: 'workflow:acknowledge-review',
  stop: 'workflow:stop',
  cancelQueued: 'workflow:cancel-queued',
  delete: 'workflow:delete',
  stateChanged: 'workflow:state-changed',
} as const;

export interface AiAssistantApi {
  askCurrentPage(input: AiAskCurrentPageInput): Promise<AiAskStartResult>;
  cancelAsk(input: AiCancelAskInput): Promise<AiCancelAskResult>;
  clearConversation(tabId: TabId): Promise<AiClearConversationResult>;
  setPanelOpen(open: boolean): Promise<AiSetPanelOpenResult>;
  onAnswerEvent(listener: (event: AiAnswerEvent) => void): () => void;
  decideApproval(input: ApprovalDecideInput): Promise<ApprovalDecideResult>;
  onApprovalEvent(listener: (event: ApprovalEvent) => void): () => void;
  startAutonomousTask(input: AutonomousTaskStartInput): Promise<AutonomousTaskStartResult>;
  pauseAutonomousTask(input: AutonomousTaskIdInput): Promise<AutonomousTaskControlResult>;
  resumeAutonomousTask(input: AutonomousTaskIdInput): Promise<AutonomousTaskControlResult>;
  stopAutonomousTask(input: AutonomousTaskIdInput): Promise<AutonomousTaskControlResult>;
  replyToAutonomousTask(input: AutonomousTaskReplyInput): Promise<AutonomousTaskControlResult>;
  getAutonomousTaskState(): Promise<AutonomousTaskGetStateResult>;
  onAutonomousTaskEvent(listener: (event: AutonomousTaskEvent) => void): () => void;
}
