import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import type { WorkflowDraft } from '../shared/ai-native-types';
import {
  emptyWorkflowForm,
  workflowCreateInputFromForm,
  workflowFormFromAiDraft,
} from './workflow-draft-ui-state';

const ROOT = path.resolve(__dirname, '..', '..');

function weeklyDraft(): WorkflowDraft {
  return {
    name: 'Weekday status',
    objective: 'Check this page for outages',
    entryPoint: { kind: 'url', url: 'https://example.test/status?site=1' },
    trigger: {
      kind: 'schedule',
      schedule: {
        kind: 'recurring-weekly',
        timeZone: 'Europe/Stockholm',
        hour: 8,
        minute: 0,
        daysOfWeek: [1, 2, 3, 4, 5],
      },
    },
  };
}

describe('workflow-draft-ui-state', () => {
  it('seeds AI drafts with Enable unchecked regardless of trigger', () => {
    const form = workflowFormFromAiDraft(weeklyDraft());
    assert.equal(form.enabled, false);
    assert.equal(form.triggerKind, 'weekly');
    assert.equal(form.timeZone, 'Europe/Stockholm');
    assert.equal(form.hour, '8');
    assert.equal(form.minute, '0');
    assert.deepEqual(form.daysOfWeek, [1, 2, 3, 4, 5]);
    assert.equal(form.url, 'https://example.test/status?site=1');
  });

  it('serializes edited form values into WorkflowCreateInput without runNow', () => {
    const form = workflowFormFromAiDraft(weeklyDraft());
    form.name = 'Edited name';
    form.enabled = true;
    const input = workflowCreateInputFromForm(form);
    assert.ok(input);
    assert.equal(input?.name, 'Edited name');
    assert.equal(input?.enabled, true);
    assert.equal(input?.entryPoint.url, 'https://example.test/status?site=1');
    assert.equal(input?.trigger.kind, 'schedule');
  });

  it('keeps manual create Enable default true', () => {
    const form = emptyWorkflowForm();
    assert.equal(form.enabled, true);
  });
});

describe('V8 workflow draft UI integration', () => {
  it('wires Automate to generateWorkflowDraft and opens Workflows confirmation', () => {
    const app = readFileSync(path.join(ROOT, 'src/app-ui/App.tsx'), 'utf8');
    const submitStart = app.indexOf('handleOmniboxSubmit');
    const submit = app.slice(submitStart, app.indexOf('const openRightPanel', submitStart));
    assert.match(submit, /route\.kind === 'draft-workflow'/);
    assert.match(submit, /startWorkflowDraft/);
    assert.match(app, /generateWorkflowDraft/);
    assert.equal(submit.includes('setPhaseUnavailable'), false);
    assert.equal(submit.includes('workflows.create'), false);
    assert.equal(submit.includes('runNow'), false);
    assert.match(app, /workflowFormFromAiDraft/);
    assert.match(app, /setRightPanelSurface\('workflows'\)/);
  });

  it('renders an AI-generated confirmation with Enable false, Save, and Discard', () => {
    const panel = readFileSync(path.join(ROOT, 'src/app-ui/WorkflowsPanel.tsx'), 'utf8');
    assert.match(panel, /Review AI workflow draft/);
    assert.match(panel, /Enable after saving/);
    assert.match(panel, /Save workflow/);
    assert.match(panel, /Discard draft/);
    const confirmation = panel.slice(
      panel.indexOf('Review AI workflow draft'),
      panel.indexOf('New workflow'),
    );
    assert.match(confirmation, /Save workflow/);
    assert.match(confirmation, /Enable after saving/);
    assert.equal(confirmation.includes('runNow'), false);
    assert.equal(confirmation.includes('decideApproval'), false);
    assert.equal(confirmation.includes('Approve'), false);
  });

  it('keeps generation failure on the Automate omnibox path', () => {
    const app = readFileSync(path.join(ROOT, 'src/app-ui/App.tsx'), 'utf8');
    const submitStart = app.indexOf('handleOmniboxSubmit');
    const submit = app.slice(submitStart, app.indexOf('const openRightPanel', submitStart));
    const draftBlock = submit.slice(submit.indexOf("route.kind === 'draft-workflow'"));
    assert.match(draftBlock, /setSubmitError/);
    assert.match(draftBlock, /resetAfterSuccessfulAiSubmit/);
    assert.match(app, /const \[aiDraftForm, setAiDraftForm\]/);
    assert.equal(app.includes('localStorage'), false);
    assert.equal(app.includes('workflows-v1.json'), false);
  });

  it('keeps Assistant dominance for approvals while an AI draft is ephemeral', () => {
    const app = readFileSync(path.join(ROOT, 'src/app-ui/App.tsx'), 'utf8');
    const start = app.indexOf("event.type === 'approval-required'");
    const approvalBlock = app.slice(start, app.indexOf('handleApprovalDecision', start));
    assert.match(approvalBlock, /setRightPanelSurface\('assistant'\)/);
    assert.match(approvalBlock, /setActivityOpen\(current, false\)/);
    assert.match(approvalBlock, /closeContextPicker/);
    assert.equal(approvalBlock.includes('setAiDraftForm(null)'), false);
    assert.equal(approvalBlock.includes('decideApproval'), false);
  });

  it('saves AI drafts only from the trusted confirmation handler', () => {
    const panel = readFileSync(path.join(ROOT, 'src/app-ui/WorkflowsPanel.tsx'), 'utf8');
    const saveHandler = panel.slice(
      panel.indexOf('const handleSaveAiDraft'),
      panel.indexOf('const handleSave ='),
    );
    assert.match(saveHandler, /workflows\.create/);
    assert.equal(saveHandler.includes('runNow'), false);
    const discard = panel.slice(panel.indexOf('Discard draft'), panel.indexOf('Discard draft') + 400);
    assert.equal(discard.includes('workflows.create'), false);
    assert.match(panel, /workflow-ai-draft/);
    const styles = readFileSync(path.join(ROOT, 'src/app-ui/styles.css'), 'utf8');
    assert.match(styles, /\.workflow-ai-draft\b/);
    assert.match(panel, /onAiDraftSaved\?/);
    assert.match(panel, /clearAiDraft/);
  });
});
