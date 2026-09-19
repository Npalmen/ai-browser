import type {
  AgentRunCancelledReason,
  AgentRunRef,
  AgentRunSnapshot,
} from '../agent-run/agent-run-types';
import type { ModelAlias } from '../ai/model-types';
import type { TabId } from '../shared/browser-types';
import type { DocumentRevision, TargetId } from '../shared/observation-types';

/**
 * Structural V5 execution surface for AutonomousTask child runs.
 * Implementations live in main; this module must not import the main
 * execution class.
 */
export type AutonomousTaskAgentRunCompletion =
  | {
      readonly status: 'completed';
      readonly run: AgentRunSnapshot;
      readonly answer: {
        readonly text: string;
        readonly referencedTargets: readonly TargetId[];
        readonly alias: ModelAlias;
        readonly truncatedContext: boolean;
        readonly documentRevision: DocumentRevision;
      };
    }
  | {
      readonly status: 'terminal';
      readonly run: AgentRunSnapshot;
    }
  | {
      readonly status: 'ignored';
    };

export type AutonomousTaskAgentRunExecutionStartResult =
  | {
      readonly status: 'started';
      readonly run: AgentRunSnapshot;
      readonly ref: AgentRunRef;
      readonly completion: Promise<AutonomousTaskAgentRunCompletion>;
    }
  | {
      readonly status: 'ignored';
    };

export interface AutonomousTaskAgentRunExecutionPort {
  start(
    tabId: TabId,
    instruction: string,
    options?: {
      readonly shouldStart?: () => boolean;
    },
  ): Promise<AutonomousTaskAgentRunExecutionStartResult>;

  cancel(ref: AgentRunRef, reason: AgentRunCancelledReason): boolean;

  cancelAndWait(ref: AgentRunRef, reason: AgentRunCancelledReason): Promise<void>;
}
