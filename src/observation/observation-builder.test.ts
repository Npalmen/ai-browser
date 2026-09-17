import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildObservation,
  ObservationPriority,
  type BuildObservationInput,
  type ObservationCandidate,
} from './observation-builder';

function baseInput(
  candidates: ObservationCandidate[],
  overrides: Partial<BuildObservationInput> = {},
): BuildObservationInput {
  return {
    observationId: 'obs-1',
    tabId: 'tab-1',
    capturedAt: 1_700_000_000_000,
    document: {
      revision: 'frame:loader',
      url: 'https://example.com/',
      title: 'Example',
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
    candidates,
    sourceStats: {
      sourceAxNodeCount: candidates.length,
      sourceDomNodeCount: candidates.length,
      frameCount: 1,
      crossOriginFrameCount: 0,
    },
    ...overrides,
  };
}

function candidate(
  partial: Partial<ObservationCandidate> & Pick<ObservationCandidate, 'documentOrder' | 'priority'>,
): ObservationCandidate {
  return {
    frameId: 'frame-1',
    role: 'generic',
    interactive: false,
    visible: true,
    inViewport: true,
    ...partial,
  };
}

describe('buildObservation', () => {
  it('redacts password text leaked from DOM snapshot input values', () => {
    const { observation } = buildObservation(
      baseInput([
        candidate({
          documentOrder: 0,
          priority: ObservationPriority.VisibleInteractiveInViewport,
          role: 'textbox',
          tag: 'input',
          interactive: true,
          attributes: { type: 'password' },
          text: 'fixture-password-secret',
          targetIdentity: { backendNodeId: 1 },
        }),
      ]),
    );

    const serialized = JSON.stringify(observation);
    assert.equal(serialized.includes('fixture-password-secret'), false);
    assert.equal(observation.nodes[0].text, undefined);
    assert.equal(observation.nodes[0].states?.secret, true);
    assert.equal(observation.stats.redactedValueCount, 1);
  });

  it('redacts password values and counts redactions', () => {
    const { observation } = buildObservation(
      baseInput([
        candidate({
          documentOrder: 0,
          priority: ObservationPriority.VisibleInteractiveInViewport,
          role: 'textbox',
          tag: 'input',
          interactive: true,
          attributes: { type: 'password' },
          value: 'secret123',
          targetIdentity: { backendNodeId: 1 },
        }),
      ]),
    );

    assert.equal(observation.nodes[0].states?.secret, true);
    assert.equal(observation.nodes[0].value, undefined);
    assert.equal(observation.stats.redactedValueCount, 1);
  });

  it('truncates per-node text fields', () => {
    const longText = 'x'.repeat(250);
    const { observation } = buildObservation(
      baseInput([
        candidate({
          documentOrder: 0,
          priority: ObservationPriority.VisibleMeaningfulTextInViewport,
          role: 'text',
          text: longText,
        }),
      ]),
    );

    assert.equal(observation.nodes[0].text?.length, 200);
    assert.equal(observation.stats.truncated, true);
  });

  it('enforces total text budget deterministically', () => {
    const { observation } = buildObservation(
      baseInput(
        Array.from({ length: 70 }, (_, index) =>
          candidate({
            documentOrder: index,
            priority: ObservationPriority.StructuralContext,
            role: 'text',
            text: 'x'.repeat(200),
          }),
        ),
        {
          budgets: {
            maxEmittedNodes: 70,
            maxTotalTextChars: 1_000,
          },
        },
      ),
    );

    const totalText = observation.nodes.reduce(
      (sum, node) => sum + (node.name?.length ?? 0) + (node.value?.length ?? 0) + (node.text?.length ?? 0),
      0,
    );

    assert.ok(totalText <= 1_000);
    assert.equal(observation.stats.truncated, true);
  });

  it('filters and truncates attributes using the allowlist', () => {
    const { observation } = buildObservation(
      baseInput(
        [
          candidate({
            documentOrder: 0,
            priority: ObservationPriority.VisibleInteractiveInViewport,
            role: 'link',
            tag: 'a',
            interactive: true,
            attributes: {
              type: 'button',
              href: 'https://example.com/' + 'a'.repeat(250),
              placeholder: 'Search',
              autocomplete: 'email',
              alt: 'Logo',
              class: 'hidden',
              style: 'color:red',
              id: 'nav',
            },
            targetIdentity: { backendNodeId: 9 },
          }),
        ],
        {
          budgets: {
            maxAttributesPerNode: 4,
            maxAttributeValueChars: 200,
          },
        },
      ),
    );

    assert.deepEqual(Object.keys(observation.nodes[0].attributes ?? {}), [
      'type',
      'href',
      'placeholder',
      'autocomplete',
    ]);
    assert.equal(observation.nodes[0].attributes?.href.length, 200);
    assert.equal(observation.stats.truncated, true);
  });

  it('keeps higher-priority nodes and preserves document order', () => {
    const { observation } = buildObservation(
      baseInput(
        [
          candidate({
            documentOrder: 0,
            priority: ObservationPriority.StructuralContext,
            role: 'generic',
            text: 'low',
          }),
          candidate({
            documentOrder: 1,
            priority: ObservationPriority.VisibleInteractiveInViewport,
            role: 'button',
            interactive: true,
            name: 'Save',
            targetIdentity: { backendNodeId: 2 },
          }),
          candidate({
            documentOrder: 2,
            priority: ObservationPriority.HeadingInViewport,
            role: 'heading',
            name: 'Title',
          }),
        ],
        {
          budgets: {
            maxEmittedNodes: 2,
          },
        },
      ),
    );

    assert.equal(observation.nodes.length, 2);
    assert.equal(observation.nodes[0].name, 'Save');
    assert.equal(observation.nodes[1].name, 'Title');
    assert.equal(observation.stats.truncated, true);
  });

  it('marks externally truncated observations', () => {
    const { observation } = buildObservation(
      baseInput([], {
        externallyTruncated: true,
      }),
    );

    assert.equal(observation.stats.truncated, true);
  });

  it('does not mark observations truncated when externally truncated is false', () => {
    const { observation } = buildObservation(
      baseInput(
        [
          candidate({
            documentOrder: 0,
            priority: ObservationPriority.VisibleMeaningfulTextInViewport,
            role: 'text',
            text: 'Hello',
          }),
        ],
        {
          externallyTruncated: false,
        },
      ),
    );

    assert.equal(observation.stats.truncated, false);
  });

  it('serializes screenshot metadata without privileged image objects', () => {
    const screenshot = {
      mimeType: 'image/jpeg' as const,
      width: 800,
      height: 600,
      encoding: 'base64' as const,
      data: 'ZmFrZQ==',
    };

    const { observation } = buildObservation(
      baseInput([], {
        screenshot,
      }),
    );

    assert.deepEqual(observation.screenshot, screenshot);

    const serialized = JSON.stringify(observation);
    assert.equal(serialized.includes('NativeImage'), false);
    assert.equal(serialized.includes('Buffer'), false);
    assert.equal(serialized.includes('Electron'), false);
    assert.deepEqual(Object.keys(observation.screenshot ?? {}), [
      'mimeType',
      'width',
      'height',
      'encoding',
      'data',
    ]);
  });

  it('emits opaque targetIds without exposing backend node ids', () => {
    const { observation, targets } = buildObservation(
      baseInput([
        candidate({
          documentOrder: 0,
          priority: ObservationPriority.VisibleInteractiveInViewport,
          role: 'button',
          interactive: true,
          name: 'Go',
          targetIdentity: { backendNodeId: 77, axNodeId: 'ax-1' },
        }),
        candidate({
          documentOrder: 1,
          priority: ObservationPriority.HeadingInViewport,
          role: 'heading',
          name: 'Welcome',
        }),
      ]),
    );

    assert.ok(observation.nodes[0].targetId);
    assert.equal(observation.nodes[1].targetId, undefined);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].backendNodeId, 77);
    assert.equal(targets[0].axNodeId, 'ax-1');

    const serialized = JSON.stringify(observation);
    assert.equal(serialized.includes('backendNodeId'), false);
    assert.equal(serialized.includes('axNodeId'), false);
    assert.equal(serialized.includes('Electron'), false);
    assert.equal(serialized.includes('WebContents'), false);
  });
});
