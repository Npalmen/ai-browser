import type { AiAnswerEvent, AiRequestMode, AiSafeError } from '../shared/ai-types';
import type { TabId } from '../shared/browser-types';

export type AiAssistantStatus = 'streaming' | 'complete' | 'cancelled' | 'error' | 'denied' | 'approval';

export interface AiTranscriptEntry {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: AiAssistantStatus;
  truncatedContext?: boolean;
  errorMessage?: string;
  askId?: string;
}

export interface TabAiUiState {
  entries: AiTranscriptEntry[];
  activeAskId: string | null;
  draft: string;
  mode: AiRequestMode;
  latestAskId: string | null;
  staleAskIds: ReadonlySet<string>;
  latestSubmissionId: string | null;
  staleSubmissionIds: ReadonlySet<string>;
}

export type AiUiState = Record<TabId, TabAiUiState>;

export function emptyTabAiState(): TabAiUiState {
  return {
    entries: [],
    activeAskId: null,
    draft: '',
    mode: 'read',
    latestAskId: null,
    staleAskIds: new Set(),
    latestSubmissionId: null,
    staleSubmissionIds: new Set(),
  };
}

export function appendUserQuestion(
  state: AiUiState,
  tabId: TabId,
  question: string,
  submissionId: string,
  createId: () => string = createEntryId,
): AiUiState {
  const tab = tabOf(state, tabId);
  let staleSubmissionIds: ReadonlySet<string> = tab.staleSubmissionIds;
  if (tab.latestSubmissionId && tab.latestSubmissionId !== submissionId) {
    const nextStale = new Set(staleSubmissionIds);
    nextStale.add(tab.latestSubmissionId);
    staleSubmissionIds = nextStale;
  }

  return withTab(state, tabId, {
    ...tab,
    draft: '',
    latestSubmissionId: submissionId,
    staleSubmissionIds,
    entries: [
      ...tab.entries,
      {
        id: createId(),
        role: 'user',
        text: question,
      },
    ],
  });
}

export function acknowledgeAsk(
  state: AiUiState,
  tabId: TabId,
  askId: string,
  submissionId: string,
  createId: () => string = createEntryId,
): AiUiState {
  const tab = tabOf(state, tabId);
  if (!isCurrentSubmission(tab, submissionId)) {
    return state;
  }
  return withTab(state, tabId, establishAsk(tab, askId, createId));
}

export function applyAskStartFailure(
  state: AiUiState,
  tabId: TabId,
  error: AiSafeError,
  submissionId: string,
  createId: () => string = createEntryId,
): AiUiState {
  const tab = tabOf(state, tabId);
  if (!isCurrentSubmission(tab, submissionId)) {
    return state;
  }
  return withTab(state, tabId, {
    ...tab,
    activeAskId: null,
    entries: [
      ...tab.entries,
      {
        id: createId(),
        role: 'assistant',
        text: '',
        status: 'error',
        errorMessage: error.message,
      },
    ],
  });
}

export function applyAiAnswerEvent(
  state: AiUiState,
  event: AiAnswerEvent,
  createId: () => string = createEntryId,
): AiUiState {
  if (event.type === 'conversation-cleared') {
    return withTab(state, event.tabId, clearTabConversation(tabOf(state, event.tabId)));
  }

  const tab = tabOf(state, event.tabId);
  if (tab.staleAskIds.has(event.askId)) {
    return state;
  }

  if (event.type === 'answer-started' || event.type === 'interaction-started') {
    return withTab(state, event.tabId, establishAsk(tab, event.askId, createId));
  }

  if (tab.latestAskId !== null && tab.latestAskId !== event.askId) {
    return state;
  }

  const established =
    tab.latestAskId === event.askId ? tab : establishAsk(tab, event.askId, createId);
  return withTab(state, event.tabId, applyAskProgress(established, event));
}

export function purgeClosedTabs(state: AiUiState, liveTabIds: ReadonlySet<TabId>): AiUiState {
  const next: AiUiState = {};
  let changed = false;
  for (const [tabId, tabState] of Object.entries(state)) {
    if (liveTabIds.has(tabId)) {
      next[tabId] = tabState;
    } else {
      changed = true;
    }
  }
  return changed ? next : state;
}

function isCurrentSubmission(tab: TabAiUiState, submissionId: string): boolean {
  return !tab.staleSubmissionIds.has(submissionId) && tab.latestSubmissionId === submissionId;
}

function establishAsk(tab: TabAiUiState, askId: string, createId: () => string): TabAiUiState {
  if (tab.staleAskIds.has(askId)) {
    return tab;
  }

  let staleAskIds: ReadonlySet<string> = tab.staleAskIds;
  if (tab.latestAskId && tab.latestAskId !== askId) {
    const nextStale = new Set(staleAskIds);
    nextStale.add(tab.latestAskId);
    staleAskIds = nextStale;
  }

  return ensureAskEntry({ ...tab, staleAskIds }, askId, createId);
}

