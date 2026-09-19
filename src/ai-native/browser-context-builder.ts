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
  type BrowserContextSourceSnapshot,
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

function captureSelectedTabSnapshot(
  browserState: BrowserState,
  tabIds: readonly TabId[],
): readonly BrowserContextSourceSnapshot[] {
  validateSelectedTabsAgainstBrowserState(browserState, tabIds);
  return tabIds.map((tabId) => {
    const tab = browserState.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new ObservationError('TAB_NOT_FOUND', 'Selected tab was not found.');
    }
    return { tabId, url: tab.url };
  });
}

function assertSelectedTabMatchesSnapshot(
  browserState: BrowserState,
  snapshot: BrowserContextSourceSnapshot,
): void {
  const tab = browserState.tabs.find((candidate) => candidate.id === snapshot.tabId);
  if (!tab) {
    throw new ObservationError('TAB_NOT_FOUND', 'Selected tab was not found.');
  }
  if (tab.url !== snapshot.url) {
    throw new ObservationError('OBSERVATION_FAILED', 'Selected tab context is no longer available.');
  }
  if (tab.url === 'about:blank' || !isHttpDocumentUrl(tab.url)) {
    throw new ObservationError('OBSERVATION_FAILED', 'Selected tab URL is not available.');
  }
}

export function assertBrowserContextSnapshotStillCurrent(
  browserState: BrowserState,
  snapshot: readonly BrowserContextSourceSnapshot[],
): void {
  for (const selected of snapshot) {
    assertSelectedTabMatchesSnapshot(browserState, selected);
  }
}

async function observeSelectedTab(
  observationSource: MultiTabObservationSource,
  snapshot: BrowserContextSourceSnapshot,
  getBrowserState: () => BrowserState,
  signal?: AbortSignal,
): Promise<PageObservation> {
  const options: ObservePageOptions = { includeScreenshot: false };
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_OBSERVATION_ATTEMPTS; attempt += 1) {
    throwIfCancelled(signal);
    assertSelectedTabMatchesSnapshot(getBrowserState(), snapshot);
    try {
      const observation = await observationSource.observePage(snapshot.tabId, options);
      throwIfCancelled(signal);
      if (observation.tabId !== snapshot.tabId) {
        throw new ObservationError(
          'OBSERVATION_FAILED',
          'Observation tab correlation did not match the requested tab.',
        );
      }
      if (observation.document.url !== snapshot.url || !isHttpDocumentUrl(observation.document.url)) {
        throw new ObservationError(
          'OBSERVATION_FAILED',
          'Observed document does not match the selected tab.',
        );
      }
      assertSelectedTabMatchesSnapshot(getBrowserState(), snapshot);
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
  getBrowserState: () => BrowserState;
  observationSource: MultiTabObservationSource;
  signal?: AbortSignal;
}): Promise<BrowserContextBundle> {
  throwIfCancelled(input.signal);
  const snapshot = captureSelectedTabSnapshot(input.getBrowserState(), input.tabIds);

  const pages: BrowserContextPage[] = [];
  for (const selected of snapshot) {
    const observation = await observeSelectedTab(
      input.observationSource,
      selected,
      input.getBrowserState,
      input.signal,
    );
    const built = buildModelPageContext(observation, {
      maxStructuredChars: MAX_CONTEXT_STRUCTURED_CHARS_PER_TAB,
    });
    pages.push({
      tabId: selected.tabId,
      observation,
      serializedContext: built.serialized,
      truncated: built.context.truncated,
    });
  }

  throwIfCancelled(input.signal);
  // Same-URL reloads are not visible on trusted BrowserState, which only exposes URL.
  // This final check therefore detects navigation/substitution, not in-place revision change.
  assertBrowserContextSnapshotStillCurrent(input.getBrowserState(), snapshot);

  const totalChars = pages.reduce((sum, page) => sum + page.serializedContext.length, 0);
  if (totalChars > MAX_CONTEXT_STRUCTURED_CHARS_TOTAL) {
    throw new ModelError(
      'CONTEXT_TOO_LARGE',
      'The selected browser context exceeds the total structured budget.',
    );
  }

  return {
    contextId: crypto.randomUUID(),
    sourceSnapshot: snapshot,
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
