import {
  assertBrowserContextSnapshotStillCurrent,
  buildBrowserContextBundle,
} from '../ai-native/browser-context-builder';
import type { MultiTabObservationSource } from '../ai-native/browser-context-builder';
import type { BrowserContextBundle } from '../ai-native/browser-context-types';
import { WorkflowDraftAgent } from '../ai-native/workflow-draft-agent';
import { WorkflowDraftValidationError } from '../ai-native/workflow-draft';
import { ModelError } from '../ai/model-errors';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import type {
  AiNativeWorkflowDraftInput,
  AiNativeWorkflowDraftResult,
  BrowserContextScope,
} from '../shared/ai-native-types';
import type { BrowserState, TabId } from '../shared/browser-types';
import { ObservationError } from '../shared/observation-types';
import { isAiNativeContextCancelled, toAiNativeContextError } from './ai-native-context-error';

export interface AiNativeWorkflowDraftControllerDependencies {
  observationSource: MultiTabObservationSource;
  agent: WorkflowDraftAgent;
  getBrowserState: () => BrowserState;
  now?: () => Date;
  defaultTimeZone?: () => string;
}

interface ActiveGeneration {
  generationId: string;
  controller: AbortController;
}

export class AiNativeWorkflowDraftController {
  private readonly observationSource: MultiTabObservationSource;
  private readonly agent: WorkflowDraftAgent;
  private readonly getBrowserState: () => BrowserState;
  private readonly now: () => Date;
  private readonly defaultTimeZone: () => string;
  private active: ActiveGeneration | null = null;
  private disposed = false;

  constructor(dependencies: AiNativeWorkflowDraftControllerDependencies) {
    this.observationSource = dependencies.observationSource;
    this.agent = dependencies.agent;
    this.getBrowserState = dependencies.getBrowserState;
    this.now = dependencies.now ?? (() => new Date());
    this.defaultTimeZone = dependencies.defaultTimeZone ?? readDefaultTimeZone;
  }

  async generate(input: AiNativeWorkflowDraftInput): Promise<AiNativeWorkflowDraftResult> {
    if (this.disposed) {
      return { ok: false, error: aiNativeSafeError('AI_NATIVE_NOT_AVAILABLE') };
    }

    this.supersedeActive();
    const generationId = crypto.randomUUID();
    const controller = new AbortController();
    this.active = { generationId, controller };

    try {
      const built = await this.buildPages(input.context, controller.signal);
      if (this.isStale(generationId, controller)) {
        return { ok: false, error: aiNativeSafeError('AI_NATIVE_REQUEST_CANCELLED') };
      }
      if (built.snapshot) {
        this.assertSnapshotStillCurrent(built.snapshot);
      }

      const result = await this.agent.generate({
        instruction: input.instruction,
        pages: built.pages,
        now: this.now(),
        defaultTimeZone: this.defaultTimeZone(),
        abortSignal: controller.signal,
      });

      if (this.isStale(generationId, controller)) {
        return { ok: false, error: aiNativeSafeError('AI_NATIVE_REQUEST_CANCELLED') };
      }

      return { ok: true, draft: result.draft };
    } catch (error) {
      if (this.isStale(generationId, controller) || isAiNativeContextCancelled(error)) {
        return { ok: false, error: aiNativeSafeError('AI_NATIVE_REQUEST_CANCELLED') };
      }
      return { ok: false, error: toWorkflowDraftError(error) };
    } finally {
      if (this.active?.generationId === generationId) {
        this.active = null;
      }
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.active) {
      this.active.controller.abort();
      this.active = null;
    }
  }

  private supersedeActive(): void {
    if (!this.active) {
      return;
    }
    const previous = this.active;
    this.active = null;
    previous.controller.abort();
  }

  private isStale(generationId: string, controller: AbortController): boolean {
    return this.disposed || this.active?.generationId !== generationId || controller.signal.aborted;
  }

  private async buildPages(
    context: BrowserContextScope,
    signal: AbortSignal,
  ): Promise<{
    pages: readonly { tabId: TabId; serializedContext: string }[];
    snapshot: BrowserContextBundle['sourceSnapshot'] | null;
  }> {
    if (context.kind === 'current-tab') {
      return this.buildCurrentTabPages(context.tabId, signal);
    }
    const bundle = await buildBrowserContextBundle({
      tabIds: context.tabIds,
      getBrowserState: this.getBrowserState,
      observationSource: this.observationSource,
      signal,
    });
    return {
      snapshot: bundle.sourceSnapshot,
      pages: bundle.pages.map((page) => ({
        tabId: page.tabId,
        serializedContext: page.serializedContext,
      })),
    };
  }

  private async buildCurrentTabPages(
    tabId: TabId,
    signal: AbortSignal,
  ): Promise<{
    pages: readonly { tabId: TabId; serializedContext: string }[];
    snapshot: BrowserContextBundle['sourceSnapshot'] | null;
  }> {
    const browserState = this.getBrowserState();
    if (browserState.activeTabId !== tabId) {
      throw new ObservationError('TAB_NOT_FOUND', 'Current tab is not active.');
    }
    const tab = browserState.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) {
      throw new ObservationError('TAB_NOT_FOUND', 'Current tab was not found.');
    }
    if (tab.url === 'about:blank') {
      return { pages: [], snapshot: null };
    }
    const bundle = await buildBrowserContextBundle({
      tabIds: [tabId],
      getBrowserState: this.getBrowserState,
      observationSource: this.observationSource,
      signal,
    });
    return {
      snapshot: bundle.sourceSnapshot,
      pages: bundle.pages.map((page) => ({
        tabId: page.tabId,
        serializedContext: page.serializedContext,
      })),
    };
  }

  private assertSnapshotStillCurrent(snapshot: BrowserContextBundle['sourceSnapshot']): void {
    // Same-URL reloads remain undetectable: BrowserState exposes URL, not document revision.
    // This synchronous check must run immediately before agent.generate() so there is no await
    // between live validation and the agent's synchronous path to the first model call.
    assertBrowserContextSnapshotStillCurrent(this.getBrowserState(), snapshot);
  }
}

function readDefaultTimeZone(): string {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof timeZone === 'string' && timeZone.length > 0) {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return timeZone;
    }
  } catch {
    // Trusted drafting context may fall back to UTC; the resulting schedule stays editable.
  }
  return 'UTC';
}

function toWorkflowDraftError(error: unknown) {
  if (error instanceof WorkflowDraftValidationError) {
    return aiNativeSafeError('AI_NATIVE_DRAFT_INVALID');
  }
  if (error instanceof ModelError) {
    if (error.code === 'MODEL_OUTPUT_INVALID') {
      return aiNativeSafeError('AI_NATIVE_DRAFT_INVALID');
    }
    if (error.code === 'CONTEXT_TOO_LARGE') {
      return aiNativeSafeError('AI_NATIVE_CONTEXT_TOO_LARGE');
    }
    if (error.code === 'REQUEST_CANCELLED') {
      return aiNativeSafeError('AI_NATIVE_REQUEST_CANCELLED');
    }
    return aiNativeSafeError('AI_NATIVE_DRAFT_FAILED');
  }
  if (error instanceof ObservationError) {
    return aiNativeSafeError('AI_NATIVE_CONTEXT_UNAVAILABLE');
  }
  const mapped = toAiNativeContextError(error);
  if (mapped.code === 'AI_NATIVE_MODEL_FAILED') {
    return aiNativeSafeError('AI_NATIVE_DRAFT_FAILED');
  }
  return mapped;
}
