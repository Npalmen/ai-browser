import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { AiNativeActivitySummary } from '../shared/ai-native-types';
import {
  activityRows,
  applyActivitySummary,
  assistantNeedsAttention,
  emptyActivityUiState,
  hasAttentionBadge,
  hasBackgroundActivity,
  setActivityOpen,
  workflowsNeedAttention,
} from './activity-ui-state';

const ROOT = path.resolve(__dirname, '..', '..');

function summary(overrides: Partial<AiNativeActivitySummary> = {}): AiNativeActivitySummary {
  return {
    ask: { activeCount: 0, selectedContextActive: false },
    act: { activeCount: 0 },
    delegate: { active: false, awaitingUserInput: false },
    approval: { pendingCount: 0 },
    workflows: { runningCount: 0, queuedCount: 0, reviewRequiredCount: 0 },
    attention: null,
    ...overrides,
  };
}

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('activity-ui-state', () => {
  it('starts closed, unloaded, and empty', () => {
    const state = emptyActivityUiState();
    assert.equal(state.open, false);
    assert.equal(state.loaded, false);
    assert.equal(state.error, null);
    assert.equal(state.summary.attention, null);
    assert.equal(hasAttentionBadge(state.summary), false);
    assert.equal(hasBackgroundActivity(state.summary), false);
    assert.deepEqual(activityRows(state.summary), []);
  });

  it('replaces the summary on a successful refresh', () => {
    const next = applyActivitySummary(emptyActivityUiState(), {
      ok: true,
      summary: summary({
        ask: { activeCount: 1, selectedContextActive: false },
        act: { activeCount: 1 },
      }),
    });
    assert.equal(next.loaded, true);
    assert.equal(next.error, null);
    assert.equal(next.summary.ask.activeCount, 1);
    assert.equal(next.summary.act.activeCount, 1);
    assert.equal(hasBackgroundActivity(next.summary), true);
    assert.equal(hasAttentionBadge(next.summary), false);
  });

  it('keeps the last summary when a refresh fails', () => {
    const loaded = applyActivitySummary(emptyActivityUiState(), {
      ok: true,
      summary: summary({
        approval: { pendingCount: 1 },
        attention: { kind: 'approval', tabId: 'tab-a' },
      }),
    });
    const failed = applyActivitySummary(loaded, {
      ok: false,
      error: { code: 'AI_NATIVE_ACTIVITY_FAILED', message: 'Unable to load activity.' },
    });
    assert.equal(failed.loaded, true);
    assert.equal(failed.error, 'Unable to load activity.');
    assert.equal(failed.summary.approval.pendingCount, 1);
    assert.deepEqual(failed.summary.attention, { kind: 'approval', tabId: 'tab-a' });
  });

  it('clears attention after an authoritative zero summary', () => {
    const loaded = applyActivitySummary(emptyActivityUiState(), {
      ok: true,
      summary: summary({
        approval: { pendingCount: 1 },
        attention: { kind: 'approval', tabId: 'tab-a' },
      }),
    });
    const cleared = applyActivitySummary(loaded, { ok: true, summary: summary() });
    assert.equal(cleared.error, null);
    assert.equal(cleared.summary.attention, null);
    assert.equal(hasAttentionBadge(cleared.summary), false);
    assert.deepEqual(activityRows(cleared.summary), []);
  });

  it('toggles open presentation state only', () => {
    const opened = setActivityOpen(emptyActivityUiState(), true);
    assert.equal(opened.open, true);
    assert.equal(opened.summary.attention, null);
    assert.equal(setActivityOpen(opened, false).open, false);
  });

  it('treats approval as attention and workflow progress as background', () => {
    const approval = summary({
      approval: { pendingCount: 1 },
      attention: { kind: 'approval', tabId: 'tab-b' },
    });
    assert.equal(hasAttentionBadge(approval), true);
    assert.equal(assistantNeedsAttention(approval), true);
    assert.equal(workflowsNeedAttention(approval), false);

    const background = summary({
      ask: { activeCount: 1, selectedContextActive: true },
      act: { activeCount: 1 },
      delegate: { active: true, awaitingUserInput: false },
      workflows: { runningCount: 1, queuedCount: 2, reviewRequiredCount: 0 },
    });
    assert.equal(hasAttentionBadge(background), false);
    assert.equal(hasBackgroundActivity(background), true);
    assert.equal(assistantNeedsAttention(background), false);
  });

  it('routes activity rows to Assistant or Workflows without mutation labels', () => {
    const rows = activityRows(
      summary({
        ask: { activeCount: 1, selectedContextActive: false },
        act: { activeCount: 1 },
        delegate: { active: true, awaitingUserInput: true },
        approval: { pendingCount: 1 },
        workflows: { runningCount: 1, queuedCount: 2, reviewRequiredCount: 1 },
        attention: { kind: 'approval', tabId: 'tab-b' },
      }),
    );
    assert.deepEqual(
      rows.map((row) => ({ id: row.id, surface: row.deepLink.surface, attention: row.attention })),
      [
        { id: 'approval', surface: 'assistant', attention: true },
        { id: 'delegate-input', surface: 'assistant', attention: false },
        { id: 'ask', surface: 'assistant', attention: false },
        { id: 'act', surface: 'assistant', attention: false },
        { id: 'workflow-running', surface: 'workflows', attention: false },
        { id: 'workflow-queued', surface: 'workflows', attention: false },
        { id: 'workflow-review', surface: 'workflows', attention: false },
      ],
    );
    assert.equal(rows[0]?.deepLink.surface === 'assistant' ? rows[0].deepLink.tabId : undefined, 'tab-b');
    assert.equal(
      rows.some((row) => /approve|reject|run now|enable|stop|pause|resume|reply/i.test(row.label)),
      false,
    );
  });
});

