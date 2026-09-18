import type { TabId } from '../shared/browser-types';
import type {
  AgentRunId,
  AgentRunSnapshot,
  AgentRunState,
  AgentRunTerminalReason,
} from './agent-run-types';

export type AgentRunAuditEventType =
  | 'run-started'
  | 'state-transition'
  | 'model-step-completed'
  | 'action-attempt-started'
  | 'approval-presented'
  | 'run-terminal';

export interface AgentRunAuditEvent {
  readonly eventType: AgentRunAuditEventType;
  readonly timestamp: number;
  readonly runId: AgentRunId;
  readonly tabId: TabId;
  readonly generation: number;
  readonly state: AgentRunState;
  readonly modelStepCount: number;
  readonly actionAttemptCount: number;
  readonly approvalCount: number;
  readonly terminalReason?: AgentRunTerminalReason;
}

export interface AgentRunAuditSink {
  append(event: AgentRunAuditEvent): void;
  getEvents(): ReadonlyArray<AgentRunAuditEvent>;
  clear(): void;
}

export class InMemoryAgentRunAuditSink implements AgentRunAuditSink {
  private readonly events: AgentRunAuditEvent[] = [];

  append(event: AgentRunAuditEvent): void {
    this.events.push(cloneAgentRunAuditEvent(event));
  }

  getEvents(): ReadonlyArray<AgentRunAuditEvent> {
    return Object.freeze(this.events.map((event) => cloneAgentRunAuditEvent(event)));
  }

  clear(): void {
    this.events.length = 0;
  }
}

export function buildAgentRunAuditEvent(
  eventType: AgentRunAuditEventType,
  snapshot: AgentRunSnapshot,
  timestamp: number,
): AgentRunAuditEvent {
  return Object.freeze({
    eventType,
    timestamp,
    runId: snapshot.runId,
    tabId: snapshot.tabId,
    generation: snapshot.generation,
    state: snapshot.state,
    modelStepCount: snapshot.modelStepCount,
    actionAttemptCount: snapshot.actionAttemptCount,
    approvalCount: snapshot.approvalCount,
    ...(snapshot.terminalReason !== undefined ? { terminalReason: snapshot.terminalReason } : {}),
  });
}

function cloneAgentRunAuditEvent(event: AgentRunAuditEvent): AgentRunAuditEvent {
  return Object.freeze({
    eventType: event.eventType,
    timestamp: event.timestamp,
    runId: event.runId,
    tabId: event.tabId,
    generation: event.generation,
    state: event.state,
    modelStepCount: event.modelStepCount,
    actionAttemptCount: event.actionAttemptCount,
    approvalCount: event.approvalCount,
    ...(event.terminalReason !== undefined ? { terminalReason: event.terminalReason } : {}),
  });
}
