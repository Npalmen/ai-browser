import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRouteIntentRequest } from './ai-native-ipc-guards';

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
