import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiNativeContextAnswerEvent } from '../shared/ai-native-types';
import {
  acknowledgeContextAsk,
  applyContextAnswerEvent,
  applyContextAskStartFailure,
  beginContextAsk,
  clearContextAnswerState,
  emptyContextAnswerUiState,
  isContextAskActive,
  type ContextAnswerUiState,
} from './context-answer-ui-state';

const ASK_A = 'ask-a';
const ASK_B = 'ask-b';
const SUB_A = 'sub-a';
const SUB_B = 'sub-b';

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function assistants(state: ContextAnswerUiState) {
  return state.entries.filter((entry) => entry.role === 'assistant');
}

function started(askId: string): AiNativeContextAnswerEvent {
  return { type: 'context-answer-started', askId };
}

function delta(askId: string, text: string): AiNativeContextAnswerEvent {
  return { type: 'context-answer-text', askId, delta: text };
}

function finished(askId: string, text: string): AiNativeContextAnswerEvent {
  return {
    type: 'context-answer-finished',
    askId,
    answer: { text, truncatedContext: false },
  };
}

function errored(askId: string): AiNativeContextAnswerEvent {
  return {
    type: 'context-answer-error',
    askId,
    error: { code: 'AI_NATIVE_CONTEXT_UNAVAILABLE', message: 'Selected context is unavailable.' },
  };
}

function cancelled(askId: string): AiNativeContextAnswerEvent {
  return { type: 'context-answer-cancelled', askId };
}

const START_FAILURE = {
  code: 'AI_NATIVE_CONTEXT_UNAVAILABLE' as const,
  message: 'Selected context is unavailable.',
};

describe('context-answer-ui-state', () => {
  it('Case A: started event before acknowledgement yields one assistant entry', () => {
    const createId = ids();
    let state = emptyContextAnswerUiState();
    state = beginContextAsk(state, 'Compare tabs', SUB_A, createId);
    state = applyContextAnswerEvent(state, started(ASK_A), createId);
    state = acknowledgeContextAsk(state, ASK_A, SUB_A, createId);
    state = applyContextAnswerEvent(state, delta(ASK_A, 'Hello'), createId);
    state = applyContextAnswerEvent(state, finished(ASK_A, 'Hello world'), createId);

    assert.equal(state.entries.filter((entry) => entry.role === 'user').length, 1);
    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.text, 'Hello world');
    assert.equal(assistants(state)[0]?.status, 'complete');
    assert.equal(state.activeAskId, null);
  });

  it('Case B: acknowledgement before started event yields one assistant entry', () => {
    const createId = ids();
    let state = emptyContextAnswerUiState();
    state = beginContextAsk(state, 'Compare tabs', SUB_A, createId);
    state = acknowledgeContextAsk(state, ASK_A, SUB_A, createId);
    state = applyContextAnswerEvent(state, started(ASK_A), createId);
    state = applyContextAnswerEvent(state, delta(ASK_A, 'Hi'), createId);
    state = applyContextAnswerEvent(state, finished(ASK_A, 'Hi there'), createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.text, 'Hi there');
    assert.equal(assistants(state)[0]?.status, 'complete');
  });

  it('supersedes prior ask and ignores late stale events', () => {
    const createId = ids();
    let state = emptyContextAnswerUiState();
    state = beginContextAsk(state, 'Question A', SUB_A, createId);
    state = acknowledgeContextAsk(state, ASK_A, SUB_A, createId);
    state = applyContextAnswerEvent(state, delta(ASK_A, 'partial '), createId);

    state = beginContextAsk(state, 'Question B', SUB_B, createId);
    state = acknowledgeContextAsk(state, ASK_B, SUB_B, createId);
    state = applyContextAnswerEvent(state, delta(ASK_B, 'B '), createId);
    state = applyContextAnswerEvent(state, delta(ASK_A, 'stale'), createId);
    state = applyContextAnswerEvent(state, finished(ASK_B, 'B done'), createId);

    assert.equal(assistants(state).length, 2);
    const askA = assistants(state).find((entry) => entry.askId === ASK_A);
    const askB = assistants(state).find((entry) => entry.askId === ASK_B);
    assert.equal(askA?.text, 'partial ');
    assert.equal(askB?.text, 'B done');
    assert.equal(askB?.status, 'complete');
  });

  it('records start failure for current submission only', () => {
    const createId = ids();
    let state = emptyContextAnswerUiState();
    state = beginContextAsk(state, 'Question A', SUB_A, createId);
    state = applyContextAskStartFailure(state, START_FAILURE, SUB_A, createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.status, 'error');
    assert.equal(assistants(state)[0]?.errorMessage, START_FAILURE.message);
    assert.equal(state.activeAskId, null);
  });

  it('handles cancellation and error terminal states', () => {
    const createId = ids();
    let state = emptyContextAnswerUiState();
    state = beginContextAsk(state, 'Question', SUB_A, createId);
    state = acknowledgeContextAsk(state, ASK_A, SUB_A, createId);
    state = applyContextAnswerEvent(state, delta(ASK_A, 'partial'), createId);
    state = applyContextAnswerEvent(state, cancelled(ASK_A), createId);
    assert.equal(assistants(state)[0]?.status, 'cancelled');
    assert.equal(isContextAskActive(state), false);

    state = beginContextAsk(state, 'Question 2', SUB_B, createId);
    state = acknowledgeContextAsk(state, ASK_B, SUB_B, createId);
    state = applyContextAnswerEvent(state, errored(ASK_B), createId);
    assert.equal(assistants(state).find((entry) => entry.askId === ASK_B)?.status, 'error');
  });

  it('clears ephemeral context answer state', () => {
    const createId = ids();
    let state = emptyContextAnswerUiState();
    state = beginContextAsk(state, 'Question', SUB_A, createId);
    state = acknowledgeContextAsk(state, ASK_A, SUB_A, createId);
    state = clearContextAnswerState();
    assert.deepEqual(state, emptyContextAnswerUiState());
  });
});
