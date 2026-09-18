import type {
  AutonomousTaskId,
  AutonomousTaskSnapshot,
  AutonomousTaskState,
  AutonomousTaskTerminalReason,
} from './autonomous-task-types';

export type AutonomousTaskAuditEventType =
  | 'task-started'
  | 'state-transition'
  | 'planner-step-completed'
  | 'child-run-started'
  | 'child-run-completed'
  | 'task-tab-added'
  | 'task-tab-removed'
  | 'approval-presented'
  | 'task-paused'
  | 'task-resumed'
  | 'awaiting-user-input'
  | 'task-terminal';

export interface AutonomousTaskAuditEvent {
  readonly eventType: AutonomousTaskAuditEventType;
  readonly timestamp: number;
  readonly taskId: AutonomousTaskId;
  readonly generation: number;
  readonly state: AutonomousTaskState;
  readonly plannerStepCount: number;
  readonly childRunCount: number;
  readonly ownedTabCount: number;
  readonly taskApprovalCount: number;
  readonly terminalReason?: AutonomousTaskTerminalReason;
}

export interface AutonomousTaskAuditSink {
  append(event: AutonomousTaskAuditEvent): void;
  getEvents(): ReadonlyArray<AutonomousTaskAuditEvent>;
  clear(): void;
}

export class InMemoryAutonomousTaskAuditSink implements AutonomousTaskAuditSink {
  private readonly events: AutonomousTaskAuditEvent[] = [];

  append(event: AutonomousTaskAuditEvent): void {
    this.events.push(cloneAutonomousTaskAuditEvent(event));
  }

  getEvents(): ReadonlyArray<AutonomousTaskAuditEvent> {
    return Object.freeze(this.events.map((event) => cloneAutonomousTaskAuditEvent(event)));
  }

  clear(): void {
    this.events.length = 0;
  }
}

export function buildAutonomousTaskAuditEvent(
  eventType: AutonomousTaskAuditEventType,
  snapshot: AutonomousTaskSnapshot,
  timestamp: number,
): AutonomousTaskAuditEvent {
  return Object.freeze({
    eventType,
    timestamp,
    taskId: snapshot.taskId,
    generation: snapshot.generation,
    state: snapshot.state,
    plannerStepCount: snapshot.plannerStepCount,
    childRunCount: snapshot.childRunCount,
    ownedTabCount: snapshot.ownedTabCount,
    taskApprovalCount: snapshot.taskApprovalCount,
    ...(snapshot.terminalReason !== undefined ? { terminalReason: snapshot.terminalReason } : {}),
  });
}

function cloneAutonomousTaskAuditEvent(event: AutonomousTaskAuditEvent): AutonomousTaskAuditEvent {
  return Object.freeze({
    eventType: event.eventType,
    timestamp: event.timestamp,
    taskId: event.taskId,
    generation: event.generation,
    state: event.state,
    plannerStepCount: event.plannerStepCount,
    childRunCount: event.childRunCount,
    ownedTabCount: event.ownedTabCount,
    taskApprovalCount: event.taskApprovalCount,
    ...(event.terminalReason !== undefined ? { terminalReason: event.terminalReason } : {}),
  });
}
