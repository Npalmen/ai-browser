import type { TabId } from './browser-types';

export const AI_SIDE_PANEL_WIDTH_PX = 360;

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
  | 'INVALID_REQUEST'
  | 'AI_REQUEST_FAILED';

export interface AiSafeError {
  code: AiSafeErrorCode;
  message: string;
}

export interface AiAskCurrentPageInput {
  tabId: TabId;
  question: string;
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
    };
