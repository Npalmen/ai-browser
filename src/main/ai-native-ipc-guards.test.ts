import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseCancelContextAskRequest,
  parseContextAskRequest,
  parseGenerateWorkflowDraftRequest,
  parseRouteIntentRequest,
} from './ai-native-ipc-guards';

describe('parseRouteIntentRequest', () => {
  it('accepts minimal default route input', () => {
    const result = parseRouteIntentRequest({
      text: 'cats',
      capability: 'default',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.input.text, 'cats');
      assert.equal(result.input.capability, 'default');
      assert.equal('context' in result.input, false);
    }
  });

  it('accepts current-tab and selected-tabs context shapes for ask', () => {
    const current = parseRouteIntentRequest({
      text: 'Summarize',
      capability: 'ask',
      context: { kind: 'current-tab', tabId: 'tab-a' },
    });
    assert.equal(current.ok, true);

    const selected = parseRouteIntentRequest({
      text: 'Compare',
      capability: 'ask',
      context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
    });
    assert.equal(selected.ok, true);
  });

  it('rejects unknown capability strings', () => {
    const result = parseRouteIntentRequest({
      text: 'cats',
      capability: 'agent',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });

  it('rejects unknown top-level keys', () => {
    const result = parseRouteIntentRequest({
      text: 'cats',
      capability: 'default',
      targetId: 'target-1',
    });
    assert.equal(result.ok, false);
  });

  it('rejects authority-shaped extras', () => {
    for (const extra of [
      { approvalId: 'a-1' },
      { taskId: 't-1' },
      { workflowId: 'w-1' },
      { grant: true },
      { executionId: 'e-1' },
    ]) {
      const result = parseRouteIntentRequest({
        text: 'cats',
        capability: 'default',
        ...extra,
      });
      assert.equal(result.ok, false, JSON.stringify(extra));
    }
  });

  it('rejects context objects with extra keys', () => {
    const result = parseRouteIntentRequest({
      text: 'Summarize',
      capability: 'ask',
      context: { kind: 'current-tab', tabId: 'tab-a', url: 'https://example.com' },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
    }
  });

  it('rejects non-object input', () => {
    assert.equal(parseRouteIntentRequest(null).ok, false);
    assert.equal(parseRouteIntentRequest('cats').ok, false);
  });

  it('rejects context on default, search, act, and delegate', () => {
    for (const capability of ['default', 'search', 'act', 'delegate'] as const) {
      const result = parseRouteIntentRequest({
        text: 'cats',
        capability,
        context: { kind: 'current-tab', tabId: 'tab-a' },
      });
      assert.equal(result.ok, false, capability);
      if (!result.ok) {
        assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
      }
    }
  });

  it('parses selected-tabs context ask requests', () => {
    const result = parseContextAskRequest({
      question: 'Compare tabs',
      context: { kind: 'selected-tabs', tabIds: ['tab-a', 'tab-b'] },
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.input.context.kind, 'selected-tabs');
      assert.deepEqual(result.input.context.tabIds, ['tab-a', 'tab-b']);
    }
  });

  it('rejects empty context ask questions', () => {
    const result = parseContextAskRequest({
      question: '   ',
      context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_EMPTY_INPUT');
    }
  });

  it('rejects authority-shaped extras on context ask', () => {
    for (const extra of [
      { targetId: 'target-1' },
      { observationId: 'obs-1' },
      { documentRevision: 'rev-1' },
      { model: 'page-fast' },
      { needsVision: true },
      { contextId: 'ctx-1' },
    ]) {
      const result = parseContextAskRequest({
        question: 'What?',
        context: { kind: 'selected-tabs', tabIds: ['tab-a'] },
        ...extra,
      });
      assert.equal(result.ok, false, JSON.stringify(extra));
    }
  });

  it('parses cancel context ask requests', () => {
    const result = parseCancelContextAskRequest({ askId: 'ask-1' });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.askId, 'ask-1');
    }
  });

  it('requires context for ask and automate', () => {
    for (const capability of ['ask', 'automate'] as const) {
      const result = parseRouteIntentRequest({
        text: 'do something',
        capability,
      });
      assert.equal(result.ok, false, capability);
      if (!result.ok) {
        assert.equal(result.error.code, 'AI_NATIVE_CONTEXT_INVALID');
      }
    }
  });
});

describe('parseGenerateWorkflowDraftRequest', () => {
  it('accepts current-tab and selected-tabs contexts', () => {
    const current = parseGenerateWorkflowDraftRequest({
      instruction: 'Every weekday at 08:00 check this page',
      context: { kind: 'current-tab', tabId: 'tab-a' },
    });
    assert.equal(current.ok, true);

    const selected = parseGenerateWorkflowDraftRequest({
      instruction: 'Check these tabs',
      context: { kind: 'selected-tabs', tabIds: ['tab-b', 'tab-a'] },
    });
    assert.equal(selected.ok, true);
    if (selected.ok && selected.input.context.kind === 'selected-tabs') {
      assert.deepEqual(selected.input.context.tabIds, ['tab-b', 'tab-a']);
    }
  });

  it('rejects missing context and empty instruction', () => {
    assert.equal(
      parseGenerateWorkflowDraftRequest({
        instruction: 'Create a workflow',
      }).ok,
      false,
    );
    const empty = parseGenerateWorkflowDraftRequest({
      instruction: '   ',
      context: { kind: 'current-tab', tabId: 'tab-a' },
    });
    assert.equal(empty.ok, false);
    if (!empty.ok) {
      assert.equal(empty.error.code, 'AI_NATIVE_EMPTY_INPUT');
    }
  });

  it('rejects authority extras including now and timeZone', () => {
    for (const extra of [
      { enabled: true },
      { workflowId: 'wf-1' },
      { occurrenceId: 'occ-1' },
      { runNow: true },
      { approvalId: 'a-1' },
      { taskId: 't-1' },
      { targetId: 'target-1' },
      { triggerKey: 'k' },
      { timeZone: 'UTC' },
      { now: '2026-09-19T10:00:00.000Z' },
    ]) {
      const result = parseGenerateWorkflowDraftRequest({
        instruction: 'Create a workflow',
        context: { kind: 'current-tab', tabId: 'tab-a' },
        ...extra,
      });
      assert.equal(result.ok, false, JSON.stringify(extra));
    }
  });

  it('rejects oversized selected-tab context', () => {
    const result = parseGenerateWorkflowDraftRequest({
      instruction: 'Create a workflow',
      context: {
        kind: 'selected-tabs',
        tabIds: ['tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5', 'tab-6'],
      },
    });
    assert.equal(result.ok, false);
  });
});
