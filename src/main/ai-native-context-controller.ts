import {
  assertBrowserContextSnapshotStillCurrent,
  buildBrowserContextBundle,
} from '../ai-native/browser-context-builder';
import type { BrowserContextBundle } from '../ai-native/browser-context-types';
import { MultiTabReadOnlyAgent } from '../ai-native/multi-tab-read-only-agent';
import type { MultiTabObservationSource } from '../ai-native/browser-context-builder';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import type {
  AiNativeContextAnswerEvent,
  AiNativeContextAskInput,
  AiNativeContextAskStartResult,
  AiNativeContextCancelAskResult,
} from '../shared/ai-native-types';
import type { BrowserState } from '../shared/browser-types';
import { isAiNativeContextCancelled, toAiNativeContextError } from './ai-native-context-error';

export interface AiNativeContextControllerDependencies {
  observationSource: MultiTabObservationSource;
  multiTabAgent: MultiTabReadOnlyAgent;
  getBrowserState: () => BrowserState;
  emit: (event: AiNativeContextAnswerEvent) => void;
}

interface ActiveAsk {
  askId: string;
  controller: AbortController;
}

export class AiNativeContextController {
  private readonly observationSource: MultiTabObservationSource;
  private readonly multiTabAgent: MultiTabReadOnlyAgent;
  private readonly getBrowserState: () => BrowserState;
  private readonly emit: (event: AiNativeContextAnswerEvent) => void;
  private activeAsk: ActiveAsk | null = null;
  private disposed = false;

  constructor(dependencies: AiNativeContextControllerDependencies) {
    this.observationSource = dependencies.observationSource;
    this.multiTabAgent = dependencies.multiTabAgent;
    this.getBrowserState = dependencies.getBrowserState;
    this.emit = dependencies.emit;
  }

  startAsk(input: AiNativeContextAskInput): AiNativeContextAskStartResult {
    if (this.disposed) {
      return { ok: false, error: aiNativeSafeError('AI_NATIVE_NOT_AVAILABLE') };
    }

    this.supersedeActiveAsk();

    const askId = crypto.randomUUID();
    const controller = new AbortController();
    this.activeAsk = { askId, controller };
    void this.runAsk(askId, input, controller);
    return { ok: true, askId };
  }

  hasActiveAsk(): boolean {
    return !this.disposed && this.activeAsk !== null;
  }

  cancelContextAsk(askId: string): AiNativeContextCancelAskResult {
    if (this.disposed || !this.activeAsk || this.activeAsk.askId !== askId) {
      return { cancelled: false };
    }
    this.activeAsk.controller.abort();
    return { cancelled: true };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.activeAsk) {
      this.activeAsk.controller.abort();
      this.activeAsk = null;
    }
  }

  private supersedeActiveAsk(): void {
    if (!this.activeAsk) {
      return;
    }
    const previous = this.activeAsk;
    this.activeAsk = null;
    previous.controller.abort();
  }

  private clearActiveIfCurrent(askId: string): void {
    if (this.activeAsk?.askId === askId) {
      this.activeAsk = null;
    }
  }

  private isStaleAsk(askId: string, controller: AbortController): boolean {
    return this.activeAsk?.askId !== askId || controller.signal.aborted;
  }

  private assertSelectedContextStillCurrent(bundle: BrowserContextBundle): void {
    // Same-URL reloads remain undetectable: BrowserState exposes URL, not document revision.
    // This synchronous check must run immediately before answer() so there is no await
    // between live validation and the agent's synchronous path to ModelRuntime.generate.
    assertBrowserContextSnapshotStillCurrent(this.getBrowserState(), bundle.sourceSnapshot);
  }

  private async runAsk(
    askId: string,
    input: AiNativeContextAskInput,
    controller: AbortController,
  ): Promise<void> {
    this.emit({ type: 'context-answer-started', askId });
    let terminal: 'finished' | 'cancelled' | 'error' | null = null;

    try {
      const bundle = await buildBrowserContextBundle({
        tabIds: input.context.tabIds,
        getBrowserState: this.getBrowserState,
        observationSource: this.observationSource,
        signal: controller.signal,
      });

      if (this.isStaleAsk(askId, controller)) {
        terminal = 'cancelled';
        return;
      }

      this.assertSelectedContextStillCurrent(bundle);
      const answer = await this.multiTabAgent.answer(
        {
          bundle,
          question: input.question,
          abortSignal: controller.signal,
        },
        {
          onTextDelta: (delta) => {
            if (this.isStaleAsk(askId, controller)) {
              return;
            }
            this.emit({ type: 'context-answer-text', askId, delta });
          },
        },
      );

      if (this.isStaleAsk(askId, controller)) {
        terminal = 'cancelled';
        return;
      }

      this.emit({
        type: 'context-answer-finished',
        askId,
        answer: {
          text: answer.text,
          truncatedContext: answer.truncatedContext,
        },
      });
      terminal = 'finished';
    } catch (error) {
      if (
        this.isStaleAsk(askId, controller) ||
        controller.signal.aborted ||
        isAiNativeContextCancelled(error)
      ) {
        terminal = 'cancelled';
      } else {
        this.emit({
          type: 'context-answer-error',
          askId,
          error: toAiNativeContextError(error),
        });
        terminal = 'error';
      }
    } finally {
      if (terminal === 'cancelled') {
        this.emit({ type: 'context-answer-cancelled', askId });
      }
      if (terminal !== null) {
        this.clearActiveIfCurrent(askId);
      }
    }
  }
}
