import type {
  AgentAnswer,
  AgentAnswerOptions,
  AgentRequest,
} from '../ai/read-only-agent';
import type {
  InteractiveAgentOptions,
  InteractiveAgentRequest,
  InteractiveAgentResult,
} from '../ai/interactive-agent';
import type { TabId } from '../shared/browser-types';
import { InteractionError } from '../shared/interaction-errors';
import type {
  AiAnswerEvent,
  AiAskStartResult,
  AiCancelAskResult,
  AiClearConversationResult,
  AiRequestMode,
} from '../shared/ai-types';
import {
  isRequestCancelled,
  toAiSafeError,
  toAiSafeErrorFromInteractionCode,
} from './ai-safe-error';

export interface AiReadAgent {
  answer(request: AgentRequest, options?: AgentAnswerOptions): Promise<AgentAnswer>;
  cancel(tabId: TabId): boolean;
  clearConversation(tabId: TabId): void;
  clearAllConversations(): void;
}

export interface AiInteractionAgent {
  interact(
    request: InteractiveAgentRequest,
    options?: InteractiveAgentOptions,
  ): Promise<InteractiveAgentResult>;
  cancel(tabId: TabId): boolean;
  clearConversation(tabId: TabId): void;
  clearAllConversations(): void;
}

interface TabAskState {
  askId: string;
  mode: AiRequestMode;
}

export class AiRequestController {
  private readonly readAgent: AiReadAgent;
  private readonly interactiveAgent: AiInteractionAgent;
  private readonly emit: (event: AiAnswerEvent) => void;
  private readonly currentAsks = new Map<TabId, TabAskState>();
  private disposed = false;

  constructor(input: {
    readAgent: AiReadAgent;
    interactiveAgent: AiInteractionAgent;
    emit: (event: AiAnswerEvent) => void;
  }) {
    this.readAgent = input.readAgent;
    this.interactiveAgent = input.interactiveAgent;
    this.emit = input.emit;
  }

  startAsk(tabId: TabId, question: string, mode: AiRequestMode): AiAskStartResult {
    if (this.disposed) {
      return { ok: false, error: toAiSafeError(new Error('disposed')) };
    }

    this.cancelCurrentAgent(tabId);
    const askId = crypto.randomUUID();
    this.currentAsks.set(tabId, { askId, mode });
    if (mode === 'read') {
      void this.runReadAsk(tabId, askId, question);
    } else {
      void this.runInteractAsk(tabId, askId, question);
    }
    return { ok: true, askId };
  }

  cancelAsk(tabId: TabId, askId: string): AiCancelAskResult {
    const current = this.currentAsks.get(tabId);
    if (this.disposed || !current || current.askId !== askId) {
      return { cancelled: false };
    }
    return { cancelled: this.cancelAgentForMode(tabId, current.mode) };
  }

  clearConversation(tabId: TabId): AiClearConversationResult {
    if (this.disposed) {
      return { ok: false, error: toAiSafeError(new Error('disposed')) };
    }

    this.cancelCurrentAgent(tabId);
    this.currentAsks.delete(tabId);
    this.readAgent.clearConversation(tabId);
    this.interactiveAgent.clearConversation(tabId);
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
    this.cancelCurrentAgent(tabId);
    this.currentAsks.delete(tabId);
    this.readAgent.clearConversation(tabId);
    this.interactiveAgent.clearConversation(tabId);
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
      this.readAgent.cancel(tabId);
      this.interactiveAgent.cancel(tabId);
    }
    this.readAgent.clearAllConversations();
    this.interactiveAgent.clearAllConversations();
  }

  private cancelCurrentAgent(tabId: TabId): void {
    const current = this.currentAsks.get(tabId);
    if (!current) {
      return;
    }
    this.cancelAgentForMode(tabId, current.mode);
  }

  private cancelAgentForMode(tabId: TabId, mode: AiRequestMode): boolean {
    return mode === 'read'
      ? this.readAgent.cancel(tabId)
      : this.interactiveAgent.cancel(tabId);
  }

  private async runReadAsk(tabId: TabId, askId: string, question: string): Promise<void> {
    this.emitIfCurrent(tabId, askId, {
      type: 'answer-started',
      askId,
      tabId,
    });

    try {
      const answer = await this.readAgent.answer(
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
      if (this.currentAsks.get(tabId)?.askId === askId) {
        this.currentAsks.delete(tabId);
      }
    }
  }

  private async runInteractAsk(tabId: TabId, askId: string, question: string): Promise<void> {
    this.emitIfCurrent(tabId, askId, {
      type: 'interaction-started',
      askId,
      tabId,
    });

    try {
      const result = await this.interactiveAgent.interact(
        { tabId, instruction: question },
        {
          onAnswerTextDelta: (delta) => {
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

      if (result.kind === 'answer') {
        this.emitIfCurrent(tabId, askId, {
          type: 'answer-finished',
          askId,
          tabId,
          answer: {
            text: result.text,
            truncatedContext: result.truncatedContext,
          },
        });
        return;
      }

      const interaction = result.result;
      if (interaction.status === 'succeeded') {
        this.emitIfCurrent(tabId, askId, {
          type: 'interaction-completed',
          askId,
          tabId,
          truncatedContext: result.truncatedContext,
        });
        return;
      }

      const error = toAiSafeErrorFromInteractionCode(interaction.errorCode);
      if (interaction.status === 'denied') {
        this.emitIfCurrent(tabId, askId, {
          type: 'interaction-denied',
          askId,
          tabId,
          error,
          truncatedContext: result.truncatedContext,
        });
        return;
      }

      this.emitIfCurrent(tabId, askId, {
        type: 'interaction-failed',
        askId,
        tabId,
        error,
        truncatedContext: result.truncatedContext,
      });
    } catch (error) {
      if (isRequestCancelled(error)) {
        this.emitIfCurrent(tabId, askId, {
          type: 'answer-cancelled',
          askId,
          tabId,
        });
      } else if (error instanceof InteractionError && isInteractionDenial(error.code)) {
        this.emitIfCurrent(tabId, askId, {
          type: 'interaction-denied',
          askId,
          tabId,
          error: toAiSafeError(error),
          truncatedContext: false,
        });
      } else if (error instanceof InteractionError) {
        this.emitIfCurrent(tabId, askId, {
          type: 'interaction-failed',
          askId,
          tabId,
          error: toAiSafeError(error),
          truncatedContext: false,
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
      if (this.currentAsks.get(tabId)?.askId === askId) {
        this.currentAsks.delete(tabId);
      }
    }
  }

  private emitIfCurrent(tabId: TabId, askId: string, event: AiAnswerEvent): void {
    if (this.disposed || this.currentAsks.get(tabId)?.askId !== askId) {
      return;
    }
    this.emit(event);
  }
}

function isInteractionDenial(code: InteractionError['code']): boolean {
  return code === 'INTERACTION_DENIED' || code === 'DEFERRED_TO_EXECUTE';
}
