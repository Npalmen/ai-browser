import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';

export const MAX_CONTEXT_STRUCTURED_CHARS_PER_TAB = 8_000;
export const MAX_CONTEXT_STRUCTURED_CHARS_TOTAL = 24_000;

export interface BrowserContextPage {
  readonly tabId: TabId;
  readonly observation: PageObservation;
  readonly serializedContext: string;
  readonly truncated: boolean;
}

export interface BrowserContextSourceSnapshot {
  readonly tabId: TabId;
  readonly url: string;
}

export interface BrowserContextBundle {
  readonly contextId: string;
  readonly sourceSnapshot: readonly BrowserContextSourceSnapshot[];
  readonly pages: readonly BrowserContextPage[];
}

export interface SelectedTabsContext {
  readonly kind: 'selected-tabs';
  readonly tabIds: readonly TabId[];
}
