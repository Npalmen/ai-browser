import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserAdapter } from '../browser/browser-adapter';
import type { AdapterClickRequest } from '../browser/interaction-adapter-types';
import type { CreateTabInput } from '../browser/tab-creation';
import type { TabId } from '../shared/browser-types';
import type { PageObservation } from '../shared/observation-types';
import type { AutonomousTaskEvent } from '../shared/autonomous-task-types';
import type { PersistentWorkflowRuntime, WorkflowExecutionTaskPort } from '../main/persistent-workflow-runtime';
import type { SchedulerTimerPort } from '../workflows/workflow-scheduler-types';
import type { CreateDurableWorkflowInput } from '../workflows/durable-workflow-types';
import type { V6ClickControl } from '../v6-acceptance/chain-helpers';
import { buyNowPage, namedButtonPage, pageState } from '../v6-acceptance/chain-helpers';

export const V7_TWO_SAFE_PATH = '/agent-run/two-safe.html';
export const V7_CONSEQUENTIAL_PATH = '/approval/consequential.html';
export const V7_PROMPT_INJECTION_PATH = '/agent-run/prompt-injection.html';
export const V7_BACKGROUND_PATH = '/autonomous-task/background.html';

export async function withTempDirectory<T>(fn: (directory: string) => Promise<T>): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'v7-accept-'));
  try {
    return await fn(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function sampleWorkflow(
  overrides: Partial<CreateDurableWorkflowInput> & { url?: string } = {},
): CreateDurableWorkflowInput {
  const { url, ...rest } = overrides;
  return {
    name: rest.name ?? 'Invoice check',
    objective: rest.objective ?? 'Open the page and click Safe control A',
    entryPoint: rest.entryPoint ?? { kind: 'url', url: url ?? 'https://example.test/path' },
    trigger: rest.trigger ?? { kind: 'manual' },
    enabled: rest.enabled,
  };
}

export class FakeTimer implements SchedulerTimerPort {
  private nextId = 1;
  private readonly timers = new Map<number, { delayMs: number; callback: () => void | Promise<void> }>();

  get size(): number {
    return this.timers.size;
  }

  get only(): { delayMs: number; callback: () => void | Promise<void> } {
    if (this.timers.size !== 1) {
      throw new Error(`expected one timer, got ${this.timers.size}`);
    }
    return [...this.timers.values()][0]!;
  }

  setTimer(delayMs: number, callback: () => void | Promise<void>): number {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { delayMs, callback });
    return id;
  }

  clearTimer(handle: unknown): void {
    this.timers.delete(handle as number);
  }
}

export function createV7FakeAdapter(options: {
  observePage?: (tabId: TabId) => Promise<PageObservation>;
  click?: V6ClickControl;
  pageForUrl?: (url: string, tabId: TabId) => PageObservation;
} = {}): {
  adapter: BrowserAdapter;
  counts: { click: number; hook: number; input: number; observePage: number; createTab: number };
  created: { tabId: TabId; url: string; activate: boolean | undefined }[];
  closed: TabId[];
  browserState: { activeTabId: TabId; tabs: { id: TabId }[] };
} {
  const counts = { click: 0, hook: 0, input: 0, observePage: 0, createTab: 0 };
  const created: { tabId: TabId; url: string; activate: boolean | undefined }[] = [];
  const closed: TabId[] = [];
  let nextTab = 1;
  const initial = 'tab-user';
  const browserState = { activeTabId: initial, tabs: [{ id: initial }] };
  const urls = new Map<TabId, string>([[initial, 'about:blank']]);
  const adapter: BrowserAdapter = {
    createTab: async (input?: CreateTabInput) => {
      counts.createTab += 1;
      const tabId = `tab-v7-${nextTab}` as TabId;
      nextTab += 1;
      created.push({ tabId, url: input?.url ?? 'about:blank', activate: input?.activate });
      urls.set(tabId, input?.url ?? 'about:blank');
      browserState.tabs.push({ id: tabId });
      if (input?.activate) {
        browserState.activeTabId = tabId;
      }
      return tabId;
    },
    closeTab: async (tabId) => {
      closed.push(tabId);
      browserState.tabs = browserState.tabs.filter((tab) => tab.id !== tabId);
    },
    activateTab: async (tabId) => {
      browserState.activeTabId = tabId;
    },
    navigate: async (tabId, url) => {
      urls.set(tabId, url);
    },
    back: async () => undefined,
    forward: async () => undefined,
    reload: async () => undefined,
    getPageState: async (tabId) => pageState(tabId),
    observePage: async (tabId) => {
      counts.observePage += 1;
      if (options.observePage) {
        return options.observePage(tabId);
      }
      const url = urls.get(tabId) ?? '';
      if (options.pageForUrl) {
        return options.pageForUrl(url, tabId);
      }
      if (url.includes('consequential') || url.includes('approval')) {
        return buyNowPage(tabId);
      }
      return namedButtonPage('Safe control A', `target-${tabId}`, tabId);
    },
    click: async (request: AdapterClickRequest) => {
      counts.click += 1;
      await options.click?.beforeHook?.(request);
      if (request.onBeforeInputDispatch) {
        request.onBeforeInputDispatch();
        counts.hook += 1;
      }
      if (options.click?.afterDispatchHold) {
        await options.click.afterDispatchHold();
      }
      if (options.click?.afterHookError !== undefined) {
        throw options.click.afterHookError;
      }
      counts.input += 1;
      return { primitive: 'click' };
    },
    type: async () => ({ primitive: 'type' }),
    select: async () => {
      throw new Error('unused');
    },
    scroll: async () => ({ primitive: 'scroll' }),
    scrollIntoView: async () => ({ primitive: 'scroll' }),
  };
  return { adapter, counts, created, closed, browserState };
}

export function bindRuntimeToController(
  runtime: PersistentWorkflowRuntime,
  controller: {
    hasActiveTask(): boolean;
    startOnTrustedTab(tabId: TabId, objective: string): ReturnType<WorkflowExecutionTaskPort['startOnTrustedTab']>;
    start(objective: string): ReturnType<WorkflowExecutionTaskPort['start']>;
    resume(taskId: string): ReturnType<WorkflowExecutionTaskPort['resume']>;
    pause(taskId: string): ReturnType<WorkflowExecutionTaskPort['pause']>;
    stop(taskId: string): ReturnType<WorkflowExecutionTaskPort['stop']>;
  },
  browser: { createTab: BrowserAdapter['createTab']; closeTab: BrowserAdapter['closeTab'] },
  onEvent?: (listener: (event: AutonomousTaskEvent) => void) => () => void,
): void {
  const autonomousTasks: WorkflowExecutionTaskPort = {
    hasActiveTask: () => controller.hasActiveTask(),
    startOnTrustedTab: (tabId, objective) => controller.startOnTrustedTab(tabId, objective),
    start: (objective) => controller.start(objective),
    resume: (taskId) => controller.resume(taskId),
    pause: (taskId) => controller.pause(taskId),
    stop: (taskId) => controller.stop(taskId),
  };
  runtime.attachExecutionRuntime(
    {
      browser: {
        createTab: (input) => browser.createTab({ url: input.url, activate: false }),
        closeTab: (tabId) => browser.closeTab(tabId),
      },
      autonomousTasks,
    },
    onEvent,
  );
}
