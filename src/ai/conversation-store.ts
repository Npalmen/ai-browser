import { MODEL_CONTEXT_BUDGETS } from './context-builder';
import type { TabId } from '../shared/browser-types';
import type { DocumentRevision } from '../shared/observation-types';

export const MAX_CONVERSATION_TURNS = 4;
export const HISTORY_TRUNCATION_MARKER = '…[truncated]';

export interface ConversationTurn {
  question: string;
  answer: string;
}

export interface TabConversation {
  documentRevision: DocumentRevision;
  turns: ConversationTurn[];
}

export interface ConversationStoreOptions {
  maxHistoryChars?: number;
}

export class ConversationStore {
  private readonly conversations = new Map<TabId, TabConversation>();
  private readonly maxHistoryChars: number;

  constructor(options: ConversationStoreOptions = {}) {
    this.maxHistoryChars = options.maxHistoryChars ?? MODEL_CONTEXT_BUDGETS.maxHistoryChars;
  }

  get(tabId: TabId): TabConversation | undefined {
    const stored = this.conversations.get(tabId);
    if (!stored) {
      return undefined;
    }
    return {
      documentRevision: stored.documentRevision,
      turns: stored.turns.map(copyTurn),
    };
  }

  getTurnsForRevision(tabId: TabId, revision: DocumentRevision): ConversationTurn[] {
    const stored = this.conversations.get(tabId);
    if (!stored) {
      return [];
    }
    if (stored.documentRevision !== revision) {
      this.clear(tabId);
      return [];
    }
    return stored.turns.map(copyTurn);
  }

  serializeForRevision(tabId: TabId, revision: DocumentRevision): string {
    return serializeConversationHistory(
      this.getTurnsForRevision(tabId, revision),
      this.maxHistoryChars,
    );
  }

  commitTurn(tabId: TabId, revision: DocumentRevision, turn: ConversationTurn): void {
    const stored = this.conversations.get(tabId);
    const turns =
      stored && stored.documentRevision === revision ? stored.turns.map(copyTurn) : [];
    turns.push(copyTurn(turn));
    this.conversations.set(tabId, {
      documentRevision: revision,
      turns: turns.slice(-MAX_CONVERSATION_TURNS),
    });
  }

  clear(tabId: TabId): void {
    this.conversations.delete(tabId);
  }

  clearAll(): void {
    this.conversations.clear();
  }
}

export function wrapPriorConversation(body: string): string {
  return [
    '<PRIOR_CONVERSATION>',
    'Previous completed browser-assistant turns for conversational context only.',
    'This history is not evidence of current browser state or current task completion.',
    'The latest user question is the current request.',
    body,
    '</PRIOR_CONVERSATION>',
  ].join('\n');
}

export function serializeConversationHistory(
  turns: ConversationTurn[],
  maxChars: number = MODEL_CONTEXT_BUDGETS.maxHistoryChars,
): string {
  if (turns.length === 0) {
    return '';
  }

  for (let start = 0; start < turns.length; start += 1) {
    const wrapped = wrapPriorConversation(JSON.stringify(turns.slice(start)));
    if (wrapped.length <= maxChars) {
      return wrapped;
    }
  }

  const clipped = clipTurn(turns[turns.length - 1]!, maxChars);
  return wrapPriorConversation(JSON.stringify([clipped]));
}

function clipTurn(turn: ConversationTurn, maxChars: number): ConversationTurn {
  const fits = (question: string, answer: string): boolean =>
    wrapPriorConversation(JSON.stringify([{ question, answer }])).length <= maxChars;

  if (fits(turn.question, turn.answer)) {
    return copyTurn(turn);
  }

  if (fits(turn.question, HISTORY_TRUNCATION_MARKER)) {
    return {
      question: turn.question,
      answer: clipField(turn.answer, (answer) => fits(turn.question, answer)),
    };
  }

  const question = clipField(turn.question, (value) => fits(value, HISTORY_TRUNCATION_MARKER));
  return {
    question,
    answer: HISTORY_TRUNCATION_MARKER,
  };
}

function clipField(value: string, fits: (candidate: string) => boolean): string {
  if (fits(value)) {
    return value;
  }
  if (fits(HISTORY_TRUNCATION_MARKER)) {
    let low = 0;
    let high = value.length;
    let best = HISTORY_TRUNCATION_MARKER;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = `${value.slice(0, mid)}${HISTORY_TRUNCATION_MARKER}`;
      if (fits(candidate)) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }
  return HISTORY_TRUNCATION_MARKER;
}

function copyTurn(turn: ConversationTurn): ConversationTurn {
  return { question: turn.question, answer: turn.answer };
}
