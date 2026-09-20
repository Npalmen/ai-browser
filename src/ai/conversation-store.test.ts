import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODEL_CONTEXT_BUDGETS } from './context-builder';
import {
  ConversationStore,
  HISTORY_TRUNCATION_MARKER,
  MAX_CONVERSATION_TURNS,
  serializeActUserContext,
  serializeConversationHistory,
} from './conversation-store';

describe('ConversationStore', () => {
  it('keeps at most four completed turns and drops the oldest first', () => {
    const store = new ConversationStore();
    for (let index = 1; index <= 5; index += 1) {
      store.commitTurn('tab-1', 'rev-a', {
        question: `q${index}`,
        answer: `a${index}`,
      });
    }

    const stored = store.get('tab-1');
    assert.deepEqual(
      stored?.turns.map((turn) => turn.question),
      ['q2', 'q3', 'q4', 'q5'],
    );
    assert.equal(stored?.turns.length, MAX_CONVERSATION_TURNS);
    assert.equal(stored?.documentRevision, 'rev-a');
  });

  it('does not store screenshot, target, or model metadata', () => {
    const store = new ConversationStore();
    store.commitTurn('tab-1', 'rev-a', { question: 'What?', answer: 'A heading.' });
    const serialized = JSON.stringify(store.get('tab-1'));
    assert.equal(serialized.includes('screenshot'), false);
    assert.equal(serialized.includes('referencedTargets'), false);
    assert.equal(serialized.includes('targetId'), false);
    assert.equal(serialized.includes('usage'), false);
    assert.equal(serialized.includes('page-standard'), false);
  });

  it('clears one tab without affecting another', () => {
    const store = new ConversationStore();
    store.commitTurn('tab-1', 'rev-a', { question: 'one', answer: '1' });
    store.commitTurn('tab-2', 'rev-b', { question: 'two', answer: '2' });
    store.clear('tab-1');
    assert.equal(store.get('tab-1'), undefined);
    assert.deepEqual(store.get('tab-2')?.turns, [{ question: 'two', answer: '2' }]);
  });

  it('clears all conversations', () => {
    const store = new ConversationStore();
    store.commitTurn('tab-1', 'rev-a', { question: 'one', answer: '1' });
    store.commitTurn('tab-2', 'rev-b', { question: 'two', answer: '2' });
    store.clearAll();
    assert.equal(store.get('tab-1'), undefined);
    assert.equal(store.get('tab-2'), undefined);
  });

  it('returns prior turns only for the matching document revision', () => {
    const store = new ConversationStore();
    store.commitTurn('tab-1', 'rev-a', { question: 'old', answer: 'answer' });
    assert.deepEqual(store.getTurnsForRevision('tab-1', 'rev-a'), [
      { question: 'old', answer: 'answer' },
    ]);
    assert.deepEqual(store.getTurnsForRevision('tab-1', 'rev-b'), []);
    assert.equal(store.get('tab-1'), undefined);
  });
});

describe('serializeConversationHistory', () => {
  it('uses the product history budget by default', () => {
    assert.equal(MODEL_CONTEXT_BUDGETS.maxHistoryChars, 8_000);
    const wrapped = serializeConversationHistory([
      { question: 'What is the heading?', answer: 'Observation Fixture' },
    ]);
    assert.match(wrapped, /^<PRIOR_CONVERSATION>/);
    assert.match(wrapped, /<\/PRIOR_CONVERSATION>$/);
    assert.match(wrapped, /conversational context only/i);
    assert.match(wrapped, /not evidence of current browser state/i);
    assert.equal(wrapped.includes('UNTRUSTED_PAGE_CONTENT'), false);
    assert.ok(wrapped.length <= MODEL_CONTEXT_BUDGETS.maxHistoryChars);
  });

  it('drops oldest turns first and clips the newest when it exceeds the budget', () => {
    const history = serializeConversationHistory(
      [
        { question: 'old question', answer: 'old answer' },
        { question: 'newest question', answer: 'N'.repeat(400) },
      ],
      360,
    );

    assert.equal(history.includes('old question'), false);
    assert.equal(history.includes('newest question'), true);
    assert.equal(history.includes(HISTORY_TRUNCATION_MARKER), true);
    assert.ok(history.length <= 360);
    assert.match(history, /^<PRIOR_CONVERSATION>/);
    assert.match(history, /not evidence of current browser state/i);
  });

  it('returns empty text when there are no turns', () => {
    assert.equal(serializeConversationHistory([]), '');
  });
});

describe('serializeActUserContext', () => {
  it('includes previous user requests and omits assistant execution claims', () => {
    const wrapped = serializeActUserContext([
      {
        question: 'klicka på WebDriverIO',
        answer: 'Jag klickade på WebDriverIO.',
      },
    ]);
    assert.match(wrapped, /^<PRIOR_USER_CONTEXT>/);
    assert.match(wrapped, /<\/PRIOR_USER_CONTEXT>$/);
    assert.match(wrapped, /klicka på WebDriverIO/);
    assert.match(wrapped, /conversational reference only/i);
    assert.match(wrapped, /not evidence of current browser state or completed actions/i);
    assert.equal(wrapped.includes('Jag klickade på WebDriverIO.'), false);
    assert.equal(wrapped.includes('PRIOR_CONVERSATION'), false);
  });

  it('serializeForActRevision matches serializeActUserContext', () => {
    const store = new ConversationStore();
    store.commitTurn('tab-1', 'rev-a', {
      question: 'klicka på WebDriverIO',
      answer: 'Jag klickade på WebDriverIO.',
    });
    const serialized = store.serializeForActRevision('tab-1', 'rev-a');
    assert.match(serialized, /klicka på WebDriverIO/);
    assert.equal(serialized.includes('Jag klickade på WebDriverIO.'), false);
  });
});