describe('Activity UI integration', () => {
  it('deep-links Activity rows to Assistant or Workflows only', () => {
    const popover = readSrc('src/app-ui/ActivitySummary.tsx');
    const state = readSrc('src/app-ui/activity-ui-state.ts');
    const app = readSrc('src/app-ui/App.tsx');
    assert.match(popover, /props\.onSelect\(row\.deepLink\)/);
    assert.match(state, /surface: 'assistant'/);
    assert.match(state, /surface: 'workflows'/);
    const handler = app.slice(
      app.indexOf('const handleActivitySelect'),
      app.indexOf('const updateActiveTabAi'),
    );
    assert.match(handler, /openRightPanel\('workflows'\)/);
    assert.match(handler, /openRightPanel\('assistant'\)/);
    assert.match(handler, /activateTab\(target\.tabId\)/);
    for (const banned of [
      'decideApproval',
      'runNow',
      'setEnabled',
      'acknowledgeReview',
      'pauseAutonomousTask',
      'resumeAutonomousTask',
      'stopAutonomousTask',
      'replyToAutonomousTask',
      'cancelQueued',
      'workflows.delete',
      'workflows.stop',
    ]) {
      assert.equal(handler.includes(banned), false, banned);
    }
  });

  it('contains no approval, workflow, or task mutation controls', () => {
    const popover = readSrc('src/app-ui/ActivitySummary.tsx');
    const state = readSrc('src/app-ui/activity-ui-state.ts');
    for (const source of [popover, state]) {
      for (const banned of [
        'Approve',
        'Reject',
        'Approve all',
        'Remember approval',
        'Execute',
        'Confirm action',
        'decideApproval',
        'runNow',
        'setEnabled',
        'acknowledgeReview',
        'pauseAutonomousTask',
        'resumeAutonomousTask',
        'stopAutonomousTask',
        'replyToAutonomousTask',
      ]) {
        assert.equal(source.includes(banned), false, banned);
      }
    }
    assert.match(popover, /No active AI activity/);
  });

  it('closes Activity and the context picker when approval dominates, without discarding the AI draft', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const start = app.indexOf("event.type === 'approval-required'");
    assert.ok(start >= 0);
    const approvalBlock = app.slice(start, start + 900);
    assert.match(approvalBlock, /setActivityOpen\(current, false\)/);
    assert.match(approvalBlock, /closeContextPicker/);
    assert.match(approvalBlock, /setRightPanelSurface\('assistant'\)/);
    assert.match(approvalBlock, /setPanelOpen\(true\)/);
    assert.equal(approvalBlock.includes('setAiDraftForm(null)'), false);
    assert.equal(approvalBlock.includes('decideApproval'), false);
    assert.equal(approvalBlock.includes('generateWorkflowDraft'), false);
    assert.match(app, /const \[aiDraftForm, setAiDraftForm\]/);
    assert.equal(app.includes('localStorage'), false);
    assert.equal(app.includes('setInterval'), false);
  });

  it('derives chrome attention from ActivitySummary and refreshes from trusted events', () => {
    const app = readSrc('src/app-ui/App.tsx');
    assert.match(app, /getActivitySummary\(\)/);
    assert.match(app, /assistantNeedsAttention\(activityState\.summary\)/);
    assert.match(app, /hasAttentionBadge\(activityState\.summary\)/);
    assert.match(app, /hasBackgroundActivity\(activityState\.summary\)/);
    assert.match(app, /workflowsNeedAttention\(activityState\.summary\)/);
    assert.match(app, /<ActivityPopover/);
    assert.match(app, /queueActivityRefresh/);
    assert.match(app, /onAnswerEvent/);
    assert.match(app, /onContextAnswerEvent/);
    assert.match(app, /onApprovalEvent/);
    assert.match(app, /onAutonomousTaskEvent/);
    assert.match(app, /workflows\.onStateChanged/);
    assert.equal(app.includes('hasAutonomousTaskAttention(taskUiState)'), false);
  });
});
