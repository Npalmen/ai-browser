import type { AutonomousTaskEvent, AutonomousTaskView } from '../shared/autonomous-task-types';
import type { TabId } from '../shared/browser-types';
import { isDurableWorkflowError } from '../workflows/durable-workflow-errors';
import type { RunningOccurrenceTerminalState } from '../workflows/durable-workflow-types';
import { MAX_WORKFLOW_FINAL_ANSWER_CHARS } from '../workflows/workflow-store-types';
import {
  WORKFLOW_START_REASON,
  isTrustedWorkflowExecutionUrl,
  type WorkflowActiveOccurrence,
  type WorkflowAutonomousTaskPort,
  type WorkflowBrowserStartupPort,
  type WorkflowLiveExecutionInspection,
  type WorkflowOccurrenceDurablePort,
  type WorkflowOccurrenceRunnerDependencies,
  type WorkflowOccurrenceStartResult,
} from '../workflows/workflow-occurrence-runner-types';

const NONTERMINAL_TASK_EVENTS = new Set<AutonomousTaskEvent['type']>([
  'autonomous-task-started',
  'autonomous-task-progress',
  'autonomous-task-awaiting-approval',
  'autonomous-task-awaiting-user-input',
  'autonomous-task-paused',
  'autonomous-task-resumed',
]);

const BLOCKED_REASONS = new Set([
  'TASK_LIMIT_REACHED',
  'TASK_NO_PROGRESS',
  'POLICY_BLOCKED',
  'APPROVAL_REJECTED',
  'APPROVAL_EXPIRED',
  'ACTION_STALE',
  'TAB_UNAVAILABLE',
  'TAB_OWNERSHIP_VIOLATION',
]);

const FAILED_REASONS = new Set(['PLANNER_FAILED', 'CHILD_RUN_FAILED', 'TASK_INTERNAL_ERROR']);

const CANCELLED_REASONS = new Set(['USER_CANCELLED', 'RUNTIME_DISPOSED']);

interface LiveWorkflowExecution {
  readonly occurrenceId: string;
  readonly workflowId: string;
  readonly taskId: string;
  readonly tabId: TabId;
  pendingTerminal?: MappedTerminal;
}

interface MappedTerminal {
  readonly state: RunningOccurrenceTerminalState;
  readonly terminalReason: string;
  readonly finalAnswer?: string;
}

/**
 * Phase 4 runner: queued occurrence → durable running claim → fresh background
 * tab → existing V6 AutonomousTask on that exact tab → durable terminal mapping.
 *
 * Does not acquire browser interaction authority. Page actions remain
 * V6 → V5 → V3 INTERACT → V4 PREPARE/APPROVAL/EXECUTE.
 *
 * Phase 5 owns scheduler drain, process wiring, and full Delegate/workflow
 * slot arbitration. A theoretical race remains: V6 can become busy after this
 * preflight and before exact-tab start. Phase 4 fail-closes that as a durable
 * `failed` occurrence after the running claim, without retry.
 */
export class WorkflowOccurrenceRunner {
  private readonly durable: WorkflowOccurrenceDurablePort;
  private readonly browser: WorkflowBrowserStartupPort;
  private readonly autonomousTasks: WorkflowAutonomousTaskPort;
  private live: LiveWorkflowExecution | undefined;
  private terminalizing: Promise<void> | undefined;

  constructor(deps: WorkflowOccurrenceRunnerDependencies) {
    this.durable = deps.durable;
    this.browser = deps.browser;
    this.autonomousTasks = deps.autonomousTasks;
  }

  getActiveOccurrence(): WorkflowActiveOccurrence | undefined {
    if (this.live === undefined) {
      return undefined;
    }
    return {
      occurrenceId: this.live.occurrenceId,
      workflowId: this.live.workflowId,
    };
  }

  inspectLiveExecution(): WorkflowLiveExecutionInspection | undefined {
    if (this.live === undefined) {
      return undefined;
    }
    return {
      occurrenceId: this.live.occurrenceId,
      workflowId: this.live.workflowId,
      taskId: this.live.taskId,
      tabId: this.live.tabId,
    };
  }

  async startOccurrence(occurrenceId: string): Promise<WorkflowOccurrenceStartResult> {
    if (this.live !== undefined) {
      return { status: 'busy' };
    }
    if (this.autonomousTasks.hasActiveTask()) {
      return { status: 'busy' };
    }

    const occurrence = await this.durable.getOccurrence(occurrenceId);
    if (occurrence === undefined) {
      return { status: 'failed', occurrenceId };
    }
    if (occurrence.state !== 'queued') {
      return occurrence.state === 'running'
        ? { status: 'busy' }
        : { status: 'failed', occurrenceId };
    }

    let running;
    try {
      running = await this.durable.markOccurrenceRunning(occurrenceId);
    } catch (error) {
      if (isDurableWorkflowError(error) && error.code === 'WORKFLOW_BUSY') {
        return { status: 'busy' };
      }
      return { status: 'failed', occurrenceId };
    }

    const frozenUrl = running.frozenDefinition.entryPoint.url;
    const objective = running.frozenDefinition.objective;
    if (!isTrustedWorkflowExecutionUrl(frozenUrl)) {
      await this.failStartup(occurrenceId, WORKFLOW_START_REASON.TAB);
      return { status: 'failed', occurrenceId };
    }

    let tabId: TabId;
    try {
      tabId = await this.browser.createTab({ url: frozenUrl, activate: false });
    } catch {
      await this.failStartup(occurrenceId, WORKFLOW_START_REASON.TAB);
      return { status: 'failed', occurrenceId };
    }
    if (typeof tabId !== 'string' || tabId.trim().length === 0) {
      await this.failStartup(occurrenceId, WORKFLOW_START_REASON.TAB);
      return { status: 'failed', occurrenceId };
    }

    let started;
    try {
      started = this.autonomousTasks.startOnTrustedTab(tabId, objective);
    } catch {
      await this.closeUnusedTab(tabId);
      await this.failStartup(occurrenceId, WORKFLOW_START_REASON.V6);
      return { status: 'failed', occurrenceId };
    }
    if (!started.ok || started.task.taskId.trim().length === 0) {
      await this.closeUnusedTab(tabId);
      await this.failStartup(occurrenceId, WORKFLOW_START_REASON.V6);
      return { status: 'failed', occurrenceId };
    }

    this.live = {
      occurrenceId: running.occurrenceId,
      workflowId: running.workflowId,
      taskId: started.task.taskId,
      tabId,
    };
    return { status: 'started', occurrenceId: running.occurrenceId };
  }

