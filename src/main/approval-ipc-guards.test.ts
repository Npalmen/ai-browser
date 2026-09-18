import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MAX_APPROVAL_ID_CHARS } from '../shared/approval-types';
import { parseApprovalDecideRequest } from './approval-ipc-guards';

describe('approval IPC guards', () => {
  it('accepts approve and reject payloads with only approvalId and decision', () => {
    assert.deepEqual(parseApprovalDecideRequest({ approvalId: 'appr-123', decision: 'approve' }), {
      ok: true,
      input: { approvalId: 'appr-123', decision: 'approve' },
    });
    assert.deepEqual(parseApprovalDecideRequest({ approvalId: 'appr-123', decision: 'reject' }), {
      ok: true,
      input: { approvalId: 'appr-123', decision: 'reject' },
    });
  });

  it('does not trim a valid approvalId', () => {
    const parsed = parseApprovalDecideRequest({ approvalId: 'appr- 123', decision: 'approve' });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.input.approvalId, 'appr- 123');
    }
  });

  it('rejects missing keys, extra keys, and non-objects', () => {
    assert.equal(parseApprovalDecideRequest({}).ok, false);
    assert.equal(parseApprovalDecideRequest({ decision: 'approve' }).ok, false);
    assert.equal(parseApprovalDecideRequest({ approvalId: 'appr-123' }).ok, false);
    assert.equal(parseApprovalDecideRequest(null).ok, false);
    assert.equal(parseApprovalDecideRequest('appr-123').ok, false);
    assert.equal(parseApprovalDecideRequest([{ approvalId: 'appr-123', decision: 'approve' }]).ok, false);
  });

  it('rejects empty, whitespace-only, and oversized approvalId', () => {
    assert.equal(parseApprovalDecideRequest({ approvalId: '', decision: 'approve' }).ok, false);
    assert.equal(parseApprovalDecideRequest({ approvalId: '   ', decision: 'approve' }).ok, false);
    assert.equal(
      parseApprovalDecideRequest({ approvalId: 'x'.repeat(MAX_APPROVAL_ID_CHARS + 1), decision: 'approve' }).ok,
      false,
    );
  });

  it('rejects unknown or non-string decisions', () => {
    assert.equal(parseApprovalDecideRequest({ approvalId: 'appr-123', decision: 'yes' }).ok, false);
    assert.equal(parseApprovalDecideRequest({ approvalId: 'appr-123', decision: 'approved' }).ok, false);
    assert.equal(parseApprovalDecideRequest({ approvalId: 'appr-123', decision: true }).ok, false);
  });

  it('rejects extra authority fields without ignoring them', () => {
    const extras = [
      { approvalId: 'appr-1', decision: 'approve', targetId: 'target-evil' },
      { approvalId: 'appr-1', decision: 'approve', authority: 'EXECUTE' },
      { approvalId: 'appr-1', decision: 'approve', executionId: 'exec-evil' },
      { approvalId: 'appr-1', decision: 'approve', tabId: 'tab-evil' },
      { approvalId: 'appr-1', decision: 'approve', preparedActionId: 'prep-evil' },
    ];
    for (const payload of extras) {
      const result = parseApprovalDecideRequest(payload);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, 'INVALID_REQUEST');
        assert.equal(result.error.message, 'The approval request was invalid.');
      }
    }
  });
});