function ensureAskEntry(tab: TabAiUiState, askId: string, createId: () => string): TabAiUiState {
  const existingIndex = findAssistantIndex(tab.entries, askId);
  const entries =
    existingIndex >= 0
      ? tab.entries
      : [
          ...tab.entries,
          {
            id: createId(),
            role: 'assistant' as const,
            text: '',
            status: 'streaming' as const,
            askId,
          },
        ];
  const entry = entries[findAssistantIndex(entries, askId)];
  if (!entry) {
    return tab;
  }

  return {
    ...tab,
    entries,
    latestAskId: askId,
    activeAskId: isTerminal(entry.status) ? null : askId,
  };
}

function applyAskProgress(tab: TabAiUiState, event: Exclude<AiAnswerEvent, { type: 'conversation-cleared' }>): TabAiUiState {
  const index = findAssistantIndex(tab.entries, event.askId);
  if (index < 0) {
    return tab;
  }

  const entry = tab.entries[index];
  if (!entry || entry.role !== 'assistant') {
    return tab;
  }

  let updated: AiTranscriptEntry | undefined;
  if (event.type === 'answer-text') {
    if (isTerminal(entry.status)) {
      return tab;
    }
    updated = {
      ...entry,
      status: 'streaming',
      text: `${entry.text}${event.delta}`,
    };
  } else if (event.type === 'answer-finished') {
    if (entry.status === 'cancelled' || entry.status === 'error') {
      return tab;
    }
    updated = {
      ...entry,
      status: 'complete',
      text: event.answer.text,
      truncatedContext: event.answer.truncatedContext,
    };
  } else if (event.type === 'answer-cancelled') {
    if (entry.status === 'complete' || entry.status === 'error') {
      return tab;
    }
    updated = {
      ...entry,
      status: 'cancelled',
    };
  } else if (event.type === 'answer-error') {
    if (entry.status === 'complete' || entry.status === 'cancelled') {
      return tab;
    }
    updated = {
      ...entry,
      status: 'error',
      errorMessage: event.error.message,
    };
  } else if (event.type === 'interaction-completed') {
    if (isTerminal(entry.status)) {
      return tab;
    }
    updated = {
      ...entry,
      status: 'complete',
      text: 'Interaction completed.',
      truncatedContext: event.truncatedContext,
    };
  } else if (event.type === 'interaction-denied') {
    if (isTerminal(entry.status)) {
      return tab;
    }
    updated = {
      ...entry,
      status: 'denied',
      text: 'Action not performed.',
      errorMessage: event.error.message,
      truncatedContext: event.truncatedContext,
    };
  } else if (event.type === 'interaction-failed') {
    if (isTerminal(entry.status)) {
      return tab;
    }
    updated = {
      ...entry,
      status: 'error',
      text: 'Interaction failed.',
      errorMessage: event.error.message,
      truncatedContext: event.truncatedContext,
    };
  } else if (event.type === 'interaction-approval-required') {
    if (isTerminal(entry.status)) {
      return tab;
    }
    updated = {
      ...entry,
      status: 'approval',
      text: 'Approval required before this action can be performed.',
      truncatedContext: event.truncatedContext,
    };
  }

  if (!updated) {
    return tab;
  }

  const entries = tab.entries.slice();
  entries[index] = updated;
  return {
    ...tab,
    entries,
    activeAskId: isTerminal(updated.status) ? null : tab.activeAskId,
  };
}

function clearTabConversation(tab: TabAiUiState): TabAiUiState {
  const staleAskIds = new Set(tab.staleAskIds);
  if (tab.latestAskId) {
    staleAskIds.add(tab.latestAskId);
  }
  for (const entry of tab.entries) {
    if (entry.askId) {
      staleAskIds.add(entry.askId);
    }
  }
  const staleSubmissionIds = new Set(tab.staleSubmissionIds);
  if (tab.latestSubmissionId) {
    staleSubmissionIds.add(tab.latestSubmissionId);
  }
  return {
    entries: [],
    activeAskId: null,
    draft: '',
    mode: 'read',
    latestAskId: null,
    staleAskIds,
    latestSubmissionId: null,
    staleSubmissionIds,
  };
}

function tabOf(state: AiUiState, tabId: TabId): TabAiUiState {
  return state[tabId] ?? emptyTabAiState();
}

function withTab(state: AiUiState, tabId: TabId, tab: TabAiUiState): AiUiState {
  return {
    ...state,
    [tabId]: tab,
  };
}

function findAssistantIndex(entries: readonly AiTranscriptEntry[], askId: string): number {
  return entries.findIndex((entry) => entry.role === 'assistant' && entry.askId === askId);
}

function isTerminal(status: AiAssistantStatus | undefined): boolean {
  return (
    status === 'complete' ||
    status === 'cancelled' ||
    status === 'error' ||
    status === 'denied' ||
    status === 'approval'
  );
}

function createEntryId(): string {
  return crypto.randomUUID();
}
