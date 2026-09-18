import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { AutonomousTaskError } from './autonomous-task-errors';
import { fingerprintSubgoal, normalizeDelegatedInstruction } from './task-no-progress';

describe('task no-progress fingerprint', () => {
  it('normalizes NFC, trim, and internal whitespace without changing case or punctuation', () => {
    assert.equal(normalizeDelegatedInstruction('  Open  Settings\nnow.  '), 'Open Settings now.');
    assert.equal(normalizeDelegatedInstruction('Buy NOW'), 'Buy NOW');
    assert.equal(normalizeDelegatedInstruction('a\u0301'), 'á');
  });

  it('produces a deterministic 64-character SHA-256 hex digest', () => {
    const digest = fingerprintSubgoal({
      taskTabAlias: 'task-tab-1',
      delegatedInstruction: 'Open settings',
      trustedTabStateToken: 'rev-1',
    });
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(
      digest,
      fingerprintSubgoal({
        taskTabAlias: 'task-tab-1',
        delegatedInstruction: 'Open settings',
        trustedTabStateToken: 'rev-1',
      }),
    );
    const reconstructed = createHash('sha256')
      .update(`10:task-tab-1\n${'Open settings'.length}:Open settings\n5:rev-1`, 'utf8')
      .digest('hex');
    assert.equal(digest, reconstructed);
  });

  it('treats whitespace-equivalent instructions as the same fingerprint', () => {
    const left = fingerprintSubgoal({
      taskTabAlias: 'task-tab-1',
      delegatedInstruction: '  Open   settings ',
      trustedTabStateToken: 'rev-1',
    });
    const right = fingerprintSubgoal({
      taskTabAlias: 'task-tab-1',
      delegatedInstruction: 'Open settings',
      trustedTabStateToken: 'rev-1',
    });
    assert.equal(left, right);
  });

  it('changes digest when case, punctuation, alias, or state token change', () => {
    const base = fingerprintSubgoal({
      taskTabAlias: 'task-tab-1',
      delegatedInstruction: 'Open settings',
      trustedTabStateToken: 'rev-1',
    });
    assert.notEqual(
      base,
      fingerprintSubgoal({
        taskTabAlias: 'task-tab-1',
        delegatedInstruction: 'open settings',
        trustedTabStateToken: 'rev-1',
      }),
    );
    assert.notEqual(
      base,
      fingerprintSubgoal({
        taskTabAlias: 'task-tab-1',
        delegatedInstruction: 'Open settings!',
        trustedTabStateToken: 'rev-1',
      }),
    );
    assert.notEqual(
      base,
      fingerprintSubgoal({
        taskTabAlias: 'task-tab-2',
        delegatedInstruction: 'Open settings',
        trustedTabStateToken: 'rev-1',
      }),
    );
    assert.notEqual(
      base,
      fingerprintSubgoal({
        taskTabAlias: 'task-tab-1',
        delegatedInstruction: 'Open settings',
        trustedTabStateToken: 'rev-2',
      }),
    );
  });

  it('rejects empty alias, instruction, or trusted state token', () => {
    assert.throws(
      () =>
        fingerprintSubgoal({
          taskTabAlias: '  ',
          delegatedInstruction: 'Open',
          trustedTabStateToken: 'rev-1',
        }),
      (error: unknown) => {
        assert.ok(error instanceof AutonomousTaskError);
        assert.equal(error.code, 'INVALID_TASK_TAB_ALIAS');
        return true;
      },
    );
    assert.throws(
      () =>
        fingerprintSubgoal({
          taskTabAlias: 'task-tab-1',
          delegatedInstruction: '   ',
          trustedTabStateToken: 'rev-1',
        }),
      (error: unknown) => {
        assert.ok(error instanceof AutonomousTaskError);
        assert.equal(error.code, 'INVALID_SUBGOAL_FINGERPRINT');
        return true;
      },
    );
    assert.throws(
      () =>
        fingerprintSubgoal({
          taskTabAlias: 'task-tab-1',
          delegatedInstruction: 'Open',
          trustedTabStateToken: '',
        }),
      (error: unknown) => {
        assert.ok(error instanceof AutonomousTaskError);
        assert.equal(error.code, 'INVALID_TRUSTED_TAB_STATE_TOKEN');
        return true;
      },
    );
  });
});
