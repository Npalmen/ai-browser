import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { activityRows } from '../app-ui/activity-ui-state';
import type { AiNativeActivitySummary } from '../shared/ai-native-types';

const ROOT = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

describe('V8 authority boundaries', () => {
  it('keeps Activity rows as Assistant/Workflows deep-links without mutation controls', () => {
    const summary: AiNativeActivitySummary = {
      ask: { activeCount: 1, selectedContextActive: false },
      act: { activeCount: 1 },
      delegate: { active: true, awaitingUserInput: true },
      approval: { pendingCount: 1 },
      workflows: { runningCount: 1, queuedCount: 2, reviewRequiredCount: 1 },
      attention: { kind: 'approval', tabId: 'tab-b' },
    };
    const rows = activityRows(summary);
    assert.equal(
      rows.every((row) => row.deepLink.surface === 'assistant' || row.deepLink.surface === 'workflows'),
      true,
    );
    const popover = readSrc('src/app-ui/ActivitySummary.tsx');
    const handler = readSrc('src/app-ui/App.tsx');
    const select = handler.slice(
      handler.indexOf('const handleActivitySelect'),
      handler.indexOf('const updateActiveTabAi'),
    );
    for (const banned of [
      'decideApproval',
      'pauseAutonomousTask',
      'resumeAutonomousTask',
      'stopAutonomousTask',
      'replyToAutonomousTask',
      'runNow',
      'setEnabled',
      'acknowledgeReview',
      'cancelQueued',
      'workflows.delete',
    ]) {
      assert.equal(popover.includes(banned), false, banned);
      assert.equal(select.includes(banned), false, banned);
    }
  });

  it('does not treat context IDs or target IDs as capabilities in V8 routing', () => {
    const router = readSrc('src/ai-native/browser-intent-router.ts');
    assert.equal(router.includes('targetId'), false);
    assert.equal(router.includes('contextId'), false);
    assert.equal(router.includes('approvalId'), false);
    const act = router.slice(router.indexOf('function routeAct'), router.indexOf('function routeDelegate'));
    assert.match(act, /tabId: activeTabId/);
  });

  it('keeps hostile page instructions from becoming V8 capability or persistence authority', () => {
    const builder = readSrc('src/ai-native/browser-context-builder.ts');
    const draft = readSrc('src/ai-native/workflow-draft-agent.ts');
    const wrapper = readSrc('src/ai/context-builder.ts');
    assert.match(builder, /wrapUntrustedPageContent/);
    assert.match(builder, /USER_INSTRUCTION/);
    assert.match(draft, /wrapUntrustedPageContent/);
    assert.match(wrapper, /UNTRUSTED_PAGE_CONTENT/);
    assert.equal(builder.includes('decideApproval'), false);
    assert.equal(draft.includes('runNow'), false);
    assert.equal(draft.includes('setEnabled'), false);
  });

  it('does not special-case free-text approve in the omnibox path', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const submit = app.slice(app.indexOf('handleOmniboxSubmit'), app.indexOf('const openRightPanel'));
    assert.equal(submit.includes('decideApproval'), false);
    assert.equal(submit.includes("'approve'"), false);
    const router = readSrc('src/ai-native/browser-intent-router.ts');
    assert.equal(router.toLowerCase().includes('approve'), false);
  });

  it('starts Delegate without selected V8 context ownership', () => {
    const app = readSrc('src/app-ui/App.tsx');
    const start = app.slice(app.indexOf('const startDelegateTask'), app.indexOf('const startWorkflowDraft'));
    assert.match(start, /startAutonomousTask\(\{ objective \}\)/);
    assert.equal(start.includes('tabIds'), false);
    assert.equal(start.includes('context'), false);
    const router = readSrc('src/ai-native/browser-intent-router.ts');
    const delegate = router.slice(router.indexOf('function routeDelegate'), router.indexOf('function routeAutomate'));
    assert.equal(delegate.includes('context'), false);
    assert.equal(delegate.includes('tabId'), false);
  });
});
