import type { TabId } from './browser-types';

export const AI_SIDE_PANEL_WIDTH_PX = 360;

export type AiRequestMode = 'read' | 'interact';

export type AgentRunUiId = string;

export type AgentRunUiBlockedReason =
  | 'STEP_LIMIT_REACHED'
  | 'AGENT_LOOP_NO_PROGRESS'
  | 'POLICY_BLOCKED'
  | 'UNSUPPORTED_ACTION'
  | 'ACTION_STALE'
  | 'APPROVAL_REJECTED'
  | 'APPROVAL_EXPIRED';

export type AgentRunUiCancelledReason =
  | 'USER_CANCELLED'
  | 'SUPERSEDED'
  | 'TAB_CLOSED'
  | 'RENDERER_CRASH'
  | 'TRUSTED_CHROME_NAVIGATION';

export type AgentRunUiFailedReason = 'MODEL_FAILED' | 'ACTION_FAILED';

export type AiSafeErrorCode =
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_UNAVAILABLE'
  | 'REQUEST_CANCELLED'
  | 'CONTEXT_TOO_LARGE'
  | 'MODEL_TIMEOUT'
  | 'MODEL_RATE_LIMITED'
  | 'MODEL_AUTH_FAILED'
  | 'MODEL_OUTPUT_INVALID'
  | 'MODEL_REQUEST_FAILED'
  | 'TAB_NOT_FOUND'
  | 'PAGE_NOT_READY'
  | 'CDP_UNAVAILABLE'
  | 'PAGE_CHANGED_DURING_OBSERVATION'
  | 'OBSERVATION_IN_PROGRESS'
  | 'OBSERVATION_FAILED'
  | 'INTERACTION_DENIED'
  | 'DEFERRED_TO_EXECUTE'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_NOT_EXPORTED'
  | 'TARGET_STALE'
  | 'TARGET_NOT_INTERACTIVE'
  | 'TARGET_DISABLED'
  | 'TARGET_SENSITIVE'
  | 'UNSUPPORTED_TARGET'
  | 'UNSUPPORTED_FRAME'
  | 'PAGE_CHANGED'
  | 'INTERACTION_IN_PROGRESS'
  | 'INTERACTION_TIMEOUT'
  | 'INTERACTION_FAILED'
  | 'INVALID_REQUEST'
  | 'AI_REQUEST_FAILED';

export interface AiSafeError {
  code: AiSafeErrorCode;
  message: string;
}

export interface AiAskCurrentPageInput {
  tabId: TabId;
  question: string;
  mode: AiRequestMode;
}

export interface AiCancelAskInput {
  tabId: TabId;
  askId: string;
}

export type AiAskStartResult =
  | {
      ok: true;
      askId: string;
    }
  | {
      ok: false;
      error: AiSafeError;
    };

export interface AiCancelAskResult {
  cancelled: boolean;
}

export type AiClearConversationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: AiSafeError;
    };

export type AiSetPanelOpenResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: AiSafeError;
    };

export type AiAnswerEvent =
  | {
      type: 'answer-started';
      askId: string;
      tabId: TabId;
    }
  | {
      type: 'answer-text';
      askId: string;
      tabId: TabId;
      delta: string;
    }
  | {
      type: 'answer-finished';
      askId: string;
      tabId: TabId;
      answer: {
        text: string;
        truncatedContext: boolean;
      };
    }
  | {
      type: 'answer-cancelled';
      askId: string;
      tabId: TabId;
    }
  | {
      type: 'answer-error';
      askId: string;
      tabId: TabId;
      error: AiSafeError;
    }
  | {
      type: 'conversation-cleared';
      tabId: TabId;
      reason: 'user' | 'tab-close';
    }
  | {
      type: 'interaction-started';
      askId: string;
      tabId: TabId;
    }
  | {
      type: 'interaction-completed';
      askId: string;
      tabId: TabId;
      truncatedContext: boolean;
    }
  | {
      type: 'interaction-denied';
      askId: string;
      tabId: TabId;
      error: AiSafeError;
      truncatedContext: boolean;
    }
  | {
      type: 'interaction-failed';
      askId: string;
      tabId: TabId;
      error: AiSafeError;
      truncatedContext: boolean;
    }
  | {
      type: 'interaction-approval-required';
      askId: string;
      tabId: TabId;
      truncatedContext: boolean;
    }
  | {
      type: 'agent-run-started';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
      modelStepCount: number;
      actionAttemptCount: number;
      approvalCount: number;
    }
  | {
      type: 'agent-run-progress';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
      modelStepCount: number;
      actionAttemptCount: number;
      approvalCount: number;
    }
  | {
      type: 'agent-run-awaiting-approval';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
      modelStepCount: number;
      actionAttemptCount: number;
      approvalCount: number;
    }
  | {
      type: 'agent-run-completed';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
      answer: {
        text: string;
        truncatedContext: boolean;
      };
    }
  | {
      type: 'agent-run-detached';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
    }
  | {
      type: 'agent-run-cancelled';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
      reason: AgentRunUiCancelledReason;
    }
  | {
      type: 'agent-run-blocked';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
      reason: AgentRunUiBlockedReason;
    }
  | {
      type: 'agent-run-failed';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
      reason: AgentRunUiFailedReason;
      /** Trusted-main sanitized copy when a specific model failure category is known. */
      safeMessage?: string;
    }
  | {
      type: 'agent-run-execution-state-unknown';
      askId: string;
      runId: AgentRunUiId;
      tabId: TabId;
    };
