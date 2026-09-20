import { InteractionError } from '../shared/interaction-errors';

export interface NavigationMarker {
  readonly tabId: string;
  readonly generation: number;
  readonly popupGeneration: number;
}

export type NavigationWaitKind = 'main-frame' | 'same-document' | 'popup';

export type NavigationWaitResult =
  | {
      readonly status: 'settled';
      readonly kind: 'main-frame' | 'same-document';
      readonly generation: number;
    }
  | {
      readonly status: 'settled';
      readonly kind: 'popup';
      readonly generation: number;
      readonly sourceTabId: string;
      readonly destinationTabId: string;
      readonly causedByAgentInputDispatch: boolean;
    }
  | {
      readonly status: 'timeout';
      readonly started: boolean;
    }
  | {
      readonly status: 'cancelled';
    };

export interface CausalPopupOpened {
  readonly sourceTabId: string;
  readonly destinationTabId: string;
  readonly causedByAgentInputDispatch: boolean;
}

export interface NavigationWaitOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
}

export interface NavigationLifecyclePort {
  captureNavigationMarker(tabId: string): NavigationMarker;
  waitForNavigationAfter(
    tabId: string,
    marker: NavigationMarker,
    options: NavigationWaitOptions,
  ): Promise<NavigationWaitResult>;
}

interface RecordedPopup {
  generation: number;
  destinationTabId: string;
  causedByAgentInputDispatch: boolean;
}

interface TabNavigationState {
  generation: number;
  settledGeneration: number;
  inflightGeneration: number | null;
  popupGeneration: number;
  popups: RecordedPopup[];
  lastKind: NavigationWaitKind;
  sameDocumentPending: boolean;
}

type Waiter = () => void;

export class TabNavigationLifecycle {
  private readonly tabs = new Map<string, TabNavigationState>();
  private readonly waiters = new Set<Waiter>();

  captureMarker(tabId: string): NavigationMarker {
    const state = this.ensure(tabId);
    return {
      tabId,
      generation: state.generation,
      popupGeneration: state.popupGeneration,
    };
  }

  noteMainFrameNavigationStart(tabId: string, options?: { sameDocument?: boolean }): void {
    const state = this.ensure(tabId);
    state.generation += 1;
    if (options?.sameDocument === true) {
      state.inflightGeneration = null;
      state.settledGeneration = state.generation;
      state.lastKind = 'same-document';
      state.sameDocumentPending = true;
    } else {
      state.inflightGeneration = state.generation;
      state.lastKind = 'main-frame';
      state.sameDocumentPending = false;
    }
    this.notify();
  }

  noteMainFrameNavigationCommitted(tabId: string): void {
    const state = this.ensure(tabId);
    if (state.inflightGeneration === null && state.sameDocumentPending !== true) {
      state.generation += 1;
      state.inflightGeneration = state.generation;
      state.lastKind = 'main-frame';
    }
    this.notify();
  }

  noteMainFrameNavigationSettled(tabId: string): void {
    const state = this.ensure(tabId);
    if (state.inflightGeneration === null) {
      return;
    }
    state.settledGeneration = state.inflightGeneration;
    state.inflightGeneration = null;
    this.notify();
  }

  noteSameDocumentNavigation(tabId: string): void {
    const state = this.ensure(tabId);
    if (state.sameDocumentPending && state.lastKind === 'same-document') {
      state.sameDocumentPending = false;
      this.notify();
      return;
    }
    state.generation += 1;
    state.inflightGeneration = null;
    state.settledGeneration = state.generation;
    state.lastKind = 'same-document';
    state.sameDocumentPending = false;
    this.notify();
  }

  notePopupOpenedFrom(input: CausalPopupOpened): void {
    const state = this.ensure(input.sourceTabId);
    state.popupGeneration += 1;
    state.popups.push({
      generation: state.popupGeneration,
      destinationTabId: input.destinationTabId,
      causedByAgentInputDispatch: input.causedByAgentInputDispatch,
    });
    this.ensure(input.destinationTabId);
    this.notify();
  }

  removeTab(tabId: string): void {
    this.tabs.delete(tabId);
    this.notify();
  }

  clear(): void {
    this.tabs.clear();
    this.notify();
  }

  waitForNavigationAfter(
    tabId: string,
    marker: NavigationMarker,
    options: NavigationWaitOptions,
  ): Promise<NavigationWaitResult> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (result: NavigationWaitResult): void => {
        if (finished) {
          return;
        }
        finished = true;
        cleanup();
        resolve(result);
      };

      const check = (): void => {
        const state = this.tabs.get(tabId) ?? this.ensure(tabId);
        const popup = state.popups.find((entry) => entry.generation > marker.popupGeneration);
        if (popup !== undefined) {
          const destination = this.tabs.get(popup.destinationTabId);
          if (isDestinationUsable(destination)) {
            finish({
              status: 'settled',
              kind: 'popup',
              generation: state.generation,
              sourceTabId: tabId,
              destinationTabId: popup.destinationTabId,
              causedByAgentInputDispatch: popup.causedByAgentInputDispatch,
            });
          }
          return;
        }
        if (
          state.generation > marker.generation &&
          state.settledGeneration > marker.generation &&
          state.inflightGeneration === null
        ) {
          finish({
            status: 'settled',
            kind: state.lastKind === 'popup' ? 'main-frame' : state.lastKind,
            generation: state.generation,
          });
        }
      };

      const onAbort = (): void => {
        finish({ status: 'cancelled' });
      };

      const timer = setTimeout(() => {
        const state = this.tabs.get(tabId);
        const started =
          state !== undefined &&
          (state.generation > marker.generation || state.popupGeneration > marker.popupGeneration);
        finish({ status: 'timeout', started });
      }, Math.max(0, options.timeoutMs));

      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
        options.signal?.removeEventListener('abort', onAbort);
      };

      if (options.signal?.aborted) {
        cleanup();
        resolve({ status: 'cancelled' });
        return;
      }

      options.signal?.addEventListener('abort', onAbort);
      this.waiters.add(check);
      check();
    });
  }

  private ensure(tabId: string): TabNavigationState {
    const existing = this.tabs.get(tabId);
    if (existing) {
      return existing;
    }
    const created: TabNavigationState = {
      generation: 0,
      settledGeneration: 0,
      inflightGeneration: null,
      popupGeneration: 0,
      popups: [],
      lastKind: 'main-frame',
      sameDocumentPending: false,
    };
    this.tabs.set(tabId, created);
    return created;
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }
}

function isDestinationUsable(state: TabNavigationState | undefined): boolean {
  return (
    state !== undefined &&
    state.settledGeneration > 0 &&
    state.inflightGeneration === null
  );
}

export function getNavigationLifecycle(
  adapter: object,
): NavigationLifecyclePort | undefined {
  const candidate = adapter as Partial<NavigationLifecyclePort>;
  if (
    typeof candidate.captureNavigationMarker === 'function' &&
    typeof candidate.waitForNavigationAfter === 'function'
  ) {
    return candidate as NavigationLifecyclePort;
  }
  return undefined;
}

export function navigationWaitToError(
  result: Extract<NavigationWaitResult, { status: 'timeout' | 'cancelled' }>,
): InteractionError {
  if (result.status === 'cancelled') {
    return new InteractionError('REQUEST_CANCELLED', 'Interaction request was cancelled.');
  }
  return new InteractionError(
    'INTERACTION_TIMEOUT',
    result.started
      ? 'Navigation started but did not settle.'
      : 'No navigation transition was observed after dispatch.',
  );
}
