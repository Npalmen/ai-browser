export type AutonomousTaskErrorCode =
  | 'INVALID_AUTONOMOUS_TASK_ID'
  | 'AUTONOMOUS_TASK_ID_COLLISION'
  | 'AUTONOMOUS_TASK_ALREADY_ACTIVE'
  | 'AUTONOMOUS_TASK_INVALID_TRANSITION'
  | 'INVALID_AUTONOMOUS_TASK_OBJECTIVE'
  | 'INVALID_TAB_ID'
  | 'TASK_TAB_ALREADY_OWNED'
  | 'TASK_TAB_LIMIT_REACHED'
  | 'TASK_TAB_NOT_OWNED'
  | 'INVALID_TASK_TAB_ALIAS'
  | 'INVALID_SUBGOAL_FINGERPRINT'
  | 'INVALID_TRUSTED_TAB_STATE_TOKEN';

export class AutonomousTaskError extends Error {
  readonly code: AutonomousTaskErrorCode;

  constructor(code: AutonomousTaskErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AutonomousTaskError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
