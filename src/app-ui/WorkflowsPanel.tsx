import { useEffect, useMemo, useState, type FormEvent } from 'react';

import type {
  WorkflowProductError,
  WorkflowProductTrigger,
  WorkflowSummaryView,
} from '../shared/workflow-product-types';
import {
  applyWorkflowDetailResult,
  applyWorkflowOperationError,
  applyWorkflowStateResult,
  beginWorkflowCreate,
  beginWorkflowMutation,
  emptyWorkflowUiState,
  endWorkflowMutation,
  selectWorkflow,
  setWorkflowConfirmDelete,
  showWorkflowList,
  workflowStorageLocked,
} from './workflow-ui-state';
import {
  emptyWorkflowForm,
  workflowCreateInputFromForm,
  workflowFormFromDetail,
  workflowTriggerFromForm,
  type WorkflowFormState,
} from './workflow-draft-ui-state';

const WEEKDAYS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Monday' },
  { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' },
  { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
  { value: 7, label: 'Sunday' },
];

function triggerLabel(trigger: WorkflowProductTrigger): string {
  if (trigger.kind === 'manual') {
    return 'Manual';
  }
  if (trigger.schedule.kind === 'one-time') {
    return 'One time';
  }
  if (trigger.schedule.kind === 'recurring-daily') {
    return 'Daily';
  }
  return 'Weekly';
}

function formatInstant(value: string | null): string {
  if (!value) {
    return 'None';
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}

function lastResultLabel(workflow: WorkflowSummaryView): string {
  if (!workflow.lastResult) {
    return 'No finished run';
  }
  return `${workflow.lastResult.state} · ${formatInstant(workflow.lastResult.finishedAt)}`;
}

export function WorkflowsPanel(props: {
  onClose: () => void;
  aiDraftForm?: WorkflowFormState | null;
  onAiDraftFormChange?: (form: WorkflowFormState) => void;
  onDiscardAiDraft?: () => void;
  onAiDraftSaved?: (workflowId?: string) => void;
}) {
  const [state, setState] = useState(emptyWorkflowUiState);
  const [draft, setDraft] = useState<WorkflowFormState>(emptyWorkflowForm());
  const locked = workflowStorageLocked(state);
  const selected = useMemo(
    () => state.workflows.find((workflow) => workflow.workflowId === state.selectedWorkflowId) ?? null,
    [state.workflows, state.selectedWorkflowId],
  );

  const refreshState = () => {
    void window.workflows
      .getState()
      .then((result) => {
        setState((current) => applyWorkflowStateResult(current, result));
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to load workflows:', error);
      });
  };

  const refreshDetail = (workflowId: string, requestId: number) => {
    void window.workflows
      .getDetail({ workflowId })
      .then((result) => {
        setState((current) => applyWorkflowDetailResult(current, requestId, result));
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to load workflow detail:', error);
      });
  };

  useEffect(() => {
    refreshState();
    const unsubscribe = window.workflows.onStateChanged(() => {
      refreshState();
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!state.selectedWorkflowId || state.screen !== 'detail') {
      return;
    }
    refreshDetail(state.selectedWorkflowId, state.detailRequestId);
  }, [state.selectedWorkflowId, state.detailRequestId, state.screen]);

  useEffect(() => {
    if (state.detail && state.screen === 'detail') {
      setDraft(workflowFormFromDetail(state.detail));
    }
  }, [state.detail, state.screen]);

  const runMutation = (
    action: () => Promise<{ ok: true; workflowId?: string } | { ok: false; error: WorkflowProductError }>,
    options: { select?: boolean; closeDetail?: boolean; clearAiDraft?: boolean } = {},
  ) => {
    if (state.mutating || locked) {
      return;
    }
    setState((current) => beginWorkflowMutation(current));
    void action()
      .then((result) => {
        if (!result.ok) {
          setState((current) => applyWorkflowOperationError(current, result.error));
          return;
        }
        if (options.closeDetail) {
          setState((current) => showWorkflowList(endWorkflowMutation(current)));
        } else if (options.select && result.workflowId) {
          setState((current) => selectWorkflow(endWorkflowMutation(current), result.workflowId as string));
          if (options.clearAiDraft) {
            props.onAiDraftSaved?.(result.workflowId);
          }
        } else {
          setState((current) => endWorkflowMutation(current));
        }
        refreshState();
      })
      .catch((error: unknown) => {
        console.error('[app-ui] workflow mutation failed:', error);
        setState((current) =>
          applyWorkflowOperationError(current, {
            code: 'WORKFLOW_OPERATION_FAILED',
            message: 'The workflow operation failed.',
          }),
        );
      });
  };

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    const input = workflowCreateInputFromForm(draft);
    if (!input) {
      setState((current) =>
        applyWorkflowOperationError(current, {
          code: 'WORKFLOW_INVALID_REQUEST',
          message: 'The workflow request was invalid.',
        }),
      );
      return;
    }
    runMutation(() => window.workflows.create(input), { select: true });
  };

  const handleSaveAiDraft = (event: FormEvent) => {
    event.preventDefault();
    if (!props.aiDraftForm) {
      return;
    }
    const input = workflowCreateInputFromForm(props.aiDraftForm);
    if (!input) {
      setState((current) =>
        applyWorkflowOperationError(current, {
          code: 'WORKFLOW_INVALID_REQUEST',
          message: 'The workflow request was invalid.',
        }),
      );
      return;
    }
    runMutation(() => window.workflows.create(input), { select: true, clearAiDraft: true });
  };

  const handleSave = (event: FormEvent) => {
    event.preventDefault();
    if (!state.selectedWorkflowId) {
      return;
    }
    const trigger = workflowTriggerFromForm(draft);
    if (!trigger) {
      setState((current) =>
        applyWorkflowOperationError(current, {
          code: 'WORKFLOW_INVALID_REQUEST',
          message: 'The workflow request was invalid.',
        }),
      );
      return;
    }
    runMutation(() =>
      window.workflows.edit({
        workflowId: state.selectedWorkflowId as string,
        name: draft.name,
        objective: draft.objective,
        entryPoint: { kind: 'url', url: draft.url },
        trigger,
      }),
    );
  };

  return (
    <aside className="ai-side-panel workflow-panel" aria-label="Workflows">
      <div className="ai-panel-header">
        <h2 className="ai-panel-title">Workflows</h2>
        <button type="button" className="ai-panel-close" onClick={props.onClose} aria-label="Close workflows">
          Close
        </button>
      </div>

      {state.status === 'loading' || state.status === 'not-initialized' ? (
        <p className="workflow-status">Loading workflows…</p>
      ) : null}

      {state.status === 'storage-error' ? (
        <p className="workflow-status workflow-status-error" role="alert">
          Persistent workflows are unavailable because their local data could not be loaded safely.
          Manual browser and AI features remain available.
        </p>
      ) : null}

      {state.operationError ? (
        <p className="workflow-status workflow-status-error" role="alert">
          {state.operationError}
        </p>
      ) : null}

      {props.aiDraftForm ? (
        <form className="workflow-body workflow-form workflow-ai-draft" onSubmit={handleSaveAiDraft}>
          <p className="workflow-ai-draft-label">AI-generated draft</p>
          <h3 className="workflow-subtitle">Review AI workflow draft</h3>
          <WorkflowFormFields
            draft={props.aiDraftForm}
            onChange={(form) => props.onAiDraftFormChange?.(form)}
            includeEnabled
            enabledLabel="Enable after saving"
            locked={locked || state.mutating}
            triggerName="ai-workflow-trigger"
          />
          <div className="workflow-actions">
            <button type="submit" className="workflow-button" disabled={locked || state.mutating}>
              Save workflow
            </button>
            <button
              type="button"
              className="workflow-button"
              disabled={state.mutating}
              onClick={() => props.onDiscardAiDraft?.()}
            >
              Discard draft
            </button>
          </div>
        </form>
      ) : null}

      {!props.aiDraftForm && state.screen === 'list' ? (
        <div className="workflow-body">
          <div className="workflow-toolbar">
            <button
              type="button"
              className="workflow-button"
              disabled={locked}
              onClick={() => {
                setDraft(emptyWorkflowForm());
                setState((current) => beginWorkflowCreate(current));
              }}
            >
              New workflow
            </button>
          </div>
          {state.workflows.length === 0 && state.status === 'ready' ? (
            <p className="workflow-empty">No workflows yet.</p>
          ) : (
            <ul className="workflow-list">
              {state.workflows.map((workflow) => (
                <li key={workflow.workflowId}>
                  <button
                    type="button"
                    className="workflow-list-item"
                    onClick={() => setState((current) => selectWorkflow(current, workflow.workflowId))}
                  >
                    <span className="workflow-list-name">{workflow.name}</span>
                    <span className="workflow-list-meta">
                      {workflow.enabled ? 'Enabled' : 'Disabled'} · {triggerLabel(workflow.trigger)}
                    </span>
                    <span className="workflow-list-meta">Next run: {formatInstant(workflow.nextRunAt)}</span>
                    <span className="workflow-list-meta">
                      Queued: {workflow.queuedCount}
                      {workflow.running ? ' · Running' : ''}
                    </span>
                    <span className="workflow-list-meta">{lastResultLabel(workflow)}</span>
                    {workflow.reviewRequired ? (
                      <span className="workflow-badge">Review required</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {!props.aiDraftForm && state.screen === 'create' ? (
        <form className="workflow-body workflow-form" onSubmit={handleCreate}>
          <button type="button" className="workflow-link" onClick={() => setState((current) => showWorkflowList(current))}>
            Back to list
          </button>
          <h3 className="workflow-subtitle">New workflow</h3>
          <WorkflowFormFields draft={draft} onChange={setDraft} includeEnabled locked={locked || state.mutating} triggerName="workflow-trigger-create" />
          <button type="submit" className="workflow-button" disabled={locked || state.mutating}>
            Create workflow
          </button>
        </form>
      ) : null}

      {!props.aiDraftForm && state.screen === 'detail' && selected ? (
        <div className="workflow-body">
          <button type="button" className="workflow-link" onClick={() => setState((current) => showWorkflowList(current))}>
            Back to list
          </button>
          <h3 className="workflow-subtitle">{selected.name}</h3>
          {selected.reviewRequired ? (
            <div className="workflow-review" role="status">
              <p>
                {selected.lastResult?.state === 'execution-state-unknown'
                  ? 'The last browser action may have happened. This workflow is paused to avoid repeating it.'
                  : selected.lastResult?.state === 'interrupted'
                    ? 'The previous run ended when the app/runtime stopped. It will not be resumed automatically.'
                    : 'This workflow requires review before future runs.'}
              </p>
              <p>The previous run will not be resumed or replayed. Acknowledging only allows future runs again.</p>
              <button
                type="button"
                className="workflow-button"
                disabled={locked || state.mutating}
                onClick={() => runMutation(() => window.workflows.acknowledgeReview({ workflowId: selected.workflowId }))}
              >
                Acknowledge and allow future runs
              </button>
            </div>
          ) : null}

          <p className="workflow-list-meta">
            {selected.enabled ? 'Enabled' : 'Disabled'} · {triggerLabel(selected.trigger)} · Next run:{' '}
            {formatInstant(selected.nextRunAt)}
          </p>
          {selected.running ? <p className="workflow-badge">Running</p> : null}
          <p className="workflow-list-meta">{lastResultLabel(selected)}</p>
          {selected.running ? (
            <p className="workflow-note">This run continues. Disabling prevents future starts.</p>
          ) : null}

          <div className="workflow-actions">
            <button
              type="button"
              className="workflow-button"
              disabled={locked || state.mutating}
              onClick={() =>
                runMutation(() =>
                  window.workflows.setEnabled({ workflowId: selected.workflowId, enabled: !selected.enabled }),
                )
              }
            >
              {selected.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              className="workflow-button"
              disabled={locked || state.mutating || !selected.enabled || selected.reviewRequired}
              onClick={() => runMutation(() => window.workflows.runNow({ workflowId: selected.workflowId }))}
            >
              Run now
            </button>
            {selected.running ? (
              <button
                type="button"
                className="workflow-button"
                disabled={locked || state.mutating}
                onClick={() => runMutation(() => window.workflows.stop({ workflowId: selected.workflowId }))}
              >
                Stop current run
              </button>
            ) : null}
          </div>
          <p className="workflow-note">Run now queues a durable occurrence. It does not mean the run has started.</p>

          <form className="workflow-form" onSubmit={handleSave}>
            <h4 className="workflow-subtitle">Edit workflow</h4>
            <p className="workflow-note">
              Changes apply only to future queued runs. Existing queued/running runs retain their saved definition.
            </p>
            <WorkflowFormFields draft={draft} onChange={setDraft} includeEnabled={false} locked={locked || state.mutating} triggerName="workflow-trigger-edit" />
            <button type="submit" className="workflow-button" disabled={locked || state.mutating}>
              Save changes
            </button>
          </form>

          <section className="workflow-history" aria-label="History">
            <h4 className="workflow-subtitle">History</h4>
            {(state.detail?.occurrences ?? []).length === 0 ? (
              <p className="workflow-empty">No runs yet.</p>
            ) : (
              <ul className="workflow-history-list">
                {(state.detail?.occurrences ?? []).map((occurrence) => (
                  <li key={occurrence.occurrenceId} className="workflow-history-item">
                    <p>
                      {occurrence.state} · {occurrence.source}
                    </p>
                    <p className="workflow-list-meta">Created: {formatInstant(occurrence.createdAt)}</p>
                    {occurrence.scheduledFor ? (
                      <p className="workflow-list-meta">Scheduled: {formatInstant(occurrence.scheduledFor)}</p>
                    ) : null}
                    {occurrence.startedAt ? (
                      <p className="workflow-list-meta">Started: {formatInstant(occurrence.startedAt)}</p>
                    ) : null}
                    {occurrence.finishedAt ? (
                      <p className="workflow-list-meta">Finished: {formatInstant(occurrence.finishedAt)}</p>
                    ) : null}
                    {occurrence.terminalReason ? (
                      <p className="workflow-list-meta">Reason: {occurrence.terminalReason}</p>
                    ) : null}
                    {occurrence.finalAnswer ? <p className="workflow-list-meta">{occurrence.finalAnswer}</p> : null}
                    {occurrence.state === 'queued' ? (
                      <button
                        type="button"
                        className="workflow-button"
                        disabled={locked || state.mutating}
                        onClick={() =>
                          runMutation(() =>
                            window.workflows.cancelQueued({
                              workflowId: selected.workflowId,
                              occurrenceId: occurrence.occurrenceId,
                            }),
                          )
                        }
                      >
                        Cancel queued run
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="workflow-danger">
            {selected.running ? (
              <p className="workflow-note">Stop the current run before deleting this workflow.</p>
            ) : null}
            {state.confirmDelete ? (
              <div className="workflow-actions">
                <button
                  type="button"
                  className="workflow-button"
                  disabled={locked || state.mutating || selected.running}
                  onClick={() => runMutation(() => window.workflows.delete({ workflowId: selected.workflowId }), { closeDetail: true })}
                >
                  Confirm delete
                </button>
                <button
                  type="button"
                  className="workflow-button"
                  onClick={() => setState((current) => setWorkflowConfirmDelete(current, false))}
                >
                  Keep workflow
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="workflow-button"
                disabled={locked || state.mutating}
                onClick={() => setState((current) => setWorkflowConfirmDelete(current, true))}
              >
                Delete workflow
              </button>
            )}
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function WorkflowFormFields(props: {
  draft: WorkflowFormState;
  onChange: (draft: WorkflowFormState) => void;
  includeEnabled: boolean;
  enabledLabel?: string;
  locked: boolean;
  triggerName: string;
}) {
  const { draft, locked } = props;
  const update = (patch: Partial<WorkflowFormState>) => props.onChange({ ...draft, ...patch });
  return (
    <>
      <label className="workflow-field">
        Name
        <input
          className="workflow-input"
          value={draft.name}
          disabled={locked}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      <label className="workflow-field">
        Objective
        <textarea
          className="workflow-input"
          value={draft.objective}
          disabled={locked}
          rows={4}
          onChange={(event) => update({ objective: event.target.value })}
        />
      </label>
      <label className="workflow-field">
        Start URL
        <input
          className="workflow-input"
          value={draft.url}
          disabled={locked}
          onChange={(event) => update({ url: event.target.value })}
        />
      </label>
      <fieldset className="workflow-field" disabled={locked}>
        <legend>Trigger</legend>
        <label>
          <input
            type="radio"
            name={props.triggerName}
            checked={draft.triggerKind === 'manual'}
            onChange={() => update({ triggerKind: 'manual' })}
          />
          Manual
        </label>
        <label>
          <input
            type="radio"
            name={props.triggerName}
            checked={draft.triggerKind === 'one-time'}
            onChange={() => update({ triggerKind: 'one-time' })}
          />
          One time
        </label>
        <label>
          <input
            type="radio"
            name={props.triggerName}
            checked={draft.triggerKind === 'daily'}
            onChange={() => update({ triggerKind: 'daily' })}
          />
          Daily
        </label>
        <label>
          <input
            type="radio"
            name={props.triggerName}
            checked={draft.triggerKind === 'weekly'}
            onChange={() => update({ triggerKind: 'weekly' })}
          />
          Weekly
        </label>
      </fieldset>
      {draft.triggerKind === 'one-time' ? (
        <label className="workflow-field">
          Run at
          <input
            type="datetime-local"
            className="workflow-input"
            value={draft.runAtLocal}
            disabled={locked}
            onChange={(event) => update({ runAtLocal: event.target.value })}
          />
        </label>
      ) : null}
      {draft.triggerKind === 'daily' || draft.triggerKind === 'weekly' ? (
        <>
          <label className="workflow-field">
            Time
            <input
              type="time"
              className="workflow-input"
              value={`${String(Number(draft.hour) || 0).padStart(2, '0')}:${String(Number(draft.minute) || 0).padStart(2, '0')}`}
              disabled={locked}
              onChange={(event) => {
                const [hour, minute] = event.target.value.split(':');
                update({ hour: String(Number(hour)), minute: String(Number(minute)) });
              }}
            />
          </label>
          <label className="workflow-field">
            Time zone
            <input
              className="workflow-input"
              value={draft.timeZone}
              disabled={locked}
              onChange={(event) => update({ timeZone: event.target.value })}
            />
          </label>
        </>
      ) : null}
      {draft.triggerKind === 'weekly' ? (
        <fieldset className="workflow-field" disabled={locked}>
          <legend>Days</legend>
          {WEEKDAYS.map((day) => (
            <label key={day.value}>
              <input
                type="checkbox"
                checked={draft.daysOfWeek.includes(day.value)}
                onChange={(event) => {
                  const next = event.target.checked
                    ? [...draft.daysOfWeek, day.value]
                    : draft.daysOfWeek.filter((value) => value !== day.value);
                  update({ daysOfWeek: next });
                }}
              />
              {day.label}
            </label>
          ))}
        </fieldset>
      ) : null}
      {props.includeEnabled ? (
        <label className="workflow-field">
          <input
            type="checkbox"
            checked={draft.enabled}
            disabled={locked}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          {props.enabledLabel ?? 'Enabled'}
        </label>
      ) : null}
    </>
  );
}

