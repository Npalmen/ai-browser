import { InteractiveAgent } from '../ai/interactive-agent';
import { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import { InMemoryApprovalAuditSink } from '../approval/approval-audit';
import { ApprovalManager } from '../approval/approval-manager';
import { ExecuteExecutor } from '../approval/execute-executor';
import { InteractionCoordinator } from '../approval/interaction-coordinator';
import { PrepareActionService } from '../approval/prepare-action-service';
import type { BrowserAdapter } from '../browser/browser-adapter';
import type { AdapterClickRequest } from '../browser/interaction-adapter-types';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
import { ApprovalController } from '../main/approval-controller';
import { ApprovalLifecycle } from '../main/approval-lifecycle';
import { ApprovalWorkflowController } from '../main/approval-workflow-controller';
import { AiRequestController } from '../main/ai-request-controller';
import { TargetRegistry } from '../observation/target-registry';
import type { ApprovalEvent } from '../shared/approval-types';
import type { AiAnswerEvent } from '../shared/ai-types';
import type { TabId } from '../shared/browser-types';
import type { ObservePageOptions, ObservationNode, PageObservation } from '../shared/observation-types';
import { RecordingInteractionModelRuntime } from '../v3-acceptance/recording-interaction-model-runtime';
import {
  node,
  observation,
  pageState,
  registryRecord,
} from '../v3-acceptance/chain-fixtures';
import { V4_TAB_A } from './fixture-constants';

export { node, observation, registryRecord, pageState };

export type ScriptedObservation =
  | PageObservation
  | PageObservation[]
  | ((tabId: TabId) => PageObservation | PageObservation[]);

export interface V4ClickControl {
  beforeHookError?: unknown;
  afterHookError?: unknown;
  beforeHook?: (request: AdapterClickRequest) => void;
}

export function createExecuteFakeAdapter(
  options: {
    observePage?: () => Promise<PageObservation>;
    observeError?: unknown;
    click?: V4ClickControl;
  } = {},
): {
  adapter: BrowserAdapter;
  counts: { click: number; hook: number; input: number; observePage: number; type: number };
} {
  const counts = { click: 0, hook: 0, input: 0, observePage: 0, type: 0 };
  const adapter: BrowserAdapter = {
    createTab: async () => V4_TAB_A,
    closeTab: async () => undefined,
    activateTab: async () => undefined,
    navigate: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    getPageState: async () => pageState(V4_TAB_A),
    observePage: async () => {
      counts.observePage += 1;
      if (options.observeError !== undefined) {
        throw options.observeError;
      }
      if (options.observePage) {
        return options.observePage();
      }
      return observation([], {
        tabId: V4_TAB_A,
        observationId: 'obs-fresh',
        document: {
          revision: 'rev-fresh',
          url: 'http://127.0.0.1/approval/consequential.html',
          title: 'After',
          loading: false,
          mainFrameId: 'frame-1',
        },
      });
    },
    click: async (request) => {
      counts.click += 1;
      options.click?.beforeHook?.(request);
      if (options.click?.beforeHookError !== undefined) {
        throw options.click.beforeHookError;
      }
      if (request.onBeforeInputDispatch) {
        request.onBeforeInputDispatch();
        counts.hook += 1;
      }
      if (options.click?.afterHookError !== undefined) {
        throw options.click.afterHookError;
      }
      counts.input += 1;
      return { primitive: 'click' };
    },
    type: async () => {
      counts.type += 1;
      return { primitive: 'type' };
    },
    select: async () => {
      throw new Error('unused');
    },
    scroll: async () => {
      throw new Error('unused');
    },
    scrollIntoView: async () => {
      throw new Error('unused');
    },
  };
  return { adapter, counts };
}

export function createV4ProductChain(input: {
  adapter: BrowserAdapter;
  targetRegistry: TargetRegistry;
  runtime: RecordingInteractionModelRuntime;
  observation?: ScriptedObservation;
  observationSource?: {
    observePage: (tabId: TabId, options?: ObservePageOptions) => Promise<PageObservation>;
  };
  now?: () => number;
  emit?: (event: ApprovalEvent) => void;
}) {
  const clock = { now: 1_000 };
  const now = input.now ?? (() => clock.now);
  const ids = { prepared: 0, approval: 0, execution: 0 };
  const manager = new ApprovalManager({
    now,
    generatePreparedActionId: () => `prep-${++ids.prepared}`,
    generateApprovalId: () => `appr-${++ids.approval}`,
    generateExecutionId: () => `exec-${++ids.execution}`,
  });
  const audit = new InMemoryApprovalAuditSink();
  const recorder = new ApprovalAuditRecorder({ manager, audit, now });
  const events: ApprovalEvent[] = [];
  const emit =
    input.emit ??
    ((event: ApprovalEvent) => {
      events.push(event);
    });
  const lifecycle = new ApprovalLifecycle({
    manager,
    auditRecorder: recorder,
    emit,
    now,
  });
  const prepareActionService = new PrepareActionService({ manager, audit });
  const interactionExecutor = new InteractionExecutor({
    adapter: input.adapter,
    targetRegistry: input.targetRegistry,
    audit: new InMemoryInteractionAuditSink(),
  });
  const coordinator = new InteractionCoordinator({
    interactionExecutor,
    prepareActionService,
    approvalPresenter: lifecycle,
  });
  const executeExecutor = new ExecuteExecutor({
    adapter: input.adapter,
    targetRegistry: input.targetRegistry,
    manager,
    auditRecorder: recorder,
  });
  const decisionController = new ApprovalController({
    manager,
    auditRecorder: recorder,
    emit,
  });
  const workflow = new ApprovalWorkflowController({
    decisionController,
    manager,
    executeExecutor,
    auditRecorder: recorder,
    emit,
  });
  const callIndex = new Map<TabId, number>();
  const observationSource = input.observationSource ?? {
    observePage: async (tabId: TabId) => {
      if (!input.observation) {
        throw new Error('No observation scripted');
      }
      const pages = resolvePages(input.observation, tabId);
      const index = callIndex.get(tabId) ?? 0;
      const page = pages[Math.min(index, pages.length - 1)] ?? pages[pages.length - 1];
      callIndex.set(tabId, index + 1);
      if (!page) {
        throw new Error('No observation scripted');
      }
      return page;
    },
  };
  const agent = new InteractiveAgent({
    observationSource,
    modelRuntime: input.runtime,
    interactionExecutor: coordinator,
    allowScreenshotExport: false,
  });
  const aiEvents: AiAnswerEvent[] = [];
  const aiController = new AiRequestController({
    readAgent: {
      answer: async () => ({
        text: 'unused',
        referencedTargets: [],
        alias: 'page-standard',
        truncatedContext: false,
      }),
      cancel: () => true,
      clearConversation: () => undefined,
      clearAllConversations: () => undefined,
    },
    interactiveAgent: agent,
    emit: (event) => {
      aiEvents.push(event);
    },
    invalidateApprovalsForTab: (tabId: TabId) => {
      lifecycle.invalidateTab(tabId);
    },
  });

  return {
    clock,
    manager,
    audit,
    recorder,
    events,
    aiEvents,
    lifecycle,
    workflow,
    agent,
    aiController,
    executeExecutor,
    now,
  };
}

export function buyNowPage(overrides: Partial<PageObservation> = {}): PageObservation {
  return observation(
    [
      node({
        role: 'button',
        tag: 'button',
        targetId: 'target-buy',
        name: 'Buy now',
        attributes: { type: 'button' },
      }),
    ],
    {
      tabId: V4_TAB_A,
      observationId: 'obs-v4-1',
      document: {
        revision: 'rev-v4-1',
        url: 'http://127.0.0.1/approval/consequential.html',
        title: 'V4 fixture',
        loading: false,
        mainFrameId: 'frame-1',
      },
      ...overrides,
    },
  );
}

export function namedButtonPage(
  name: string,
  targetId: string,
  extra: Partial<ObservationNode> = {},
  observationOverrides: Partial<PageObservation> = {},
): PageObservation {
  return observation(
    [
      node({
        role: 'button',
        tag: 'button',
        targetId,
        name,
        attributes: { type: extra.attributes?.type ?? 'button' },
        ...extra,
      }),
    ],
    {
      tabId: V4_TAB_A,
      observationId: observationOverrides.observationId ?? `obs-${targetId}`,
      document: {
        revision: observationOverrides.document?.revision ?? `rev-${targetId}`,
        url: 'http://127.0.0.1/approval/consequential.html',
        title: 'V4 fixture',
        loading: false,
        mainFrameId: 'frame-1',
        ...observationOverrides.document,
      },
      ...observationOverrides,
    },
  );
}

export function seedRegistry(
  registry: TargetRegistry,
  page: PageObservation,
  backendNodeId = 401,
): void {
  const targets = page.nodes
    .filter((candidate) => candidate.targetId)
    .map((candidate, index) =>
      registryRecord(
        candidate.targetId as string,
        backendNodeId + index,
        page.tabId,
        page.observationId,
        page.document.revision,
      ),
    );
  registry.replaceObservation(page.tabId, page.observationId, targets);
}

export function clickRuntime(name: string): RecordingInteractionModelRuntime {
  return new RecordingInteractionModelRuntime((context) => {
    const match = context.nodes.find((candidate) => {
      const candidateName = candidate.name?.toLowerCase() ?? '';
      const candidateText = candidate.text?.toLowerCase() ?? '';
      const needle = name.toLowerCase();
      return candidateName.includes(needle) || candidateText.includes(needle);
    });
    if (!match?.targetId) {
      throw new Error(`Recording runtime could not find target for ${name}`);
    }
    return {
      kind: 'interaction',
      proposal: {
        kind: 'click',
        targetId: match.targetId,
      },
    };
  });
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for acceptance condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

function resolvePages(scripted: ScriptedObservation, tabId: TabId): PageObservation[] {
  const resolved = typeof scripted === 'function' ? scripted(tabId) : scripted;
  return Array.isArray(resolved) ? resolved : [resolved];
}
