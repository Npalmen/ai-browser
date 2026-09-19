import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { WorkflowDetailView, WorkflowSummaryView } from '../shared/workflow-product-types';
import {
  applyWorkflowDetailResult,
  applyWorkflowStateResult,
  emptyWorkflowUiState,
  selectWorkflow,
} from './workflow-ui-state';

const ROOT = path.resolve(__dirname, '..', '..');

describe('workflow UI state', () => {
  it('rejects stale detail responses after a newer selection', () => {
    let state = emptyWorkflowUiState();
    state = applyWorkflowStateResult(state, {
      ok: true,
      status: 'ready',
      workflows: [summary('wf-a'), summary('wf-b')],
    });
    state = selectWorkflow(state, 'wf-a');
    const requestA = state.detailRequestId;
    state = selectWorkflow(state, 'wf-b');
    const requestB = state.detailRequestId;
    state = applyWorkflowDetailResult(state, requestA, { ok: true, workflow: detail('wf-a') });
    assert.equal(state.detail, null);
    assert.equal(state.selectedWorkflowId, 'wf-b');
    state = applyWorkflowDetailResult(state, requestB, { ok: true, workflow: detail('wf-b') });
    assert.equal(state.detail?.workflowId, 'wf-b');
  });

  it('keeps storage-error visible without offering recovery', () => {
    const state = applyWorkflowStateResult(emptyWorkflowUiState(), {
      ok: true,
      status: 'storage-error',
      workflows: [],
    });
    assert.equal(state.status, 'storage-error');
    const panel = readFileSync(path.join(ROOT, 'src/app-ui/WorkflowsPanel.tsx'), 'utf8');
    assert.match(panel, /Persistent workflows are unavailable because their local data could not be loaded safely/);
    assert.equal(panel.includes('Reset'), false);
    assert.equal(panel.includes('Restore backup'), false);
    assert.equal(panel.includes('Retry'), false);
  });

  it('keeps Ask/Act/Delegate separate and switches to assistant for approval', () => {
    const app = readFileSync(path.join(ROOT, 'src/app-ui/App.tsx'), 'utf8');
    const panel = readFileSync(path.join(ROOT, 'src/app-ui/AiSidePanel.tsx'), 'utf8');
    const workflows = readFileSync(path.join(ROOT, 'src/app-ui/WorkflowsPanel.tsx'), 'utf8');
    assert.match(app, /rightPanelSurface/);
    assert.match(app, /setRightPanelSurface\('assistant'\)/);
    assert.match(app, /Workflows/);
    assert.match(panel, /onModeChange\('read'\)/);
    assert.match(panel, /onModeChange\('interact'\)/);
    assert.match(panel, /onModeChange\('delegate'\)/);
    assert.equal(panel.includes("onModeChange('workflow')"), false);
    assert.equal(workflows.includes('tabId'), false);
    assert.equal(workflows.includes('taskId'), false);
    assert.equal(workflows.includes('approvalId'), false);
    assert.equal(workflows.includes('triggerKey'), false);
    assert.equal(workflows.includes('runtimeSessionId'), false);
    assert.equal(workflows.includes('Approve all'), false);
    assert.equal(workflows.includes('approve workflow'), false);
  });
});

function summary(workflowId: string): WorkflowSummaryView {
  return {
    workflowId,
    name: workflowId,
    enabled: true,
    reviewRequired: false,
    definitionRevision: 1,
    trigger: { kind: 'manual' },
    nextRunAt: null,
    queuedCount: 0,
    running: false,
    lastResult: null,
  };
}

function detail(workflowId: string): WorkflowDetailView {
  return {
    workflowId,
    definitionRevision: 1,
    name: workflowId,
    objective: 'Do work',
    entryPoint: { kind: 'url', url: 'https://example.test' },
    trigger: { kind: 'manual' },
    enabled: true,
    reviewRequired: false,
    createdAt: '2026-09-19T10:00:00.000Z',
    updatedAt: '2026-09-19T10:00:00.000Z',
    nextRunAt: null,
    occurrences: [],
  };
}