  async handleAutonomousTaskEvent(event: AutonomousTaskEvent): Promise<void> {
    try {
      await this.dispatchTaskEvent(event);
    } catch {
      // Keep process-local correlation for the same terminal fact. Do not
      // start another V6 task or retry browser actions.
    }
  }

  async reconcilePendingTerminal(): Promise<void> {
    await this.commitPendingTerminal();
  }

  private async dispatchTaskEvent(event: AutonomousTaskEvent): Promise<void> {
    const live = this.live;
    if (live === undefined || event.task.taskId !== live.taskId) {
      return;
    }
    if (NONTERMINAL_TASK_EVENTS.has(event.type)) {
      return;
    }
    const mapped = mapTerminalEvent(event);
    if (mapped === undefined) {
      return;
    }
    live.pendingTerminal = mapped;
    if (this.terminalizing !== undefined) {
      await this.terminalizing;
      return;
    }
    const work = this.commitPendingTerminal();
    this.terminalizing = work;
    try {
      await work;
    } finally {
      this.terminalizing = undefined;
    }
  }

  private async commitPendingTerminal(): Promise<void> {
    const live = this.live;
    const pending = live?.pendingTerminal;
    if (live === undefined || pending === undefined) {
      return;
    }
    try {
      await this.durable.terminalizeRunningOccurrence({
        occurrenceId: live.occurrenceId,
        state: pending.state,
        terminalReason: pending.terminalReason,
        ...(pending.finalAnswer !== undefined ? { finalAnswer: pending.finalAnswer } : {}),
      });
    } catch (error) {
      if (
        isDurableWorkflowError(error) &&
        error.code === 'WORKFLOW_OCCURRENCE_INVALID_STATE'
      ) {
        this.live = undefined;
        return;
      }
      throw error;
    }
    this.live = undefined;
  }

  private async failStartup(occurrenceId: string, reason: string): Promise<void> {
    try {
      await this.durable.terminalizeRunningOccurrence({
        occurrenceId,
        state: 'failed',
        terminalReason: reason,
      });
    } catch {
      // Durable truth stays running if the terminal commit fails. Do not
      // create another tab or V6 task.
    }
  }

  private async closeUnusedTab(tabId: TabId): Promise<void> {
    try {
      await this.browser.closeTab(tabId);
    } catch {
      // Best-effort cleanup of an unused startup tab. Must not overwrite
      // durable occurrence terminal truth.
    }
  }
}

function mapTerminalEvent(event: AutonomousTaskEvent): MappedTerminal | undefined {
  switch (event.type) {
    case 'autonomous-task-completed':
      return mapCompleted(event.task);
    case 'autonomous-task-blocked':
      return {
        state: 'blocked',
        terminalReason: boundedReason(event.task.terminalReason, BLOCKED_REASONS, 'POLICY_BLOCKED'),
      };
    case 'autonomous-task-failed':
      return {
        state: 'failed',
        terminalReason: boundedReason(event.task.terminalReason, FAILED_REASONS, 'TASK_INTERNAL_ERROR'),
      };
    case 'autonomous-task-cancelled':
      return {
        state: 'blocked',
        terminalReason: boundedReason(
          event.task.terminalReason,
          CANCELLED_REASONS,
          'USER_CANCELLED',
        ),
      };
    case 'autonomous-task-execution-state-unknown':
      return {
        state: 'execution-state-unknown',
        terminalReason: 'EXECUTION_STATE_UNKNOWN',
      };
    default:
      return undefined;
  }
}

function mapCompleted(task: AutonomousTaskView): MappedTerminal {
  const answer = task.completedAnswer;
  if (
    typeof answer !== 'string' ||
    answer.length === 0 ||
    answer.length > MAX_WORKFLOW_FINAL_ANSWER_CHARS
  ) {
    return {
      state: 'failed',
      terminalReason: WORKFLOW_START_REASON.RESULT_MISSING,
    };
  }
  return {
    state: 'completed',
    terminalReason: 'COMPLETED',
    finalAnswer: answer,
  };
}

function boundedReason(
  reason: string | undefined,
  allowed: ReadonlySet<string>,
  fallback: string,
): string {
  if (typeof reason === 'string' && allowed.has(reason)) {
    return reason;
  }
  return fallback;
}
