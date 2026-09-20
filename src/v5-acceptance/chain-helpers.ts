import { AgentRunCoordinator } from '../agent-run/agent-run-coordinator';
import { SafeAgentLoop } from '../agent-run/safe-agent-loop';
import { toAgentRunRef } from '../agent-run/agent-run-types';
import type { SafeAgentLoopResult } from '../agent-run/safe-agent-loop';
import { InteractiveStepAgent } from '../ai/interactive-step-agent';
import { ReadOnlyAgent } from '../ai/read-only-agent';
import { ConversationStore } from '../ai/conversation-store';
import { ApprovalAuditRecorder } from '../approval/approval-audit-recorder';
import { InMemoryApprovalAuditSink } from '../approval/approval-audit';
import { ApprovalManager } from '../approval/approval-manager';
import { ExecuteExecutor } from '../approval/execute-executor';
import { PrepareActionService } from '../approval/prepare-action-service';
import type { BrowserAdapter } from '../browser/browser-adapter';
import type { AdapterClickRequest } from '../browser/interaction-adapter-types';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { InteractionExecutor } from '../interaction/interaction-executor';
import { AgentRunApprovalBridge } from '../main/agent-run-approval-bridge';
import { AgentRunController } from '../main/agent-run-controller';
import { AgentRunExecutor } from '../main/agent-run-executor';
import { ApprovalController } from '../main/approval-controller';
import { ApprovalLifecycle } from '../main/approval-lifecycle';
import { ApprovalWorkflowController } from '../main/approval-workflow-controller';
import { AiRequestController } from '../main/ai-request-controller';
import { TargetRegistry } from '../observation/target-registry';
import type { ApprovalEvent } from '../shared/approval-types';
import type { AiAnswerEvent } from '../shared/ai-types';
import type { TabId } from '../shared/browser-types';
import type { ObservePageOptions, ObservationNode, PageObservation } from '../shared/observation-types';
import {
  node,
  observation,
  pageState,
  registryRecord,
} from '../v3-acceptance/chain-fixtures';
import { V5_TAB_A } from './fixture-constants';
import {
  V5AcceptanceModelRuntime,
  type V5InteractionRecordingScript,
} from './recording-agent-model-runtime';

export { node, observation, registryRecord, pageState };

export type ScriptedObservation =
  | PageObservation
  | PageObservation[]
  | ((tabId: TabId) => PageObservation | PageObservation[]);

export interface V5ClickControl {
  beforeHookError?: unknown;
  afterHookError?: unknown;
  beforeHook?: (request: AdapterClickRequest) => void;
}

