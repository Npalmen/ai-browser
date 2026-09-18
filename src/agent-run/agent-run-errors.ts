export type AgentRunErrorCode =
  | 'INVALID_AGENT_RUN_ID'
  | 'AGENT_RUN_ID_COLLISION'
  | 'AGENT_RUN_INVALID_TRANSITION'
  | 'INVALID_APPROVAL_ID'
  | 'APPROVAL_CORRELATION_COLLISION'
  | 'INVALID_TAB_ID';

export class AgentRunError extends Error {
  readonly code: AgentRunErrorCode;

  constructor(code: AgentRunErrorCode, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'AgentRunError';
    this.code = code;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}
