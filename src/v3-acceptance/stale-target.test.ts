import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bindInteractionProposal } from '../interaction/proposal-binder';
import { InteractionExecutor } from '../interaction/interaction-executor';
import { InMemoryInteractionAuditSink } from '../interaction/interaction-audit';
import { resolveInteractionTarget } from '../interaction/target-resolver';
import { TargetRegistry } from '../observation/target-registry';
import { InteractionError } from '../shared/interaction-errors';
import { V3_TAB_B, V3_TAB_ID } from './fixture-constants';
import {
  createFakeAdapter,
  node,
  observation,
  registryRecord,
} from './chain-fixtures';

describe('V3 stale-target acceptance', () => {
  it('fails superseded observation with TARGET_STALE and zero adapter mutations', async () => {
    const targetId = 'target-stale';
    const pageA = observation(
      [node({ role: 'button', tag: 'button', targetId, name: 'Stale target' })],
      { observationId: 'obs-A', document: { revision: 'rev-A', url: 'http://127.0.0.1', title: 'A', loading: false, mainFrameId: 'frame-1' } },
    );
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, 'obs-B', [registryRecord(targetId, 401, V3_TAB_ID, 'obs-B', 'rev-B')]);
    const { adapter, counts } = createFakeAdapter();
    const audit = new InMemoryInteractionAuditSink();
    const executor = new InteractionExecutor({
      adapter,
      targetRegistry: registry,
      audit,
      generateActionId: () => 'action-stale-1',
      now: () => 1,
    });

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId,
        tabId: V3_TAB_ID,
        observationId: 'obs-A',
        documentRevision: 'rev-A',
      },
      observation: pageA,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'TARGET_STALE');
    assert.equal(counts.click, 0);
  });

  it('fails revision change with TARGET_STALE', async () => {
    const targetId = 'target-revision';
    const page = observation(
      [node({ role: 'button', tag: 'button', targetId, name: 'Stale target' })],
      { observationId: 'obs-A', document: { revision: 'rev-A', url: 'http://127.0.0.1', title: 'A', loading: false, mainFrameId: 'frame-1' } },
    );
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, 'obs-A', [
      registryRecord(targetId, 402, V3_TAB_ID, 'obs-A', 'rev-B'),
    ]);
    const { adapter, counts } = createFakeAdapter();
    const executor = new InteractionExecutor({
      adapter,
      targetRegistry: registry,
      audit: new InMemoryInteractionAuditSink(),
      generateActionId: () => 'action-stale-2',
      now: () => 1,
    });

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId,
        tabId: V3_TAB_ID,
        observationId: 'obs-A',
        documentRevision: 'rev-A',
      },
      observation: page,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'TARGET_STALE');
    assert.equal(counts.click, 0);
  });

  it('prevents cross-tab target execution', async () => {
    const targetId = 'target-cross-tab';
    const page = observation(
      [node({ role: 'button', tag: 'button', targetId, name: 'Stale target' })],
      { tabId: V3_TAB_B, observationId: 'obs-tab-b' },
    );
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_B, 'obs-tab-b', [
      registryRecord(targetId, 403, V3_TAB_B, 'obs-tab-b', 'rev-v3-1'),
    ]);
    const { adapter, counts } = createFakeAdapter();
    const executor = new InteractionExecutor({
      adapter,
      targetRegistry: registry,
      audit: new InMemoryInteractionAuditSink(),
      generateActionId: () => 'action-stale-3',
      now: () => 1,
    });

    const result = await executor.execute({
      proposal: {
        kind: 'click',
        targetId,
        tabId: V3_TAB_ID,
        observationId: 'obs-tab-b',
        documentRevision: 'rev-v3-1',
      },
      observation: page,
    });

    assert.equal(result.status, 'failed');
    assert.equal(result.errorCode, 'TARGET_STALE');
    assert.equal(counts.click, 0);
  });

  it('rejects non-exported targets before the executor', async () => {
    const exportedTarget = 'target-exported';
    const hiddenTarget = 'target-hidden';
    const page = observation([
      node({ role: 'button', tag: 'button', targetId: exportedTarget, name: 'Visible' }),
      node({ role: 'button', tag: 'button', targetId: hiddenTarget, name: 'Hidden' }),
    ]);
    assert.throws(
      () =>
        bindInteractionProposal({
          proposal: { kind: 'click', targetId: hiddenTarget },
          observation: page,
          exportedTargetIds: new Set([exportedTarget]),
        }),
      (error: unknown) => error instanceof InteractionError && error.code === 'TARGET_NOT_EXPORTED',
    );
  });

  it('does not recover stale targets by name, text, role, or coordinates', () => {
    const registry = new TargetRegistry();
    registry.replaceObservation(V3_TAB_ID, 'obs-A', [registryRecord('target-a', 501)]);
    assert.throws(
      () =>
        resolveInteractionTarget({
          bound: {
            tabId: V3_TAB_ID,
            observationId: 'obs-A',
            documentRevision: 'rev-v3-1',
          },
          targetId: 'target-missing',
          observation: observation([
            node({ role: 'button', tag: 'button', targetId: 'target-a', name: 'Stale target' }),
          ]),
          targetRegistry: registry,
        }),
      (error: unknown) => error instanceof InteractionError,
    );
  });
});