export function createExecuteFakeAdapter(
  options: {
    observePage?: () => Promise<PageObservation>;
    observeError?: unknown;
    click?: V5ClickControl;
  } = {},
): {
  adapter: BrowserAdapter;
  counts: { click: number; hook: number; input: number; observePage: number; type: number };
} {
  const counts = { click: 0, hook: 0, input: 0, observePage: 0, type: 0 };
  const adapter: BrowserAdapter = {
    createTab: async () => V5_TAB_A,
    closeTab: async () => undefined,
    activateTab: async () => undefined,
    navigate: async () => undefined,
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    getPageState: async () => pageState(V5_TAB_A),
    observePage: async () => {
      counts.observePage += 1;
      if (options.observeError !== undefined) {
        throw options.observeError;
      }
      if (options.observePage) {
        return options.observePage();
      }
      return observation([], {
        tabId: V5_TAB_A,
        observationId: 'obs-fresh',
        document: {
          revision: 'rev-fresh',
          url: 'http://127.0.0.1/agent-run/two-safe.html',
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
      return { primitive: 'scroll' };
    },
    scrollIntoView: async () => {
      return { primitive: 'scroll' };
    },
  };
  return { adapter, counts };
}

export function createV5ProductChain(input: {
  adapter: BrowserAdapter;
  targetRegistry: TargetRegistry;
  runtime: V5AcceptanceModelRuntime;
  observation?: ScriptedObservation;
  observationSource?: {
    observePage: (tabId: TabId, options?: ObservePageOptions) => Promise<PageObservation>;
  };
  now?: () => number;
  emitApproval?: (event: ApprovalEvent) => void;
  emitAi?: (event: AiAnswerEvent) => void;
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
  const approvalEvents: ApprovalEvent[] = [];
  const emitApproval =
    input.emitApproval ??
    ((event: ApprovalEvent) => {
      approvalEvents.push(event);
    });
  const agentRunCoordinator = new AgentRunCoordinator({ now });
  const lifecycle = new ApprovalLifecycle({
    manager,
    auditRecorder: recorder,
    emit: emitApproval,
    now,
    notifyAgentRunOutcome: (approvalId, outcome) => {
      agentRunCoordinator.notifyApprovalOutcome(approvalId, outcome);
    },
  });
  const prepareActionService = new PrepareActionService({ manager, audit });
  const interactionExecutor = new InteractionExecutor({
    adapter: input.adapter,
    targetRegistry: input.targetRegistry,
    audit: new InMemoryInteractionAuditSink(),
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
    emit: emitApproval,
  });
  const workflow = new ApprovalWorkflowController({
    decisionController,
    manager,
    executeExecutor,
    auditRecorder: recorder,
    emit: emitApproval,
    agentRun: agentRunCoordinator,
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
      seedRegistry(input.targetRegistry, page);
      return page;
    },
  };
  const runtime = input.runtime;
  const stepAgent = new InteractiveStepAgent({
    observationSource,
    modelRuntime: runtime,
    allowScreenshotExport: false,
  });
  const readAgent = new ReadOnlyAgent({
    observationSource,
    modelRuntime: runtime,
    allowScreenshotExport: false,
  });
  const approvalBridge = new AgentRunApprovalBridge({
    coordinator: agentRunCoordinator,
    prepareActionService,
    lifecycle,
    manager,
    auditRecorder: recorder,
    emit: emitApproval,
  });
  const loop = new SafeAgentLoop({
    coordinator: agentRunCoordinator,
    stepAgent,
    interactionExecutor,
    approvalPort: approvalBridge,
  });
  const conversationStore = new ConversationStore();
  const aiEvents: AiAnswerEvent[] = [];
  const emitAi =
    input.emitAi ??
    ((event: AiAnswerEvent) => {
      aiEvents.push(event);
    });
  const agentRunExecutor = new AgentRunExecutor({
    coordinator: agentRunCoordinator,
    loop,
    manager,
    lifecycle,
  });
  const agentRunController = new AgentRunController({
    executor: agentRunExecutor,
    conversationStore,
    emit: emitAi,
  });
  const aiController = new AiRequestController({
    readAgent,
    agentRuns: agentRunController,
    emit: emitAi,
    invalidateApprovalsForTab: (tabId: TabId) => {
      lifecycle.invalidateTab(tabId);
    },
  });

  return {
    clock,
    manager,
    audit,
    recorder,
    approvalEvents,
    aiEvents,
    lifecycle,
    workflow,
    aiController,
    agentRunController,
    agentRunCoordinator,
    conversationStore,
    prepareActionService,
    interactionExecutor,
    executeExecutor,
    safeAgentLoop: loop,
    runtime,
    now,
  };
}

export function multiStepPage(overrides: Partial<PageObservation> = {}): PageObservation {
  return observation(
    [
      node({
        role: 'button',
        tag: 'button',
        targetId: 'target-safe-a',
        name: 'Safe control A',
        attributes: { type: 'button' },
      }),
      node({
        role: 'button',
        tag: 'button',
        targetId: 'target-buy',
        name: 'Buy now',
        attributes: { type: 'button' },
      }),
      node({
        role: 'button',
        tag: 'button',
        targetId: 'target-publish',
        name: 'Publish',
        attributes: { type: 'button' },
      }),
    ],
    {
      tabId: V5_TAB_A,
      observationId: 'obs-v5-multi',
      document: {
        revision: 'rev-v5-multi',
        url: 'http://127.0.0.1/agent-run/multi-step.html',
        title: 'V5 fixture',
        loading: false,
        mainFrameId: 'frame-1',
      },
      ...overrides,
    },
  );
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
      tabId: V5_TAB_A,
      observationId: 'obs-v5-1',
      document: {
        revision: 'rev-v5-1',
        url: 'http://127.0.0.1/agent-run/multi-step.html',
        title: 'V5 fixture',
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
      tabId: V5_TAB_A,
      observationId: observationOverrides.observationId ?? `obs-${targetId}`,
      document: {
        revision: observationOverrides.document?.revision ?? `rev-${targetId}`,
        url: 'http://127.0.0.1/agent-run/multi-step.html',
        title: 'V5 fixture',
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

export function clickRuntime(name: string): V5AcceptanceModelRuntime {
  return new V5AcceptanceModelRuntime((context) => {
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

export function answerRuntime(text: string): V5AcceptanceModelRuntime {
  return new V5AcceptanceModelRuntime(() => ({
    kind: 'answer',
    disposition: 'informational',
    text,
    referencedTargets: [],
  }), text);
}

export function stepScriptRuntime(
  steps: V5InteractionRecordingScript[],
): V5AcceptanceModelRuntime {
  let index = 0;
  return new V5AcceptanceModelRuntime((context, instruction) => {
    const script = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return script(context, instruction);
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

export async function startActDirect(
  chain: ReturnType<typeof createV5ProductChain>,
  tabId: TabId,
  instruction: string,
  askId = crypto.randomUUID(),
): Promise<SafeAgentLoopResult> {
  const started = await chain.agentRunController.start(tabId, instruction, { askId });
  if (started.status !== 'started') {
    throw new Error('AgentRun did not start');
  }
  return await started.completion;
}

export function lastPendingApproval(chain: ReturnType<typeof createV5ProductChain>) {
  const event = [...chain.approvalEvents]
    .reverse()
    .find((entry) => entry.type === 'approval-required');
  if (!event || event.type !== 'approval-required') {
    throw new Error('expected approval-required event');
  }
  return event.approval;
}

function resolvePages(scripted: ScriptedObservation, tabId: TabId): PageObservation[] {
  const resolved = typeof scripted === 'function' ? scripted(tabId) : scripted;
  return Array.isArray(resolved) ? resolved : [resolved];
}
