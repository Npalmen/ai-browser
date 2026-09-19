import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AutonomousTaskApprovalPortProxy } from './autonomous-task-approval-port-proxy';

describe('AutonomousTaskApprovalPortProxy', () => {
  it('is unrelated and a no-op before bind', () => {
    const proxy = new AutonomousTaskApprovalPortProxy();
    const ref = { runId: 'run-1', tabId: 'tab-1', generation: 1 };
    assert.equal(proxy.beforePrepare(ref), 'unrelated');
    assert.equal(proxy.onPresented(ref, 'appr-1'), 'unrelated');
    proxy.notifyApprovalOutcome('appr-1', 'executed');
  });

  it('may bind once and fails closed on a second bind', () => {
    const proxy = new AutonomousTaskApprovalPortProxy();
    const first = {
      beforePrepare: () => 'allow' as const,
      onPresented: () => 'applied' as const,
      notifyApprovalOutcome: () => undefined,
    };
    const second = {
      beforePrepare: () => 'blocked' as const,
      onPresented: () => 'blocked' as const,
      notifyApprovalOutcome: () => undefined,
    };
    proxy.bind(first as never);
    const ref = { runId: 'run-1', tabId: 'tab-1', generation: 1 };
    assert.equal(proxy.beforePrepare(ref), 'allow');
    assert.throws(() => proxy.bind(second as never), /already bound/);
    assert.equal(proxy.beforePrepare(ref), 'allow');
  });
});
