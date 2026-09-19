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

export interface AiAgentRunPort {
  start(
    tabId: TabId,
    instruction: string,
    options: { readonly askId: string },
  ): Promise<
    | {
        readonly status: 'started';
        readonly run: { readonly runId: string };
        readonly completion: Promise<unknown>;
      }
    | {
        readonly status: 'ignored';
      }
  >;
  cancel(tabId: TabId, reason?: 'USER_CANCELLED' | 'SUPERSEDED'): boolean;
  cancelActive(tabId: TabId, reason?: 'USER_CANCELLED' | 'SUPERSEDED'): Promise<void>;
  clearConversation(tabId: TabId): void;
  handleTabClosed(tabId: TabId): void;
  handleRendererCrash(tabId: TabId): void;
  dispose(): void;
}

interface TabAskState {
  askId: string;
  mode: AiRequestMode;
  runId?: string;
}

export class AiRequestController {
  private readonly readAgent: AiReadAgent;
  private readonly interactiveAgent: AiInteractionAgent | undefined;
  private readonly agentRuns: AiAgentRunPort | undefined;
  private readonly emit: (event: AiAnswerEvent) => void;
  private readonly invalidateApprovalsForTab?: (tabId: TabId) => void;
  private readonly currentAsks = new Map<TabId, TabAskState>();
  private disposed = false;

  constructor(input: {
    readAgent: AiReadAgent;
    interactiveAgent?: AiInteractionAgent;
    agentRuns?: AiAgentRunPort;
    emit: (event: AiAnswerEvent) => void;
    invalidateApprovalsForTab?: (tabId: TabId) => void;
  }) {
    this.readAgent = input.readAgent;
    this.interactiveAgent = input.interactiveAgent;
    this.agentRuns = input.agentRuns;
    this.emit = input.emit;
    this.invalidateApprovalsForTab = input.invalidateApprovalsForTab;
  }

  startAsk(tabId: TabId, question: string, mode: AiRequestMode): AiAskStartResult {
    if (this.disposed) {
      return { ok: false, error: toAiSafeError(new Error('disposed')) };
    }

    if (this.agentRuns) {
      this.readAgent.cancel(tabId);
      if (mode === 'read') {
        this.agentRuns.cancel(tabId, 'SUPERSEDED');
      }
    } else {
      this.invalidateApprovalsForTab?.(tabId);
      this.cancelCurrentAgent(tabId);
    }

    const askId = crypto.randomUUID();
    this.currentAsks.set(tabId, { askId, mode });
    if (mode === 'read') {
      void this.runReadAsk(tabId, askId, question);
    } else if (this.agentRuns) {
      void this.runAgentRunAsk(tabId, askId, question);
    } else {
      void this.runInteractAsk(tabId, askId, question);
    }
    return { ok: true, askId };
  }

  getActivitySnapshot(): readonly { readonly tabId: TabId; readonly mode: AiRequestMode }[] {
    if (this.disposed) {
      return [];
    }
    return [...this.currentAsks.entries()].map(([tabId, state]) => ({
      tabId,
      mode: state.mode,
    }));
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

    if (this.agentRuns) {
      this.agentRuns.clearConversation(tabId);
    } else {
      this.cancelCurrentAgent(tabId);
    }
    this.invalidateApprovalsForTab?.(tabId);
    this.currentAsks.delete(tabId);
    this.readAgent.clearConversation(tabId);
    this.interactiveAgent?.clearConversation(tabId);
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
    this.readAgent.cancel(tabId);
    if (this.agentRuns) {
      this.agentRuns.handleTabClosed(tabId);
    } else {
      this.cancelCurrentAgent(tabId);
    }
    this.invalidateApprovalsForTab?.(tabId);
    this.currentAsks.delete(tabId);
    this.readAgent.clearConversation(tabId);
    this.interactiveAgent?.clearConversation(tabId);
    this.emit({
      type: 'conversation-cleared',
      tabId,
      reason: 'tab-close',
    });
  }

  handleRendererCrash(tabId: TabId): void {
    if (this.disposed) {
      return;
    }
    this.readAgent.cancel(tabId);
    this.interactiveAgent?.cancel(tabId);
    this.agentRuns?.handleRendererCrash(tabId);
    this.currentAsks.delete(tabId);
    this.readAgent.clearConversation(tabId);
    this.interactiveAgent?.clearConversation(tabId);
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
      this.interactiveAgent?.cancel(tabId);
    }
    this.agentRuns?.dispose();
    this.readAgent.clearAllConversations();
    this.interactiveAgent?.clearAllConversations();
  }

  private cancelCurrentAgent(tabId: TabId): void {
    const current = this.currentAsks.get(tabId);
    if (!current) {
      if (this.agentRuns) {
        this.agentRuns.cancel(tabId, 'SUPERSEDED');
      }
      return;
    }
    this.cancelAgentForMode(tabId, current.mode);
  }

  private cancelAgentForMode(tabId: TabId, mode: AiRequestMode): boolean {
    if (mode === 'read') {
      return this.readAgent.cancel(tabId);
    }
    if (this.agentRuns) {
      return this.agentRuns.cancel(tabId, 'USER_CANCELLED');
    }
    return this.interactiveAgent?.cancel(tabId) ?? false;
  }

  private async runReadAsk(tabId: TabId, askId: string, question: string): Promise<void> {
    if (this.agentRuns) {
      await this.agentRuns.cancelActive(tabId, 'SUPERSEDED');
      if (this.currentAsks.get(tabId)?.askId !== askId) {
        return;
      }
    }

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

  private async runAgentRunAsk(tabId: TabId, askId: string, question: string): Promise<void> {
    if (!this.agentRuns) {
      return;
    }
    try {
      const started = await this.agentRuns.start(tabId, question, { askId });
      if (this.currentAsks.get(tabId)?.askId !== askId) {
        return;
      }
      if (started.status === 'ignored') {
        this.emitIfCurrent(tabId, askId, {
          type: 'answer-cancelled',
          askId,
          tabId,
        });
        return;
      }
      this.currentAsks.set(tabId, { askId, mode: 'interact', runId: started.run.runId });
      await started.completion;
    } finally {
      if (this.currentAsks.get(tabId)?.askId === askId) {
        this.currentAsks.delete(tabId);
      }
    }
  }

  private async runInteractAsk(tabId: TabId, askId: string, question: string): Promise<void> {
    if (!this.interactiveAgent) {
      this.emitIfCurrent(tabId, askId, {
        type: 'answer-error',
        askId,
        tabId,
        error: toAiSafeError(new Error('Interactive agent is not configured.')),
      });
      if (this.currentAsks.get(tabId)?.askId === askId) {
        this.currentAsks.delete(tabId);
      }
      return;
    }

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
      if (interaction.status === 'approval-required') {
        this.emitIfCurrent(tabId, askId, {
          type: 'interaction-approval-required',
          askId,
          tabId,
          truncatedContext: result.truncatedContext,
        });
        return;
      }

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
