import {
  AUTONOMOUS_TASK_EXECUTION_UNKNOWN_COPY,
  autonomousTaskTerminalCopy,
  type AutonomousTaskView,
} from '../shared/autonomous-task-types';

export function AutonomousTaskCard(props: {
  task: AutonomousTaskView;
  replyDraft: string;
  onReplyDraftChange: (value: string) => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onReply: () => void;
  resumeDisabled?: boolean;
}) {
  const task = props.task;
  const isTerminal = isTerminalState(task.state);
  const canReply = task.state === 'awaiting-user-input';
  const canPause =
    task.state === 'planning' ||
    task.state === 'running-subgoal' ||
    task.state === 'awaiting-approval' ||
    task.state === 'awaiting-user-input';

  return (
    <section className="autonomous-task-card" aria-label="Autonomous task">
      <div className="autonomous-task-status">{statusLabel(task)}</div>
      {task.currentSubgoal ? (
        <p className="autonomous-task-subgoal">
          Subgoal {task.currentSubgoal.ordinal} of {task.limits.childRuns} · {task.currentSubgoal.tabAlias}
        </p>
      ) : null}
      <ul className="autonomous-task-counters">
        <li>
          Owned tabs: {task.ownedTabCount} / {task.limits.ownedTabs}
        </li>
        <li>
          Planner steps: {task.plannerStepCount} / {task.limits.plannerSteps}
        </li>
        <li>
          Child runs: {task.childRunCount} / {task.limits.childRuns}
        </li>
        <li>
          Approvals: {task.taskApprovalCount} / {task.limits.approvals}
        </li>
      </ul>
      {task.state === 'awaiting-approval' ? (
        <p className="autonomous-task-attention">Approval required on a task tab.</p>
      ) : null}
      {task.state === 'execution-state-unknown' ? (
        <p className="autonomous-task-unknown">{AUTONOMOUS_TASK_EXECUTION_UNKNOWN_COPY}</p>
      ) : isTerminal ? (
        <p className="autonomous-task-result">
          {task.state === 'completed' && task.completedAnswer
            ? task.completedAnswer
            : autonomousTaskTerminalCopy(task.terminalReason)}
        </p>
      ) : null}
      {canReply ? (
        <div className="autonomous-task-reply">
          {task.question ? <p className="autonomous-task-question">{task.question}</p> : null}
          <textarea
            className="ai-question-input"
            value={props.replyDraft}
            placeholder="Reply to the task"
            rows={3}
            onChange={(event) => props.onReplyDraftChange(event.target.value)}
          />
          <div className="autonomous-task-actions">
            <button
              type="button"
              className="ai-panel-button ai-panel-button-primary"
              disabled={props.replyDraft.trim().length === 0}
              onClick={props.onReply}
            >
              Reply
            </button>
          </div>
        </div>
      ) : null}
      <div className="autonomous-task-actions">
        {canPause ? (
          <button type="button" className="ai-panel-button" onClick={props.onPause}>
            Pause
          </button>
        ) : null}
        {task.state === 'paused' ? (
          <button
            type="button"
            className="ai-panel-button"
            onClick={props.onResume}
            disabled={props.resumeDisabled}
          >
            Resume
          </button>
        ) : null}
        {canPause || task.state === 'paused' ? (
          <button type="button" className="ai-panel-button" onClick={props.onStop}>
            Stop
          </button>
        ) : null}
      </div>
    </section>
  );
}

function isTerminalState(state: AutonomousTaskView['state']): boolean {
  return (
    state === 'completed' ||
    state === 'cancelled' ||
    state === 'blocked' ||
    state === 'failed' ||
    state === 'execution-state-unknown'
  );
}

function statusLabel(task: AutonomousTaskView): string {
  switch (task.state) {
    case 'planning':
      return 'Planning';
    case 'running-subgoal':
      return 'Running subgoal';
    case 'awaiting-approval':
      return 'Awaiting approval';
    case 'awaiting-user-input':
      return 'Awaiting reply';
    case 'paused':
      return 'Paused';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'Cancelled';
    case 'blocked':
      return 'Blocked';
    case 'failed':
      return 'Failed';
    case 'execution-state-unknown':
      return 'Stopped';
    default:
      return 'Task';
  }
}
