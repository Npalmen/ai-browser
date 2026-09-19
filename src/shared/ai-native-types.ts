import type { BrowserState, TabId } from './browser-types';
import type { WorkflowProductTrigger } from './workflow-product-types';

export const MAX_BROWSER_INTENT_TEXT_CHARS = 4_000;
export const MAX_SEARCH_QUERY_CHARS = 512;
export const MAX_CONTEXT_TABS = 5;

export type BrowserIntentCapability =
  | 'default'
  | 'search'
  | 'ask'
  | 'act'
  | 'delegate'
  | 'automate';

export type BrowserContextScope =
  | {
      readonly kind: 'current-tab';
      readonly tabId: TabId;
    }
  | {
      readonly kind: 'selected-tabs';
      readonly tabIds: readonly TabId[];
    };

export type BrowserIntent =
  | {
      readonly kind: 'navigate';
      readonly text: string;
    }
  | {
      readonly kind: 'search';
      readonly query: string;
    }
  | {
      readonly kind: 'ask';
      readonly question: string;
      readonly context: BrowserContextScope;
    }
  | {
      readonly kind: 'act';
      readonly instruction: string;
    }
  | {
      readonly kind: 'delegate';
      readonly objective: string;
    }
  | {
      readonly kind: 'draft-workflow';
      readonly instruction: string;
      readonly context: BrowserContextScope;
    };

export type BrowserIntentRoute =
  | {
      readonly kind: 'navigate';
      readonly url: string;
    }
  | {
      readonly kind: 'search';
      readonly query: string;
    }
  | {
      readonly kind: 'ask';
      readonly question: string;
      readonly context: BrowserContextScope;
    }
  | {
      readonly kind: 'act';
      readonly instruction: string;
      readonly tabId: TabId;
    }
  | {
      readonly kind: 'delegate';
      readonly objective: string;
    }
  | {
      readonly kind: 'draft-workflow';
      readonly instruction: string;
      readonly context: BrowserContextScope;
    };

export type AiNativeSafeErrorCode =
  | 'AI_NATIVE_INVALID_REQUEST'
  | 'AI_NATIVE_EMPTY_INPUT'
  | 'AI_NATIVE_TAB_UNAVAILABLE'
  | 'AI_NATIVE_CONTEXT_INVALID'
  | 'AI_NATIVE_SEARCH_INVALID'
  | 'AI_NATIVE_NOT_AVAILABLE'
  | 'AI_NATIVE_CONTEXT_TOO_LARGE'
  | 'AI_NATIVE_CONTEXT_UNAVAILABLE'
  | 'AI_NATIVE_REQUEST_CANCELLED'
  | 'AI_NATIVE_MODEL_FAILED'
  | 'AI_NATIVE_DRAFT_INVALID'
  | 'AI_NATIVE_DRAFT_FAILED';

export interface AiNativeSafeError {
  readonly code: AiNativeSafeErrorCode;
  readonly message: string;
}

export type BrowserIntentRouteResult =
  | {
      readonly ok: true;
      readonly route: BrowserIntentRoute;
    }
  | {
      readonly ok: false;
      readonly error: AiNativeSafeError;
    };

export type BrowserIntentRouteInput =
  | {
      readonly text: string;
      readonly capability: 'default' | 'search' | 'act' | 'delegate';
    }
  | {
      readonly text: string;
      readonly capability: 'ask' | 'automate';
      readonly context: BrowserContextScope;
    };

export type BrowserIntentRouteRequest = {
  readonly text: string;
  readonly capability: BrowserIntentCapability;
  readonly context?: BrowserContextScope;
};

export const AI_NATIVE_IPC_CHANNELS = {
  routeIntent: 'ai-native:route-intent',
  askContext: 'ai-native:ask-context',
  cancelContextAsk: 'ai-native:cancel-context-ask',
  contextAnswerEvent: 'ai-native:context-answer-event',
  generateWorkflowDraft: 'ai-native:generate-workflow-draft',
} as const;

export interface WorkflowDraft {
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: {
    readonly kind: 'url';
    readonly url: string;
  };
  readonly trigger: WorkflowProductTrigger;
}

export interface AiNativeWorkflowDraftInput {
  readonly instruction: string;
  readonly context: BrowserContextScope;
}

export type AiNativeWorkflowDraftResult =
  | {
      readonly ok: true;
      readonly draft: WorkflowDraft;
    }
  | {
      readonly ok: false;
      readonly error: AiNativeSafeError;
    };

export interface AiNativeContextAskInput {
  readonly question: string;
  readonly context: {
    readonly kind: 'selected-tabs';
    readonly tabIds: readonly TabId[];
  };
}

export interface AiNativeContextCancelAskInput {
  readonly askId: string;
}

export type AiNativeContextAskStartResult =
  | {
      readonly ok: true;
      readonly askId: string;
    }
  | {
      readonly ok: false;
      readonly error: AiNativeSafeError;
    };

export type AiNativeContextCancelAskResult = {
  readonly cancelled: boolean;
};

export type AiNativeContextAnswerEvent =
  | {
      readonly type: 'context-answer-started';
      readonly askId: string;
    }
  | {
      readonly type: 'context-answer-text';
      readonly askId: string;
      readonly delta: string;
    }
  | {
      readonly type: 'context-answer-finished';
      readonly askId: string;
      readonly answer: {
        readonly text: string;
        readonly truncatedContext: boolean;
      };
    }
  | {
      readonly type: 'context-answer-cancelled';
      readonly askId: string;
    }
  | {
      readonly type: 'context-answer-error';
      readonly askId: string;
      readonly error: AiNativeSafeError;
    };

export interface AiNativeApi {
  routeIntent(input: BrowserIntentRouteInput): Promise<BrowserIntentRouteResult>;
  askContext(input: AiNativeContextAskInput): Promise<AiNativeContextAskStartResult>;
  cancelContextAsk(input: AiNativeContextCancelAskInput): Promise<AiNativeContextCancelAskResult>;
  onContextAnswerEvent(listener: (event: AiNativeContextAnswerEvent) => void): () => void;
  generateWorkflowDraft(input: AiNativeWorkflowDraftInput): Promise<AiNativeWorkflowDraftResult>;
}

export type BrowserIntentRouterState = {
  readonly tabs: BrowserState['tabs'];
  readonly activeTabId: TabId | null;
};
