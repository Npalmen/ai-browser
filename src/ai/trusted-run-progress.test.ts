import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_TRUSTED_RUN_PROGRESS_STEPS,
  serializeTrustedRunProgress,
  TRUSTED_RUN_PROGRESS_CLOSE,
  TRUSTED_RUN_PROGRESS_OPEN,
  type TrustedRunProgressEntry,
} from './trusted-run-progress';

describe('trusted run progress', () => {
  it('locks the progress bound to the V5 model-step maximum', () => {
    assert.equal(MAX_TRUSTED_RUN_PROGRESS_STEPS, 8);
  });

  it('returns undefined for missing or empty entries', () => {
    assert.equal(serializeTrustedRunProgress(undefined), undefined);
    assert.equal(serializeTrustedRunProgress([]), undefined);
  });

  it('serializes fixed local summaries with an authority disclaimer', () => {
    const serialized = serializeTrustedRunProgress([
      { kind: 'safe-interaction-succeeded', actionKind: 'click', pageChanged: false },
      { kind: 'safe-interaction-succeeded', actionKind: 'click', pageChanged: true },
      { kind: 'approved-execution-succeeded', pageChanged: false },
    ]);
    assert.ok(serialized);
    assert.equal(serialized.startsWith(TRUSTED_RUN_PROGRESS_OPEN), true);
    assert.equal(serialized.endsWith(TRUSTED_RUN_PROGRESS_CLOSE), true);
    assert.match(serialized, /descriptive only/i);
    assert.match(serialized, /do not grant permission/i);
    assert.match(serialized, /new explicit approval/);
    assert.match(serialized, /A safe click completed successfully\./);
    assert.match(
      serialized,
      /A safe navigation-producing click completed successfully and the page changed\./,
    );
    assert.match(
      serialized,
      /The previously presented consequential click was approved and executed successfully\./,
    );
    assert.match(
      serializeTrustedRunProgress([
        { kind: 'target-selection-denied', actionKind: 'click' },
      ]) ?? '',
      /choose an exported link/,
    );
  });

  it('omits page-change claims when approved-execution pageChanged is unknown', () => {
    const serialized = serializeTrustedRunProgress([
      { kind: 'approved-execution-succeeded' },
    ]);
    assert.ok(serialized);
    assert.match(
      serialized,
      /The previously presented consequential click was approved and executed successfully\./,
    );
    assert.equal(serialized.includes('the page changed'), false);
  });

  it('keeps only the latest eight entries', () => {
    const entries: TrustedRunProgressEntry[] = [
      { kind: 'safe-interaction-succeeded', actionKind: 'type', pageChanged: false },
      { kind: 'safe-interaction-succeeded', actionKind: 'select', pageChanged: false },
      ...Array.from({ length: 8 }, () => ({
        kind: 'safe-interaction-succeeded' as const,
        actionKind: 'click' as const,
        pageChanged: false,
      })),
    ];
    const serialized = serializeTrustedRunProgress(entries);
    assert.ok(serialized);
    assert.equal(serialized.includes('A safe type completed successfully.'), false);
    assert.equal(serialized.includes('A safe select completed successfully.'), false);
    assert.equal([...serialized.matchAll(/A safe click completed successfully\./g)].length, 8);
  });

  it('does not accept or emit caller-provided prose, ids, or typed secrets', () => {
    const serialized = serializeTrustedRunProgress([
      { kind: 'safe-interaction-succeeded', actionKind: 'type', pageChanged: false },
      { kind: 'approved-execution-succeeded', pageChanged: true },
    ]);
    assert.ok(serialized);
    for (const needle of [
      'targetId-CANARY',
      'approvalId-CANARY',
      'executionId-CANARY',
      'runId-CANARY',
      'backendNodeId-CANARY',
      'frameId-CANARY',
      'typed-secret-CANARY',
    ]) {
      assert.equal(serialized.includes(needle), false, needle);
    }
  });
});
