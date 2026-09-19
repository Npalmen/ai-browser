import type { AiNativeContextAnswerEvent, AiNativeSafeError } from '../shared/ai-native-types';

export type ContextAnswerStatus = 'streaming' | 'complete' | 'cancelled' | 'error';

export interface ContextAnswerEntry {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly status?: ContextAnswerStatus;
  readonly truncatedContext?: boolean;
  readonly errorMessage?: string;
  readonly askId?: string;
}

export interface ContextAnswerUiState {
  readonly entries: readonly ContextAnswerEntry[];
  readonly activeAskId: string | null;
  readonly latestAskId: string | null;
  readonly staleAskIds: ReadonlySet<string>;
  readonly latestSubmissionId: string | null;
  readonly staleSubmissionIds: ReadonlySet<string>;
}

export function emptyContextAnswerUiState(): ContextAnswerUiState {
  return {
    entries: [],
    activeAskId: null,
    latestAskId: null,
    staleAskIds: new Set(),
    latestSubmissionId: null,
    staleSubmissionIds: new Set(),
  };
}

export function beginContextAsk(
  state: ContextAnswerUiState,
  question: string,
  submissionId: string,
  createId: () => string = createEntryId,
): ContextAnswerUiState {
  let staleAskIds: ReadonlySet<string> = state.staleAskIds;
  if (state.latestAskId) {
    const nextStale = new Set(staleAskIds);
    nextStale.add(state.latestAskId);
    staleAskIds = nextStale;
  }

  let staleSubmissionIds: ReadonlySet<string> = state.staleSubmissionIds;
  if (state.latestSubmissionId && state.latestSubmissionId !== submissionId) {
    const nextStale = new Set(staleSubmissionIds);
    nextStale.add(state.latestSubmissionId);
    staleSubmissionIds = nextStale;
  }

  return {
    ...state,
    staleAskIds,
    staleSubmissionIds,
    latestSubmissionId: submissionId,
    activeAskId: null,
    latestAskId: null,
    entries: [
      ...state.entries,
      {
        id: createId(),
        role: 'user',
        text: question,
      },
    ],
  };
}

export function acknowledgeContextAsk(
  state: ContextAnswerUiState,
  askId: string,
  submissionId: string,
  createId: () => string = createEntryId,
): ContextAnswerUiState {
  if (!isCurrentSubmission(state, submissionId)) {
    return state;
  }
  return establishContextAsk(state, askId, createId);
}

export function applyContextAskStartFailure(
  state: ContextAnswerUiState,
  error: AiNativeSafeError,
  submissionId: string,
  createId: () => string = createEntryId,
): ContextAnswerUiState {
  if (!isCurrentSubmission(state, submissionId)) {
    return state;
  }
  return {
    ...state,
    activeAskId: null,
    entries: [
      ...state.entries,
      {
        id: createId(),
        role: 'assistant',
        text: '',
        status: 'error',
        errorMessage: error.message,
      },
    ],
  };
}

export function applyContextAnswerEvent(
  state: ContextAnswerUiState,
  event: AiNativeContextAnswerEvent,
  createId: () => string = createEntryId,
): ContextAnswerUiState {
  if (state.staleAskIds.has(event.askId)) {
    return state;
  }

  if (event.type === 'context-answer-started') {
    return establishContextAsk(state, event.askId, createId);
  }

  if (state.latestAskId !== null && state.latestAskId !== event.askId) {
    return state;
  }

  const established =
    state.latestAskId === event.askId ? state : establishContextAsk(state, event.askId, createId);
  return applyContextAnswerProgress(established, event);
}

export function clearContextAnswerState(): ContextAnswerUiState {
  return emptyContextAnswerUiState();
}

export function isContextAskActive(state: ContextAnswerUiState): boolean {
  return state.activeAskId !== null;
}

function isCurrentSubmission(state: ContextAnswerUiState, submissionId: string): boolean {
  return (
    !state.staleSubmissionIds.has(submissionId) && state.latestSubmissionId === submissionId
  );
}

function establishContextAsk(
  state: ContextAnswerUiState,
  askId: string,
  createId: () => string,
): ContextAnswerUiState {
  if (state.staleAskIds.has(askId)) {
    return state;
  }

  let staleAskIds: ReadonlySet<string> = state.staleAskIds;
  if (state.latestAskId && state.latestAskId !== askId) {
    const nextStale = new Set(staleAskIds);
    nextStale.add(state.latestAskId);
    staleAskIds = nextStale;
  }

  return ensureContextAskEntry({ ...state, staleAskIds }, askId, createId);
}

function ensureContextAskEntry(
  state: ContextAnswerUiState,
  askId: string,
  createId: () => string,
): ContextAnswerUiState {
  const existingIndex = findAssistantIndex(state.entries, askId);
  const entries =
    existingIndex >= 0
      ? state.entries
      : [
          ...state.entries,
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
    return state;
  }

  return {
    ...state,
    entries,
    latestAskId: askId,
    activeAskId: isTerminal(entry.status) ? null : askId,
  };
}

function applyContextAnswerProgress(
  state: ContextAnswerUiState,
  event: Exclude<AiNativeContextAnswerEvent, { type: 'context-answer-started' }>,
): ContextAnswerUiState {
  const index = findAssistantIndex(state.entries, event.askId);
  if (index < 0) {
    return state;
  }

  const entry = state.entries[index];
  if (!entry || entry.role !== 'assistant') {
    return state;
  }

  let updated: ContextAnswerEntry | undefined;
  if (event.type === 'context-answer-text') {
    if (isTerminal(entry.status)) {
      return state;
    }
    updated = {
      ...entry,
      status: 'streaming',
      text: `${entry.text}${event.delta}`,
    };
  } else if (event.type === 'context-answer-finished') {
    if (entry.status === 'cancelled' || entry.status === 'error') {
      return state;
    }
    updated = {
      ...entry,
      status: 'complete',
      text: event.answer.text,
      truncatedContext: event.answer.truncatedContext,
    };
  } else if (event.type === 'context-answer-cancelled') {
    if (entry.status === 'complete' || entry.status === 'error') {
      return state;
    }
    updated = {
      ...entry,
      status: 'cancelled',
    };
  } else if (event.type === 'context-answer-error') {
    if (entry.status === 'complete' || entry.status === 'cancelled') {
      return state;
    }
    updated = {
      ...entry,
      status: 'error',
      errorMessage: event.error.message,
    };
  }

  if (!updated) {
    return state;
  }

  const entries = state.entries.slice();
  entries[index] = updated;
  return {
    ...state,
    entries,
    activeAskId: isTerminal(updated.status) ? null : state.activeAskId,
  };
}

function findAssistantIndex(entries: readonly ContextAnswerEntry[], askId: string): number {
  return entries.findIndex((entry) => entry.role === 'assistant' && entry.askId === askId);
}

function isTerminal(status: ContextAnswerStatus | undefined): boolean {
  return status === 'complete' || status === 'cancelled' || status === 'error';
}

function createEntryId(): string {
  return crypto.randomUUID();
}
