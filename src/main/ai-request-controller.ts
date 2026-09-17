import type {
  AgentAnswer,
  AgentAnswerOptions,
  AgentRequest,
} from '../ai/read-only-agent';
import type { TabId } from '../shared/browser-types';
import type {
  AiAnswerEvent,
  AiAskStartResult,
  AiCancelAskResult,
  AiClearConversationResult,
} from '../shared/ai-types';
import { isRequestCancelled, toAiSafeError } from './ai-safe-error';

export interface AiAskAgent {
  answer(request: AgentRequest, options?: AgentAnswerOptions): Promise<AgentAnswer>;
  cancel(tabId: TabId): boolean;
  clearConversation(tabId: TabId): void;
  clearAllConversations(): void;
}

export class AiRequestController {
  private readonly agent: AiAskAgent;
  private readonly emit: (event: AiAnswerEvent) => void;
  private readonly currentAsks = new Map<TabId, string>();
  private disposed = false;

  constructor(input: { agent: AiAskAgent; emit: (event: AiAnswerEvent) => void }) {
    this.agent = input.agent;
    this.emit = input.emit;
  }

  startAsk(tabId: TabId, question: string): AiAskStartResult {
    if (this.disposed) {
      return { ok: false, error: toAiSafeError(new Error('disposed')) };
    }

    const askId = crypto.randomUUID();
    this.currentAsks.set(tabId, askId);
    void this.runAsk(tabId, askId, question);
    return { ok: true, askId };
  }

  cancelAsk(tabId: TabId, askId: string): AiCancelAskResult {
    if (this.disposed || this.currentAsks.get(tabId) !== askId) {
      return { cancelled: false };
    }
    return { cancelled: this.agent.cancel(tabId) };
  }

  clearConversation(tabId: TabId): AiClearConversationResult {
    if (this.disposed) {
      return { ok: false, error: toAiSafeError(new Error('disposed')) };
    }

    this.currentAsks.delete(tabId);
    this.agent.cancel(tabId);
    this.agent.clearConversation(tabId);
    this.emit({
      type: 'conversation-cleared',
      tabId,
      reason: 'user',
    });
    return { ok: true };
  }

  handleTabClosed(tabId: TabId): void {
    if (this.disposed) {
      return;
    }
    this.currentAsks.delete(tabId);
    this.agent.cancel(tabId);
    this.agent.clearConversation(tabId);
    this.emit({
      type: 'conversation-cleared',
      tabId,
      reason: 'tab-close',
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const tabIds = [...this.currentAsks.keys()];
    this.currentAsks.clear();
    for (const tabId of tabIds) {
      this.agent.cancel(tabId);
    }
    this.agent.clearAllConversations();
  }

  private async runAsk(tabId: TabId, askId: string, question: string): Promise<void> {
    this.emitIfCurrent(tabId, askId, {
      type: 'answer-started',
      askId,
      tabId,
    });

    try {
      const answer = await this.agent.answer(
        { tabId, question },
        {
          onTextDelta: (delta) => {
            if (!delta) {
              return;
            }
            this.emitIfCurrent(tabId, askId, {
              type: 'answer-text',
              askId,
              tabId,
              delta,
            });
          },
        },
      );

      this.emitIfCurrent(tabId, askId, {
        type: 'answer-finished',
        askId,
        tabId,
        answer: {
          text: answer.text,
          truncatedContext: answer.truncatedContext,
        },
      });
    } catch (error) {
      if (isRequestCancelled(error)) {
        this.emitIfCurrent(tabId, askId, {
          type: 'answer-cancelled',
          askId,
          tabId,
        });
      } else {
        this.emitIfCurrent(tabId, askId, {
          type: 'answer-error',
          askId,
          tabId,
          error: toAiSafeError(error),
        });
      }
    } finally {
      if (this.currentAsks.get(tabId) === askId) {
        this.currentAsks.delete(tabId);
      }
    }
  }

  private emitIfCurrent(tabId: TabId, askId: string, event: AiAnswerEvent): void {
    if (this.disposed || this.currentAsks.get(tabId) !== askId) {
      return;
    }
    this.emit(event);
  }
}
