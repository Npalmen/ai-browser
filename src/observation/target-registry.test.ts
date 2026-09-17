import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TargetRegistry } from './target-registry';

function makeRecord(targetId: string, observationId: string): {
  targetId: string;
  tabId: string;
  observationId: string;
  documentRevision: string;
  frameId: string;
  backendNodeId: number;
} {
  return {
    targetId,
    tabId: 'tab-1',
    observationId,
    documentRevision: 'frame:loader',
    frameId: 'frame-1',
    backendNodeId: 42,
  };
}

describe('TargetRegistry', () => {
  it('replaces the live observation map for a tab', () => {
    const registry = new TargetRegistry();

    registry.replaceObservation('tab-1', 'obs-1', [makeRecord('target-1', 'obs-1')]);
    registry.replaceObservation('tab-1', 'obs-2', [makeRecord('target-2', 'obs-2')]);

    assert.equal(registry.getCurrentObservationId('tab-1'), 'obs-2');
    assert.equal(registry.resolve('tab-1', 'obs-2', 'target-2')?.targetId, 'target-2');
    assert.equal(registry.resolve('tab-1', 'obs-1', 'target-1'), null);
  });

  it('preserves observationId and documentRevision internally', () => {
    const registry = new TargetRegistry();
    const record = makeRecord('target-1', 'obs-1');

    registry.replaceObservation('tab-1', 'obs-1', [record]);

    const resolved = registry.resolve('tab-1', 'obs-1', 'target-1');
    assert.deepEqual(resolved, record);
    assert.equal(resolved?.documentRevision, 'frame:loader');
    assert.equal(resolved?.backendNodeId, 42);
  });

  it('clears tab and all targets', () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-1', 'obs-1', [makeRecord('target-1', 'obs-1')]);
    registry.replaceObservation('tab-2', 'obs-2', [makeRecord('target-2', 'obs-2')]);

    registry.clearTab('tab-1');
    assert.equal(registry.resolve('tab-1', 'obs-1', 'target-1'), null);
    assert.equal(registry.resolve('tab-2', 'obs-2', 'target-2')?.targetId, 'target-2');

    registry.clearAll();
    assert.equal(registry.getCurrentObservationId('tab-2'), null);
    assert.equal(registry.resolve('tab-2', 'obs-2', 'target-2'), null);
  });
});
