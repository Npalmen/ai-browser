import {
  buildModelPageContext,
  normalizeUserQuestion,
  wrapUntrustedPageContent,
} from '../ai/context-builder';
import { decideModelExport } from '../ai/export-policy';
import { ModelError } from '../ai/model-errors';
import { READ_ONLY_SYSTEM_PROMPT } from '../ai/system-prompt';
import type { ModelExportDecision } from '../ai/export-policy';
import type { ModelMessage } from '../ai/model-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import { MAX_CONTEXT_TABS } from '../shared/ai-native-types';
import type { ObservePageOptions, PageObservation } from '../shared/observation-types';
import { ObservationError } from '../shared/observation-types';
import {
  MAX_CONTEXT_STRUCTURED_CHARS_PER_TAB,
  MAX_CONTEXT_STRUCTURED_CHARS_TOTAL,
  type BrowserContextBundle,
  type BrowserContextPage,
} from './browser-context-types';

const MAX_OBSERVATION_ATTEMPTS = 2;

export interface MultiTabObservationSource {
  observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation>;
}

function isHttpDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateSelectedTabsAgainstBrowserState(
  browserState: BrowserState,
  tabIds: readonly TabId[],
): void {
  if (tabIds.length === 0 || tabIds.length > MAX_CONTEXT_TABS) {
    throw new ObservationError('OBSERVATION_FAILED', 'Invalid selected tab count.');
  }

  const seen = new Set<TabId>();
  for (const tabId of tabIds) {
    if (seen.has(tabId)) {
      throw new ObservationError('OBSERVATION_FAILED', 'Duplicate selected tab.');
    }
    seen.add(tabId);

    const tab = browserState.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new ObservationError('TAB_NOT_FOUND', 'Selected tab was not found.');
    }
    if (tab.url === 'about:blank' || !isHttpDocumentUrl(tab.url)) {
      throw new ObservationError('OBSERVATION_FAILED', 'Selected tab URL is not available.');
    }
  }
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ModelError('REQUEST_CANCELLED', 'The request was cancelled.');
  }
}

async function observeSelectedTab(
  observationSource: MultiTabObservationSource,
  tabId: TabId,
  signal?: AbortSignal,
): Promise<PageObservation> {
  const options: ObservePageOptions = { includeScreenshot: false };
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_OBSERVATION_ATTEMPTS; attempt += 1) {
    throwIfCancelled(signal);
    try {
      const observation = await observationSource.observePage(tabId, options);
      throwIfCancelled(signal);
      if (observation.tabId !== tabId) {
        throw new ObservationError(
          'OBSERVATION_FAILED',
          'Observation tab correlation did not match the requested tab.',
        );
      }
      if (!isHttpDocumentUrl(observation.document.url)) {
        throw new ObservationError(
          'OBSERVATION_FAILED',
          'Observed document URL is not available.',
        );
      }
      return observation;
    } catch (error) {
      lastError = error;
      const retryStale =
        error instanceof ObservationError &&
        error.code === 'PAGE_CHANGED_DURING_OBSERVATION' &&
        attempt < MAX_OBSERVATION_ATTEMPTS;
      if (!retryStale) {
        throw error;
      }
    }
  }

  throw lastError;
}

export async function buildBrowserContextBundle(input: {
  tabIds: readonly TabId[];
  browserState: BrowserState;
  observationSource: MultiTabObservationSource;
  signal?: AbortSignal;
}): Promise<BrowserContextBundle> {
  validateSelectedTabsAgainstBrowserState(input.browserState, input.tabIds);

  const pages: BrowserContextPage[] = [];
  for (const tabId of input.tabIds) {
    const observation = await observeSelectedTab(input.observationSource, tabId, input.signal);
    const built = buildModelPageContext(observation, {
      maxStructuredChars: MAX_CONTEXT_STRUCTURED_CHARS_PER_TAB,
    });
    pages.push({
      tabId,
      observation,
      serializedContext: built.serialized,
      truncated: built.context.truncated,
    });
  }

  const totalChars = pages.reduce((sum, page) => sum + page.serializedContext.length, 0);
  if (totalChars > MAX_CONTEXT_STRUCTURED_CHARS_TOTAL) {
    throw new ModelError(
      'CONTEXT_TOO_LARGE',
      'The selected browser context exceeds the total structured budget.',
    );
  }

  return {
    contextId: crypto.randomUUID(),
    pages,
  };
}

export function buildMultiTabModelMessages(input: {
  question: string;
  pages: readonly { tabId: TabId; serializedContext: string }[];
  exportDecision: ModelExportDecision;
}): ModelMessage[] {
  if (!input.exportDecision.structuredExportAllowed) {
    throw new ModelError(
      'MODEL_NOT_CONFIGURED',
      'Remote structured page export is not allowed.',
    );
  }

  const question = normalizeUserQuestion(input.question);
  const messages: ModelMessage[] = [
    {
      role: 'system',
      content: [{ type: 'text', text: READ_ONLY_SYSTEM_PROMPT }],
    },
    {
      role: 'user',
      content: [{ type: 'text', text: `USER_INSTRUCTION\n${question}` }],
    },
  ];

  for (const page of input.pages) {
    const untrusted = wrapUntrustedPageContent(page.serializedContext);
    messages.push({
      role: 'user',
      content: [{ type: 'text', text: `PAGE_CONTEXT tab ${page.tabId}\n${untrusted}` }],
    });
  }

  return messages;
}

export function aggregateTruncatedContext(pages: readonly BrowserContextPage[]): boolean {
  return pages.some((page) => page.truncated);
}
