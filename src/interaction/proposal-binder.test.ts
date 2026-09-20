import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import type { ModelInteractionProposal } from '../shared/interaction-types';
import type { ObservationNode, PageObservation } from '../shared/observation-types';
import { bindInteractionProposal } from './proposal-binder';

function node(
  overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>,
): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: true,
    visible: true,
    inViewport: true,
    ...overrides,
  };
}

function observation(
  nodes: ObservationNode[],
  overrides: Partial<PageObservation> = {},
): PageObservation {
  return {
    observationId: 'obs-A',
    tabId: 'tab-A',
    capturedAt: 1_700_000_000_000,
    document: {
      revision: 'rev-A',
      url: 'https://example.com/page',
      title: 'Example page',
      loading: false,
      mainFrameId: 'frame-1',
    },
    viewport: {
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0,
      deviceScaleFactor: 1,
    },
    nodes,
    stats: {
      sourceAxNodeCount: nodes.length,
      sourceDomNodeCount: nodes.length,
      emittedNodeCount: nodes.length,
      truncated: false,
      redactedValueCount: 0,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
    ...overrides,
  };
}

describe('bindInteractionProposal', () => {
  const page = observation([
    node({ role: 'button', targetId: 'target-A' }),
    node({ role: 'button', targetId: 'target-B' }),
    node({ role: 'option', targetId: 'option-A' }),
  ]);

  it('binds trusted local identity from the observation', () => {
    const proposal: ModelInteractionProposal = { kind: 'click', targetId: 'target-A' };
    const bound = bindInteractionProposal({
      proposal,
      observation: page,
      exportedTargetIds: new Set(['target-A']),
    });

    assert.equal(bound.tabId, 'tab-A');
    assert.equal(bound.observationId, 'obs-A');
    assert.equal(bound.documentRevision, 'rev-A');
    assert.equal(bound.kind, 'click');
    assert.equal(bound.targetId, 'target-A');
  });

  it('binds exported click targets', () => {
    const proposal: ModelInteractionProposal = { kind: 'click', targetId: 'target-A' };
    const bound = bindInteractionProposal({
      proposal,
      observation: page,
      exportedTargetIds: new Set(['target-A']),
    });

    assert.deepEqual(bound, {
      kind: 'click',
      targetId: 'target-A',
      tabId: 'tab-A',
      observationId: 'obs-A',
      documentRevision: 'rev-A',
    });
  });

  it('rejects invented targets not in exportedTargetIds', () => {
    const proposal: ModelInteractionProposal = { kind: 'click', targetId: 'missing-target' };

    assert.throws(
      () =>
        bindInteractionProposal({
          proposal,
          observation: page,
          exportedTargetIds: new Set(['target-A']),
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_NOT_EXPORTED');
        return true;
      },
    );
  });

  it('rejects stale targetIds after a fresh post-scroll observation', () => {
    const beforeScroll = observation(
      [node({ role: 'link', targetId: 'below-fold-link', name: 'WebdriverIO', tag: 'a' })],
      { observationId: 'obs-before', document: { ...page.document, revision: 'rev-before' } },
    );
    const afterScroll = observation([], {
      observationId: 'obs-after',
      document: { ...page.document, revision: 'rev-after' },
      viewport: { ...page.viewport, scrollY: 600 },
    });
    const boundBefore = bindInteractionProposal({
      proposal: { kind: 'click', targetId: 'below-fold-link' },
      observation: beforeScroll,
      exportedTargetIds: new Set(['below-fold-link']),
    });
    assert.equal(boundBefore.observationId, 'obs-before');

    assert.throws(
      () =>
        bindInteractionProposal({
          proposal: { kind: 'click', targetId: 'below-fold-link' },
          observation: afterScroll,
          exportedTargetIds: new Set(['target-A']),
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_NOT_EXPORTED');
        return true;
      },
    );
  });

  it('rejects locally present but unexported targets', () => {
    const proposal: ModelInteractionProposal = { kind: 'click', targetId: 'target-B' };

    assert.throws(
      () =>
        bindInteractionProposal({
          proposal,
          observation: page,
          exportedTargetIds: new Set(['target-A']),
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_NOT_EXPORTED');
        assert.match(error.message, /target-B/);
        return true;
      },
    );
  });

  it('requires both select targetId and optionTargetId to be exported', () => {
    const proposal: ModelInteractionProposal = {
      kind: 'select',
      targetId: 'target-A',
      optionTargetId: 'option-A',
    };

    const bound = bindInteractionProposal({
      proposal,
      observation: page,
      exportedTargetIds: new Set(['target-A', 'option-A']),
    });

    assert.equal(bound.kind, 'select');
    assert.equal(bound.targetId, 'target-A');
    assert.equal(bound.optionTargetId, 'option-A');

    assert.throws(
      () =>
        bindInteractionProposal({
          proposal,
          observation: page,
          exportedTargetIds: new Set(['target-A']),
        }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_NOT_EXPORTED');
        return true;
      },
    );
  });

  it('does not require exported targets for viewport scroll', () => {
    const proposal: ModelInteractionProposal = {
      kind: 'scroll',
      mode: 'viewport',
      direction: 'up',
      amountPx: 120,
    };

    const bound = bindInteractionProposal({
      proposal,
      observation: page,
      exportedTargetIds: new Set(),
    });

    assert.deepEqual(bound, {
      kind: 'scroll',
      mode: 'viewport',
      direction: 'up',
      amountPx: 120,
      tabId: 'tab-A',
      observationId: 'obs-A',
      documentRevision: 'rev-A',
    });
  });

  it('requires exported target for into-view scroll', () => {
    const proposal: ModelInteractionProposal = {
      kind: 'scroll',
      mode: 'into-view',
      targetId: 'target-A',
    };

    const bound = bindInteractionProposal({
      proposal,
      observation: page,
      exportedTargetIds: new Set(['target-A']),
    });

    assert.equal(bound.kind, 'scroll');
    if (bound.kind !== 'scroll' || bound.mode !== 'into-view') {
      throw new Error('Expected into-view scroll proposal');
    }
    assert.equal(bound.targetId, 'target-A');
  });

  it('does not mutate the model proposal or observation', () => {
    const proposal: ModelInteractionProposal = {
      kind: 'type',
      targetId: 'target-A',
      text: 'hello',
    };
    const proposalSnapshot = structuredClone(proposal);
    const observationSnapshot = structuredClone(page);

    bindInteractionProposal({
      proposal,
      observation: page,
      exportedTargetIds: new Set(['target-A']),
    });

    assert.deepEqual(proposal, proposalSnapshot);
    assert.deepEqual(page, observationSnapshot);
  });
});
