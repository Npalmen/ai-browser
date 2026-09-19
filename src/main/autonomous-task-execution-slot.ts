import type { AiSafeError } from '../shared/ai-types';
import { aiSafeError } from './ai-safe-error';

export type AutonomousTaskSlotKind = 'manual' | 'workflow';

export class AutonomousTaskSlotReservation {
  taskId: string | undefined;

  constructor(
    readonly kind: AutonomousTaskSlotKind,
    readonly occurrenceId?: string,
  ) {}
}

export type AutonomousTaskSlotOwner =
  | {
      readonly kind: 'manual';
      readonly taskId?: string;
    }
  | {
      readonly kind: 'workflow';
      readonly occurrenceId: string;
      readonly taskId?: string;
    };

/**
 * Process-local V6 execution gate. Not browser authority and not persisted.
 */
export class AutonomousTaskExecutionSlot {
  private current: AutonomousTaskSlotReservation | undefined;

  tryReserveManual(): AutonomousTaskSlotReservation | undefined {
    if (this.current !== undefined) {
      return undefined;
    }
    const reservation = new AutonomousTaskSlotReservation('manual');
    this.current = reservation;
    return reservation;
  }

  tryReserveWorkflow(occurrenceId: string): AutonomousTaskSlotReservation | undefined {
    if (this.current !== undefined) {
      return undefined;
    }
    if (typeof occurrenceId !== 'string' || occurrenceId.trim().length === 0) {
      return undefined;
    }
    const reservation = new AutonomousTaskSlotReservation('workflow', occurrenceId);
    this.current = reservation;
    return reservation;
  }

  bindTaskId(reservation: AutonomousTaskSlotReservation, taskId: string): void {
    if (this.current !== reservation) {
      return;
    }
    if (typeof taskId !== 'string' || taskId.trim().length === 0) {
      return;
    }
    reservation.taskId = taskId;
  }

  release(reservation: AutonomousTaskSlotReservation): boolean {
    if (this.current !== reservation) {
      return false;
    }
    this.current = undefined;
    return true;
  }

  owner(): AutonomousTaskSlotOwner | undefined {
    const current = this.current;
    if (current === undefined) {
      return undefined;
    }
    if (current.kind === 'workflow') {
      return {
        kind: 'workflow',
        occurrenceId: current.occurrenceId ?? '',
        taskId: current.taskId,
      };
    }
    return {
      kind: 'manual',
      taskId: current.taskId,
    };
  }

  isFree(): boolean {
    return this.current === undefined;
  }

  holds(reservation: AutonomousTaskSlotReservation): boolean {
    return this.current === reservation;
  }
}

export function slotBusyError(): AiSafeError {
  return aiSafeError('AI_REQUEST_FAILED');
}
