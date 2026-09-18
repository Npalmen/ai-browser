import type { BrowserAdapter } from '../browser/browser-adapter';
import { InteractiveAgent } from '../ai/interactive-agent';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
import { TargetRegistry } from '../observation/target-registry';
import type { PageState, TabId } from '../shared/browser-types';
import type { NativeSelectOption, ObservationNode, PageObservation } from '../shared/observation-types';
import { V3_TAB_ID } from './fixture-constants';

export function node(
  overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>,
): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: true,
    visible: true,
    inViewport: true,
    ...overrides,
  };
}

export function observation(
  nodes: ObservationNode[],
  overrides: Partial<PageObservation> = {},
): PageObservation {
  return {
    observationId: overrides.observationId ?? 'obs-v3-1',
    tabId: overrides.tabId ?? V3_TAB_ID,
    capturedAt: overrides.capturedAt ?? 1,
    document: {
      revision: overrides.document?.revision ?? 'rev-v3-1',
      url: overrides.document?.url ?? 'http://127.0.0.1/interaction/safe-interact.html',
      title: overrides.document?.title ?? 'V3 fixture',
      loading: false,
      mainFrameId: overrides.document?.mainFrameId ?? 'frame-1',
      ...overrides.document,
    },
    viewport: overrides.viewport ?? {
      width: 1024,
      height: 768,
      scrollX: 0,
      scrollY: 0,
      deviceScaleFactor: 1,
    },
    nodes,
    stats: overrides.stats ?? {
      sourceAxNodeCount: nodes.length,
      sourceDomNodeCount: nodes.length,
      emittedNodeCount: nodes.length,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
    ...overrides,
  };
}

export function registryRecord(
  targetId: string,
  backendNodeId: number,
  tabId: TabId = V3_TAB_ID,
  observationId = 'obs-v3-1',
  documentRevision = 'rev-v3-1',
) {
  return {
    targetId,
    tabId,
    observationId,
    documentRevision,
    frameId: 'frame-1',
    backendNodeId,
  };
}

export function pageState(tabId: TabId = V3_TAB_ID): PageState {
  return {
    tabId,
    url: 'http://127.0.0.1/interaction/safe-interact.html',
    title: 'V3 fixture',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
}

export function createFakeAdapter(options: {
  observePage?: () => Promise<PageObservation>;
  onClick?: () => void;
  onType?: () => void;
  onSelect?: (request: import('../browser/interaction-adapter-types').AdapterSelectRequest) => void;
  onScroll?: () => void;
  onScrollIntoView?: () => void;
  failObserveAfterMutation?: boolean;
} = {}): {
  adapter: BrowserAdapter;
  counts: {
    click: number;
    type: number;
    select: number;
    scroll: number;
    scrollIntoView: number;
    observePage: number;
  };
} {
  const counts = {
    click: 0,
    type: 0,
    select: 0,
    scroll: 0,
    scrollIntoView: 0,
    observePage: 0,
  };

  const adapter: BrowserAdapter = {
    createTab: async () => V3_TAB_ID,
    closeTab: async () => undefined,
    activateTab: async () => undefined,
    navigate: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    getPageState: async () => pageState(),
    observePage: async () => {
      counts.observePage += 1;
      if (options.failObserveAfterMutation) {
        throw new Error('post-action observation failed');
      }
      if (options.observePage) {
        return options.observePage();
      }
      return observation([
        node({
          role: 'button',
          tag: 'button',
          targetId: 'target-after',
          name: 'After',
          attributes: { type: 'button' },
        }),
      ], { document: { revision: 'rev-v3-2', url: 'http://127.0.0.1', title: 'After', loading: false, mainFrameId: 'frame-1' } });
    },
    click: async () => {
      counts.click += 1;
      options.onClick?.();
      return { primitive: 'click' };
    },
    type: async () => {
      counts.type += 1;
      options.onType?.();
      return { primitive: 'type' };
    },
    select: async (request) => {
      counts.select += 1;
      options.onSelect?.(request);
      return { primitive: 'select' };
    },
    scroll: async () => {
      counts.scroll += 1;
      options.onScroll?.();
      return { primitive: 'scroll' };
    },
    scrollIntoView: async () => {
      counts.scrollIntoView += 1;
      options.onScrollIntoView?.();
      return { primitive: 'scroll' };
    },
  };

  return { adapter, counts };
}

export function createInteractiveChain(input: {
  adapter: BrowserAdapter;
  targetRegistry: TargetRegistry;
  audit?: InMemoryInteractionAuditSink;
  runtime: import('./recording-interaction-model-runtime').RecordingInteractionModelRuntime;
  observation: PageObservation | PageObservation[];
}) {
  const audit = input.audit ?? new InMemoryInteractionAuditSink();
  const executor = new InteractionExecutor({
    adapter: input.adapter,
    targetRegistry: input.targetRegistry,
    audit,
    generateActionId: () => 'action-v3-1',
    now: () => 1,
  });
  const pages = Array.isArray(input.observation) ? input.observation : [input.observation];
  let callIndex = 0;
  const agent = new InteractiveAgent({
    observationSource: {
      observePage: async () => {
        const page = pages[Math.min(callIndex, pages.length - 1)] ?? pages[pages.length - 1];
        callIndex += 1;
        if (!page) {
          throw new Error('No observation scripted');
        }
        return page;
      },
    },
    modelRuntime: input.runtime,
    interactionExecutor: executor,
    allowScreenshotExport: false,
  });
  return { agent, executor, audit };
}

export function nativeSelectNodes(
  selectTargetId: string,
  options: Array<{ targetId: string; name: string; selected?: true }>,
): ObservationNode[] {
  const nativeOptions: NativeSelectOption[] = options.map((option) => ({
    targetId: option.targetId,
    name: option.name,
    ...(option.selected ? { selected: true } : {}),
  }));
  return [
    node({
      role: 'combobox',
      tag: 'select',
      targetId: selectTargetId,
      name: 'Color',
      nativeOptions,
    }),
    ...options.map((option) =>
      node({
        role: 'option',
        tag: 'option',
        targetId: option.targetId,
        name: option.name,
        ...(option.selected ? { states: { selected: true } } : {}),
      }),
    ),
  ];
}
