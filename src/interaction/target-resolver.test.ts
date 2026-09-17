import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TargetRegistry } from '../observation/target-registry';
import { InteractionError } from '../shared/interaction-errors';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import { resolveInteractionTarget } from './target-resolver';

function node(overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: true,
    visible: true,
    inViewport: true,
    ...overrides,
  };
}

function observation(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    observationId: 'obs-A',
    tabId: 'tab-A',
    capturedAt: 1,
    document: {
      revision: 'rev-A',
      url: 'https://example.com',
      title: 'Example',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 },
    nodes: [node({ role: 'button', targetId: 'target-A' })],
    stats: {
      sourceAxNodeCount: 1,
      sourceDomNodeCount: 1,
      emittedNodeCount: 1,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
    ...overrides,
  };
}

function record(targetId: string, observationId = 'obs-A') {
  return {
    targetId,
    tabId: 'tab-A',
    observationId,
    documentRevision: 'rev-A',
    frameId: 'frame-1',
    backendNodeId: 42,
  };
}

describe('resolveInteractionTarget', () => {
  it('resolves a happy-path target with trusted identity', () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-A', 'obs-A', [record('target-A')]);

    const resolved = resolveInteractionTarget({
      bound: {
        tabId: 'tab-A',
        observationId: 'obs-A',
        documentRevision: 'rev-A',
      },
      targetId: 'target-A',
      observation: observation(),
      targetRegistry: registry,
    });

    assert.equal(resolved.targetId, 'target-A');
    assert.equal(resolved.backendNodeId, 42);
    assert.equal(resolved.documentRevision, 'rev-A');
  });

  it('fails when the observation id is not current in the registry', () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-A', 'obs-B', [record('target-A', 'obs-B')]);

    assert.throws(
      () =>
        resolveInteractionTarget({
          bound: {
            tabId: 'tab-A',
            observationId: 'obs-A',
            documentRevision: 'rev-A',
          },
          targetId: 'target-A',
          observation: observation(),
          targetRegistry: registry,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_STALE');
        return true;
      },
    );
  });

  it('fails on document revision mismatch in the target record', () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-A', 'obs-A', [
      { ...record('target-A'), documentRevision: 'rev-B' },
    ]);

    assert.throws(
      () =>
        resolveInteractionTarget({
          bound: {
            tabId: 'tab-A',
            observationId: 'obs-A',
            documentRevision: 'rev-A',
          },
          targetId: 'target-A',
          observation: observation(),
          targetRegistry: registry,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_STALE');
        return true;
      },
    );
  });

  it('fails when the bound observation identity does not match', () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-A', 'obs-A', [record('target-A')]);

    assert.throws(
      () =>
        resolveInteractionTarget({
          bound: {
            tabId: 'tab-A',
            observationId: 'obs-A',
            documentRevision: 'rev-A',
          },
          targetId: 'target-A',
          observation: observation({ observationId: 'obs-B' }),
          targetRegistry: registry,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_STALE');
        return true;
      },
    );
  });

  it('fails when the target is missing from the bound observation nodes', () => {
    const registry = new TargetRegistry();
    registry.replaceObservation('tab-A', 'obs-A', [record('target-A')]);

    assert.throws(
      () =>
        resolveInteractionTarget({
          bound: {
            tabId: 'tab-A',
            observationId: 'obs-A',
            documentRevision: 'rev-A',
          },
          targetId: 'target-A',
          observation: observation({ nodes: [] }),
          targetRegistry: registry,
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_NOT_FOUND');
        return true;
      },
    );
  });
});
