import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AgentInputDispatchScope, bindClickDispatchScope } from './agent-input-dispatch-scope';
import type { AdapterClickRequest } from './interaction-adapter-types';

function clickRequest(overrides: Partial<AdapterClickRequest> = {}): AdapterClickRequest {
  return {
    target: {
      tabId: 'tab-a',
      frameId: 'frame-1',
      backendNodeId: 1,
      documentRevision: 'rev-1',
    },
    ...overrides,
  };
}

describe('AgentInputDispatchScope', () => {
  it('begins only when the wrapped onBeforeInputDispatch callback runs', () => {
    const scope = new AgentInputDispatchScope();
    const bound = bindClickDispatchScope(scope, 'tab-a', clickRequest());
    assert.equal(scope.isActive('tab-a'), false);
    bound.request.onBeforeInputDispatch?.();
    assert.equal(scope.isActive('tab-a'), true);
    bound.finish();
    assert.equal(scope.isActive('tab-a'), false);
  });

  it('invokes the existing onBeforeInputDispatch callback exactly once', () => {
    const scope = new AgentInputDispatchScope();
    let calls = 0;
    const bound = bindClickDispatchScope(
      scope,
      'tab-a',
      clickRequest({
        onBeforeInputDispatch: () => {
          calls += 1;
        },
      }),
    );
    bound.request.onBeforeInputDispatch?.();
    assert.equal(calls, 1);
    bound.finish();
  });

  it('clears the marker when the existing callback throws, before any dispatch', () => {
    const scope = new AgentInputDispatchScope();
    const bound = bindClickDispatchScope(
      scope,
      'tab-a',
      clickRequest({
        onBeforeInputDispatch: () => {
          throw new Error('pre-dispatch');
        },
      }),
    );
    assert.throws(() => bound.request.onBeforeInputDispatch?.());
    bound.finish();
    assert.equal(scope.isActive('tab-a'), false);
  });

  it('clears the marker when dispatch throws after the callback', () => {
    const scope = new AgentInputDispatchScope();
    const bound = bindClickDispatchScope(scope, 'tab-a', clickRequest());
    try {
      bound.request.onBeforeInputDispatch?.();
      throw new Error('dispatch failed');
    } catch {
      bound.finish();
    }
    assert.equal(scope.isActive('tab-a'), false);
  });

  it('classifies a popup during the marker as causal and after finish as non-causal', () => {
    const scope = new AgentInputDispatchScope();
    const bound = bindClickDispatchScope(scope, 'tab-a', clickRequest());
    bound.request.onBeforeInputDispatch?.();
    assert.equal(scope.isActive('tab-a'), true);
    bound.finish();
    assert.equal(scope.isActive('tab-a'), false);
  });
});
