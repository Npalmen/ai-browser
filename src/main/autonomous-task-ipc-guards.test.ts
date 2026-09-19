import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseAutonomousTaskIdRequest,
  parseAutonomousTaskReplyRequest,
  parseAutonomousTaskStartRequest,
} from './autonomous-task-ipc-guards';

describe('autonomous task IPC guards', () => {
  it('accepts a bounded objective and rejects unknown fields', () => {
    const parsed = parseAutonomousTaskStartRequest({ objective: 'Book a refundable flight' });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.input.objective, 'Book a refundable flight');
    }
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'do this', approved: true }).ok, false);
    assert.equal(parseAutonomousTaskStartRequest({ objective: '   ' }).ok, false);
    assert.equal(parseAutonomousTaskStartRequest({ objective: 'x'.repeat(4001) }).ok, false);
    assert.equal(parseAutonomousTaskStartRequest('objective').ok, false);
  });

  it('rejects generation and other authority fields on control requests', () => {
    assert.equal(parseAutonomousTaskIdRequest({ taskId: 'task-1' }).ok, true);
    assert.equal(parseAutonomousTaskIdRequest({ taskId: 'task-1', generation: 9 }).ok, false);
    assert.equal(parseAutonomousTaskIdRequest({ taskId: 'task-1', runId: 'run-1' }).ok, false);
    assert.equal(
      parseAutonomousTaskReplyRequest({
        taskId: 'task-1',
        approvalId: 'appr-1',
        reply: 'yes',
      }).ok,
      false,
    );
    assert.equal(parseAutonomousTaskReplyRequest({ taskId: 'task-1', reply: 'more detail' }).ok, true);
    assert.equal(parseAutonomousTaskReplyRequest({ taskId: 'task-1', reply: '   ' }).ok, false);
  });
});
