import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AiAnswerEvent } from '../shared/ai-types';
import {
  acknowledgeAsk,
  appendUserQuestion,
  applyAiAnswerEvent,
  applyAskStartFailure,
  emptyTabAiState,
  type AiUiState,
  type TabAiUiState,
} from './ai-ui-state';

const TAB = 'tab-1';
const ASK_A = 'ask-a';
const ASK_B = 'ask-b';
const SUB_A = 'sub-a';
const SUB_B = 'sub-b';

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

function tab(state: AiUiState, tabId = TAB): TabAiUiState {
  return state[tabId] ?? emptyTabAiState();
}

function assistants(state: AiUiState, tabId = TAB) {
  return tab(state, tabId).entries.filter((entry) => entry.role === 'assistant');
}

function started(askId: string, tabId = TAB): AiAnswerEvent {
  return { type: 'answer-started', askId, tabId };
}

function delta(askId: string, text: string, tabId = TAB): AiAnswerEvent {
  return { type: 'answer-text', askId, tabId, delta: text };
}

function finished(askId: string, text: string, tabId = TAB): AiAnswerEvent {
  return {
    type: 'answer-finished',
    askId,
    tabId,
    answer: { text, truncatedContext: false },
  };
}

function errored(askId: string, tabId = TAB): AiAnswerEvent {
  return {
    type: 'answer-error',
    askId,
    tabId,
    error: { code: 'MODEL_NOT_CONFIGURED', message: 'AI is not configured.' },
  };
}

function cancelled(askId: string, tabId = TAB): AiAnswerEvent {
  return { type: 'answer-cancelled', askId, tabId };
}

const START_FAILURE = { code: 'MODEL_NOT_CONFIGURED' as const, message: 'AI is not configured.' };

