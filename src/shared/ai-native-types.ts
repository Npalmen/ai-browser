import type { BrowserState, TabId } from './browser-types';

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
  | 'AI_NATIVE_NOT_AVAILABLE';

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
} as const;

export interface AiNativeApi {
  routeIntent(input: BrowserIntentRouteInput): Promise<BrowserIntentRouteResult>;
}

export type BrowserIntentRouterState = {
  readonly tabs: BrowserState['tabs'];
  readonly activeTabId: TabId | null;
};
