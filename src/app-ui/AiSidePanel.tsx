import type { FormEvent, KeyboardEvent } from 'react';

import { AI_SIDE_PANEL_WIDTH_PX } from '../shared/ai-types';
import type { AiPanelMode, AutonomousTaskView } from '../shared/autonomous-task-types';

import type { AiTranscriptEntry } from './ai-ui-state';
import type { ContextAnswerEntry } from './context-answer-ui-state';
import { ApprovalCard } from './ApprovalCard';
import type { TabApprovalUiState } from './approval-ui-state';
import { AutonomousTaskCard } from './AutonomousTaskCard';

export function AiSidePanel(props: {
  hasActiveTab: boolean;
  entries: AiTranscriptEntry[];
  isAsking: boolean;
  contextAnswerEntries: readonly ContextAnswerEntry[];
  isContextAsking: boolean;
  approvalBusy: boolean;
  mode: AiPanelMode;
  draft: string;
  onDraftChange: (value: string) => void;
  onModeChange: (mode: AiPanelMode) => void;
  onAsk: () => void;
  onDelegate: () => void;
  onTaskReply: () => void;
  onStop: () => void;
  onContextStop: () => void;
  onClear: () => void;
  onClose: () => void;
  approval?: TabApprovalUiState;
  onApprove?: () => void;
  onReject?: () => void;
  tasks: readonly AutonomousTaskView[];
  startError?: string;
  replyDraftByTaskId: Record<string, string>;
  onReplyDraftChange: (taskId: string, value: string) => void;
  onPauseTask: (taskId: string) => void;
  onResumeTask: (taskId: string) => void;
  onStopTask: (taskId: string) => void;
  onReplyTask: (taskId: string) => void;
}) {
  const awaitingUserInput = props.tasks.find((task) => task.state === 'awaiting-user-input');
  const awaitingTaskApproval = props.tasks.some((task) => task.state === 'awaiting-approval');
  const hasActiveTask = props.tasks.some(
    (task) =>
      task.state === 'planning' ||
      task.state === 'running-subgoal' ||
      task.state === 'awaiting-approval' ||
      task.state === 'awaiting-user-input',
  );
  const askInputLocked = props.isAsking || props.approvalBusy;
  const delegateInputLocked = awaitingTaskApproval;
  const inputLocked = props.mode === 'delegate' ? delegateInputLocked : askInputLocked;
  const canAsk =
    props.mode !== 'delegate' &&
    props.hasActiveTab &&
    props.draft.trim().length > 0 &&
    !askInputLocked;
  const canDelegate =
    props.mode === 'delegate' &&
    !awaitingUserInput &&
    props.hasActiveTab &&
    props.draft.trim().length > 0 &&
    !delegateInputLocked &&
    !hasActiveTask;
  const canReply =
    props.mode === 'delegate' &&
    awaitingUserInput !== undefined &&
    props.draft.trim().length > 0 &&
    !awaitingTaskApproval;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (awaitingTaskApproval) {
      return;
    }
    if (canReply) {
      props.onTaskReply();
      return;
    }
    if (canDelegate) {
      props.onDelegate();
      return;
    }
    if (canAsk) {
      props.onAsk();
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (awaitingTaskApproval) {
        return;
      }
      if (canReply) {
        props.onTaskReply();
        return;
      }
      if (canDelegate) {
        props.onDelegate();
        return;
      }
      if (canAsk) {
        props.onAsk();
      }
    }
  };

  const placeholder =
    props.mode === 'delegate'
      ? awaitingUserInput
        ? 'Reply to the task'
        : 'Describe a delegated task'
      : props.mode === 'interact'
        ? 'Describe one action'
        : 'Ask about this page';

  const submitLabel =
    props.mode === 'delegate' ? (awaitingUserInput ? 'Reply' : 'Delegate') : props.mode === 'interact' ? 'Act' : 'Ask';

  return (
    <aside
      className="ai-side-panel"
      style={{ width: AI_SIDE_PANEL_WIDTH_PX }}
      aria-label="AI assistant"
    >
      <header className="ai-panel-header">
        <h1 className="ai-panel-title">AI assistant</h1>
        <div className="ai-panel-header-actions">
          <button type="button" className="ai-panel-button" onClick={props.onClear}>
            Clear
          </button>
          <button
            type="button"
            className="ai-panel-button"
            onClick={props.onClose}
            aria-label="Close AI panel"
          >
            Close
          </button>
        </div>
      </header>

      <div className="ai-mode-selector" role="group" aria-label="AI request mode">
        <button
          type="button"
          className={`ai-mode-button ${props.mode === 'read' ? 'ai-mode-button-active' : ''}`}
          disabled={askInputLocked}
          aria-pressed={props.mode === 'read'}
          onClick={() => props.onModeChange('read')}
        >
          Ask
        </button>
        <button
          type="button"
          className={`ai-mode-button ${props.mode === 'interact' ? 'ai-mode-button-active' : ''}`}
          disabled={askInputLocked}
          aria-pressed={props.mode === 'interact'}
          onClick={() => props.onModeChange('interact')}
        >
          Act
        </button>
        <button
          type="button"
          className={`ai-mode-button ${props.mode === 'delegate' ? 'ai-mode-button-active' : ''}`}
          disabled={askInputLocked}
          aria-pressed={props.mode === 'delegate'}
          onClick={() => props.onModeChange('delegate')}
        >
          Delegate
        </button>
      </div>

      <div className="ai-panel-body">
        {props.approval && props.approval.status !== 'idle' && props.approval.approval ? (
          <ApprovalCard
            approval={props.approval.approval}
            status={props.approval.status}
            message={props.approval.message}
            busy={props.approvalBusy}
            onApprove={() => props.onApprove?.()}
            onReject={() => props.onReject?.()}
          />
        ) : null}
        {props.tasks.map((task) => (
          <AutonomousTaskCard
            key={task.taskId}
            task={task}
            replyDraft={
              task.state === 'awaiting-user-input' && props.mode === 'delegate'
                ? props.draft
                : props.replyDraftByTaskId[task.taskId] ?? ''
            }
            onReplyDraftChange={(value) => {
              if (task.state === 'awaiting-user-input' && props.mode === 'delegate') {
                props.onDraftChange(value);
                return;
              }
              props.onReplyDraftChange(task.taskId, value);
            }}
            onPause={() => props.onPauseTask(task.taskId)}
            onResume={() => props.onResumeTask(task.taskId)}
            onStop={() => props.onStopTask(task.taskId)}
            onReply={() => props.onReplyTask(task.taskId)}
            resumeDisabled={hasActiveTask}
          />
        ))}
        {props.startError ? <p className="autonomous-task-start-error">{props.startError}</p> : null}
        {props.contextAnswerEntries.length > 0 ? (
          <section className="context-answer-section" aria-label="Selected tabs">
            <div className="context-answer-header">
              <h2 className="context-answer-title">Selected tabs</h2>
              {props.isContextAsking ? (
                <button
                  type="button"
                  className="ai-panel-button ai-panel-button-primary context-answer-stop"
                  onClick={props.onContextStop}
                >
                  Stop
                </button>
              ) : null}
            </div>
            {props.contextAnswerEntries.map((entry) => (
              <article
                key={entry.id}
                className={`ai-message ai-message-${entry.role} context-answer-message${
                  entry.status === 'error' ? ' ai-message-error' : ''
                }${entry.status === 'cancelled' ? ' ai-message-cancelled' : ''}`}
              >
                <div className="ai-message-label">
                  {entry.role === 'user' ? 'You' : 'Assistant'}
                </div>
                {entry.role === 'assistant' && entry.status === 'error' ? (
                  <div className="ai-message-text">
                    {entry.text}
                    {entry.errorMessage ? (
                      <div className="ai-message-error-detail">{entry.errorMessage}</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="ai-message-text">{entry.text}</div>
                )}
                {entry.role === 'assistant' && entry.status === 'complete' && entry.truncatedContext ? (
                  <p className="ai-truncated-note">
                    Some page content was omitted to fit the AI context.
                  </p>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}
        {props.entries.length === 0 &&
        props.contextAnswerEntries.length === 0 &&
        props.tasks.length === 0 &&
        !props.startError &&
        !(props.approval && props.approval.status !== 'idle' && props.approval.approval) ? (
          <p className="ai-empty-state">
            {props.mode === 'delegate'
              ? 'Delegate a task. The assistant plans and works in the background.'
              : props.mode === 'interact'
                ? 'Describe one action for the current page.'
                : 'Ask a question about the current page.'}
          </p>
        ) : (
          props.entries.map((entry) => (
            <article
              key={entry.id}
              className={`ai-message ai-message-${entry.role}${
                entry.status === 'error' ? ' ai-message-error' : ''
              }${entry.status === 'cancelled' ? ' ai-message-cancelled' : ''}${
                entry.status === 'denied' ? ' ai-message-denied' : ''
              }${entry.status === 'blocked' ? ' ai-message-denied' : ''}${
                entry.status === 'unknown' ? ' ai-message-error' : ''
              }`}
            >
              <div className="ai-message-label">
                {entry.role === 'user' ? 'You' : assistantLabel(entry)}
              </div>
              {entry.role === 'assistant' &&
              (entry.status === 'error' ||
                entry.status === 'denied' ||
                entry.status === 'blocked' ||
                entry.status === 'unknown') ? (
                <div className="ai-message-text">
                  {entry.text}
                  {entry.errorMessage ? (
                    <div className="ai-message-error-detail">{entry.errorMessage}</div>
                  ) : null}
                </div>
              ) : (
                <div className="ai-message-text">{entry.text}</div>
              )}
              {entry.role === 'assistant' && entry.status === 'complete' && entry.truncatedContext ? (
                <p className="ai-truncated-note">
                  Some page content was omitted to fit the AI context.
                </p>
              ) : null}
            </article>
          ))
        )}
      </div>

      <form className="ai-panel-footer" onSubmit={handleSubmit}>
        <textarea
          className="ai-question-input"
          value={props.draft}
          placeholder={placeholder}
          disabled={!props.hasActiveTab || inputLocked}
          rows={3}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="ai-panel-footer-actions">
          {props.isAsking && props.mode !== 'delegate' ? (
            <button type="button" className="ai-panel-button ai-panel-button-primary" onClick={props.onStop}>
              Stop
            </button>
          ) : (
            <button
              type="submit"
              className="ai-panel-button ai-panel-button-primary"
              disabled={!(canAsk || canDelegate || canReply)}
            >
              {submitLabel}
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function assistantLabel(entry: AiTranscriptEntry): string {
  if (entry.status === 'streaming' || entry.status === 'working') {
    return 'Assistant';
  }
  if (entry.status === 'awaiting-approval') {
    return 'Assistant';
  }
  if (entry.status === 'cancelled') {
    return 'Assistant (cancelled)';
  }
  if (entry.status === 'denied' || entry.status === 'blocked') {
    return 'Assistant';
  }
  if (entry.status === 'approval') {
    return 'Assistant';
  }
  if (entry.status === 'unknown') {
    return 'Assistant';
  }
  if (entry.status === 'error') {
    return 'Assistant';
  }
  return 'Assistant';
}