describe('AI UI event ordering', () => {
  it('Case A: acknowledgement then started/text/finished yields one completed assistant', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is this?', SUB_A, createId);
    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, 'Hello'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Hello world'), createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.text, 'Hello world');
    assert.equal(assistants(state)[0]?.status, 'complete');
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case B: events before acknowledgement keep one completed assistant', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is this?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, 'Hello'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Hello world'), createId);
    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.text, 'Hello world');
    assert.equal(assistants(state)[0]?.status, 'complete');
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case C: started before acknowledgement then streams normally', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is this?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, 'Hel'), createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, 'lo'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Hello'), createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.text, 'Hello');
    assert.equal(assistants(state)[0]?.status, 'complete');
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case D: error before acknowledgement is retained and not reopened', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is this?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, errored(ASK_A), createId);
    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.status, 'error');
    assert.equal(assistants(state)[0]?.errorMessage, 'AI is not configured.');
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case E: cancellation before acknowledgement is retained and not reopened', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is this?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, 'Partial'), createId);
    state = applyAiAnswerEvent(state, cancelled(ASK_A), createId);
    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.status, 'cancelled');
    assert.equal(assistants(state)[0]?.text, 'Partial');
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case F: conversation-cleared suppresses late events from the cleared ask', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is this?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, 'Hello'), createId);
    state = applyAiAnswerEvent(
      state,
      { type: 'conversation-cleared', tabId: TAB, reason: 'user' },
      createId,
    );
    state = applyAiAnswerEvent(state, delta(ASK_A, ' more'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Hello world'), createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);

    assert.deepEqual(tab(state).entries, []);
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case G: late events from ask A do not alter ask B', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'Question A?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, 'From A'), createId);
    state = appendUserQuestion(state, TAB, 'Question B?', SUB_B, createId);
    state = applyAiAnswerEvent(state, started(ASK_B), createId);
    state = acknowledgeAsk(state, TAB, ASK_B, SUB_B, createId);
    state = applyAiAnswerEvent(state, delta(ASK_A, ' leaked'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'From A leaked'), createId);
    state = applyAiAnswerEvent(state, delta(ASK_B, 'From B'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_B, 'From B final'), createId);

    const assistantEntries = assistants(state);
    const askA = assistantEntries.filter((entry) => entry.askId === ASK_A);
    const askB = assistantEntries.filter((entry) => entry.askId === ASK_B);
    assert.equal(askA.length, 1);
    assert.equal(askB.length, 1);
    assert.equal(askA[0]?.text, 'From A');
    assert.equal(askA[0]?.status, 'streaming');
    assert.equal(askB[0]?.text, 'From B final');
    assert.equal(askB[0]?.status, 'complete');
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case H: late acknowledgement A after B started does not supersede B', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'Question A?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Done A'), createId);
    state = appendUserQuestion(state, TAB, 'Question B?', SUB_B, createId);
    state = applyAiAnswerEvent(state, started(ASK_B), createId);

    assert.equal(tab(state).latestAskId, ASK_B);
    assert.equal(tab(state).activeAskId, ASK_B);
    assert.equal(tab(state).staleAskIds.has(ASK_B), false);

    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);

    assert.equal(tab(state).latestAskId, ASK_B);
    assert.equal(tab(state).activeAskId, ASK_B);
    assert.equal(tab(state).staleAskIds.has(ASK_B), false);
    assert.equal(tab(state).latestSubmissionId, SUB_B);

    const afterLateAck = assistants(state);
    assert.equal(afterLateAck.filter((entry) => entry.askId === ASK_A).length, 1);
    assert.equal(afterLateAck.find((entry) => entry.askId === ASK_A)?.status, 'complete');
    assert.equal(afterLateAck.filter((entry) => entry.askId === ASK_B).length, 1);
    assert.equal(afterLateAck.find((entry) => entry.askId === ASK_B)?.status, 'streaming');

    state = applyAiAnswerEvent(state, delta(ASK_B, 'From B'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_B, 'From B final'), createId);

    const assistantEntries = assistants(state);
    assert.equal(assistantEntries.filter((entry) => entry.askId === ASK_A).length, 1);
    assert.equal(assistantEntries.filter((entry) => entry.askId === ASK_B).length, 1);
    assert.equal(assistantEntries.find((entry) => entry.askId === ASK_A)?.status, 'complete');
    assert.equal(assistantEntries.find((entry) => entry.askId === ASK_B)?.text, 'From B final');
    assert.equal(assistantEntries.find((entry) => entry.askId === ASK_B)?.status, 'complete');
    assert.equal(tab(state).latestAskId, ASK_B);
    assert.equal(tab(state).activeAskId, null);
    assert.equal(tab(state).staleAskIds.has(ASK_B), false);
  });

  it('Case I: late acknowledgement A after B acknowledgement is a no-op', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'Question A?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Done A'), createId);
    state = appendUserQuestion(state, TAB, 'Question B?', SUB_B, createId);
    state = acknowledgeAsk(state, TAB, ASK_B, SUB_B, createId);
    state = applyAiAnswerEvent(state, started(ASK_B), createId);
    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);
    state = applyAiAnswerEvent(state, finished(ASK_B, 'Done B'), createId);

    const assistantEntries = assistants(state);
    assert.equal(assistantEntries.filter((entry) => entry.askId === ASK_A).length, 1);
    assert.equal(assistantEntries.filter((entry) => entry.askId === ASK_B).length, 1);
    assert.equal(assistantEntries.find((entry) => entry.askId === ASK_A)?.status, 'complete');
    assert.equal(assistantEntries.find((entry) => entry.askId === ASK_B)?.status, 'complete');
    assert.equal(assistantEntries.find((entry) => entry.askId === ASK_B)?.text, 'Done B');
    assert.equal(tab(state).latestAskId, ASK_B);
    assert.equal(tab(state).activeAskId, null);
    assert.equal(tab(state).staleAskIds.has(ASK_B), false);
  });

  it('Case J: stale start failure for A does not disturb B', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'Question A?', SUB_A, createId);
    state = appendUserQuestion(state, TAB, 'Question B?', SUB_B, createId);
    state = applyAiAnswerEvent(state, started(ASK_B), createId);

    assert.equal(tab(state).latestSubmissionId, SUB_B);
    assert.equal(tab(state).activeAskId, ASK_B);

    state = applyAskStartFailure(state, TAB, START_FAILURE, SUB_A, createId);

    assert.equal(tab(state).latestSubmissionId, SUB_B);
    assert.equal(tab(state).activeAskId, ASK_B);
    assert.equal(tab(state).latestAskId, ASK_B);
    assert.equal(
      assistants(state).some((entry) => entry.status === 'error' && entry.askId !== ASK_B),
      false,
    );
    assert.equal(assistants(state).find((entry) => entry.askId === ASK_B)?.status, 'streaming');
    assert.equal(assistants(state).find((entry) => entry.askId === ASK_B)?.errorMessage, undefined);

    state = applyAiAnswerEvent(state, delta(ASK_B, 'From B'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_B, 'From B final'), createId);

    assert.equal(assistants(state).find((entry) => entry.askId === ASK_B)?.text, 'From B final');
    assert.equal(assistants(state).find((entry) => entry.askId === ASK_B)?.status, 'complete');
    assert.equal(tab(state).latestSubmissionId, SUB_B);
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case K: conversation-cleared invalidates pending renderer correlation', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is this?', SUB_A, createId);
    state = applyAiAnswerEvent(
      state,
      { type: 'conversation-cleared', tabId: TAB, reason: 'user' },
      createId,
    );
    state = acknowledgeAsk(state, TAB, ASK_A, SUB_A, createId);

    assert.deepEqual(tab(state).entries, []);
    assert.equal(tab(state).latestAskId, null);
    assert.equal(tab(state).activeAskId, null);
    assert.equal(tab(state).latestSubmissionId, null);
    assert.equal(tab(state).staleSubmissionIds.has(SUB_A), true);
  });

  it('Case L: interaction-started then interaction-completed yields one assistant entry', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'Click save', SUB_A, createId);
    state = applyAiAnswerEvent(
      state,
      { type: 'interaction-started', askId: ASK_A, tabId: TAB },
      createId,
    );
    state = applyAiAnswerEvent(
      state,
      { type: 'interaction-completed', askId: ASK_A, tabId: TAB, truncatedContext: false },
      createId,
    );

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.text, 'Interaction completed.');
    assert.equal(assistants(state)[0]?.status, 'complete');
    assert.equal(tab(state).activeAskId, null);
  });

  it('Case M: interaction-started then denied uses denied status', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'Buy now', SUB_A, createId);
    state = applyAiAnswerEvent(
      state,
      { type: 'interaction-started', askId: ASK_A, tabId: TAB },
      createId,
    );
    state = applyAiAnswerEvent(
      state,
      {
        type: 'interaction-denied',
        askId: ASK_A,
        tabId: TAB,
        truncatedContext: false,
        error: {
          code: 'DEFERRED_TO_EXECUTE',
          message: 'This action is not available without additional approval.',
        },
      },
      createId,
    );

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.status, 'denied');
    assert.equal(assistants(state)[0]?.text, 'Action not performed.');
    assert.equal(
      assistants(state)[0]?.errorMessage,
      'This action is not available without additional approval.',
    );
  });

  it('Case N: interaction-started then answer-finished keeps one assistant entry', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, TAB, 'What is here?', SUB_A, createId);
    state = applyAiAnswerEvent(
      state,
      { type: 'interaction-started', askId: ASK_A, tabId: TAB },
      createId,
    );
    state = applyAiAnswerEvent(state, delta(ASK_A, 'Hello'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Hello world'), createId);

    assert.equal(assistants(state).length, 1);
    assert.equal(assistants(state)[0]?.text, 'Hello world');
    assert.equal(assistants(state)[0]?.status, 'complete');
  });

  it('keeps tab transcripts isolated', () => {
    const createId = ids();
    let state: AiUiState = {};
    state = appendUserQuestion(state, 'tab-1', 'One?', SUB_A, createId);
    state = applyAiAnswerEvent(state, started(ASK_A, 'tab-1'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_A, 'Answer one', 'tab-1'), createId);
    state = appendUserQuestion(state, 'tab-2', 'Two?', SUB_B, createId);
    state = applyAiAnswerEvent(state, started(ASK_B, 'tab-2'), createId);
    state = applyAiAnswerEvent(state, finished(ASK_B, 'Answer two', 'tab-2'), createId);

    assert.equal(assistants(state, 'tab-1')[0]?.text, 'Answer one');
    assert.equal(assistants(state, 'tab-2')[0]?.text, 'Answer two');
    assert.equal(tab(state, 'tab-1').entries.some((entry) => entry.text === 'Two?'), false);
  });
});
