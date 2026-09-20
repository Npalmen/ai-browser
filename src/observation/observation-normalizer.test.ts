import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAccessibilityTree } from './ax-parser';
import { decodeSnapshotString, parseDomSnapshot } from './dom-snapshot-parser';
import { buildObservation, ObservationPriority } from './observation-builder';
import { normalizeCollectedSources } from './observation-normalizer';
import type {
  CdpAccessibilityTreeResponse,
  CdpDomSnapshotResponse,
  CdpFrameTreeResponse,
  CdpLayoutMetricsResponse,
} from './cdp-types';

function layoutMetrics(overrides: Partial<CdpLayoutMetricsResponse> = {}): CdpLayoutMetricsResponse {
  return {
    cssVisualViewport: {
      clientWidth: 800,
      clientHeight: 600,
      pageX: 100,
      pageY: 50,
      scale: 2,
    },
    ...overrides,
  };
}

function frameTree(overrides: Partial<CdpFrameTreeResponse> = {}): CdpFrameTreeResponse {
  return {
    frameTree: {
      frame: {
        id: 'main-frame',
        loaderId: 'loader-1',
        url: 'https://example.com/',
        securityOrigin: 'https://example.com',
      },
      childFrames: [],
    },
    ...overrides,
  };
}

function baseSnapshot(): CdpDomSnapshotResponse {
  return {
    strings: [
      '#document',
      'button',
      'id',
      'submit',
      'block',
      'visible',
      '1',
      'none',
      'hidden',
      '0',
      '#text',
      'Hello',
      'iframe',
      'src',
      'https://other.test/frame',
      'div',
      'child-btn',
      'child',
    ],
    documents: [
      {
        nodes: {
          parentIndex: [-1, 0, 0, 0, 0, 0],
          nodeType: [9, 1, 1, 1, 3, 1],
          nodeName: [0, 1, 1, 1, 11, 12],
          backendNodeId: [100, 3, 2, 4, 6, 7],
          attributes: [[], [2, 3], [], [], [], [13, 14]],
          textValue: { index: [4], value: [11] },
          contentDocumentIndex: { index: [5], value: [1] },
        },
        layout: {
          nodeIndex: [1, 2, 3, 5, 4],
          bounds: [100, 150, 120, 40, 900, 200, 80, 30, 100, 300, 400, 24, 100, 400, 300, 200, 100, 500, 200, 20],
          styles: [4, 5, 6, 4, 8, 9, 7, 5, 6, 4, 5, 6, 4, 5, 6],
        },
      },
      {
        frameId: 'child-frame',
        nodes: {
          parentIndex: [-1, 0],
          nodeType: [9, 1],
          nodeName: [0, 1],
          backendNodeId: [10, 11],
          attributes: [[], [17, 18]],
        },
        layout: {
          nodeIndex: [1],
          bounds: [0, 0, 50, 20],
          styles: [4, 5, 6],
        },
      },
    ],
  };
}

describe('dom-snapshot-parser', () => {
  it('decodes string table, tags, attributes, and layout bounds', () => {
    const snapshot = baseSnapshot();
    assert.equal(decodeSnapshotString(snapshot.strings, 1), 'button');

    const parsed = parseDomSnapshot(
      snapshot,
      new Map([
        [0, 'main-frame'],
        [1, 'child-frame'],
      ]),
      100,
      50,
    );

    const button = parsed.nodes.find((node) => node.backendNodeId === 3);
    assert.ok(button);
    assert.equal(button.tag, 'button');
    assert.equal(button.attributes.id, 'submit');
    assert.deepEqual(button.bounds, { x: 0, y: 100, width: 120, height: 40 });
    assert.equal(button.display, 'block');
    assert.equal(button.visibility, 'visible');
    assert.equal(button.opacity, 1);
  });

  it('marks display none, visibility hidden, and opacity zero as invisible styles', () => {
    const parsed = parseDomSnapshot(
      baseSnapshot(),
      new Map([
        [0, 'main-frame'],
        [1, 'child-frame'],
      ]),
      100,
      50,
    );

    const hiddenDisplay = parsed.nodes.find((node) => node.backendNodeId === 4);
    const hiddenVisibility = parsed.nodes.find((node) => node.backendNodeId === 2);
    assert.equal(hiddenDisplay?.display, 'none');
    assert.equal(hiddenVisibility?.visibility, 'hidden');
    assert.equal(hiddenVisibility?.opacity, 0);
    assert.equal(hiddenVisibility?.display, 'block');
  });

  it('parses Chromium rectangle-array layout bounds', () => {
    const parsed = parseDomSnapshot(
      {
        strings: ['#document', 'button', 'block', 'visible', '1'],
        documents: [
          {
            nodes: {
              parentIndex: [-1, 0],
              nodeType: [9, 1],
              nodeName: [0, 1],
              backendNodeId: [1, 2],
              attributes: [[], []],
            },
            layout: {
              nodeIndex: [1],
              bounds: [[100, 150, 120, 40]],
              styles: [2, 3, 4],
            },
          },
        ],
      },
      new Map([[0, 'main-frame']]),
      100,
      50,
    );

    assert.deepEqual(parsed.nodes[1].bounds, { x: 0, y: 100, width: 120, height: 40 });
  });

  it('converts offscreen bounds into viewport coordinates', () => {
    const parsed = parseDomSnapshot(
      baseSnapshot(),
      new Map([
        [0, 'main-frame'],
        [1, 'child-frame'],
      ]),
      100,
      50,
    );

    const offscreen = parsed.nodes.find((node) => node.backendNodeId === 2);
    assert.deepEqual(offscreen?.bounds, { x: 800, y: 150, width: 80, height: 30 });
  });
});

describe('ax-parser', () => {
  it('extracts role, name, value, backend join, and ignores ignored nodes', () => {
    const response: CdpAccessibilityTreeResponse = {
      nodes: [
        { nodeId: 'ax-ignored', ignored: true, role: { value: 'button' } },
        {
          nodeId: 'ax-1',
          role: { value: 'button' },
          name: { value: 'Submit' },
          backendDOMNodeId: 3,
          properties: [{ name: 'focused', value: { type: 'boolean', value: true } }],
        },
        {
          nodeId: 'ax-2',
          role: { value: 'textbox' },
          name: { value: 'Search' },
        },
      ],
    };

    const parsed = parseAccessibilityTree(response);
    assert.equal(parsed.nodes.length, 2);
    assert.equal(parsed.nodes[0].backendDOMNodeId, 3);
    assert.equal(parsed.nodes[0].focused, true);
    assert.equal(parsed.nodes[1].backendDOMNodeId, undefined);
  });

  it('decodes checked mixed state', () => {
    const parsed = parseAccessibilityTree({
      nodes: [
        {
          nodeId: 'ax-check',
          role: { value: 'checkbox' },
          properties: [{ name: 'checked', value: { type: 'tristate', value: 'mixed' } }],
        },
      ],
    });

    assert.equal(parsed.nodes[0].checked, 'mixed');
  });
});

describe('normalizeCollectedSources', () => {
  it('derives documentHeight from cssContentSize layout metrics', () => {
    const normalized = normalizeCollectedSources({
      frameTree: frameTree(),
      layoutMetrics: layoutMetrics({
        cssContentSize: { width: 800, height: 4200 },
      }),
      accessibilityTree: { nodes: [] },
      domSnapshot: baseSnapshot(),
      documentIdentity: {
        mainFrameId: 'main-frame',
        loaderId: 'loader-1',
        revision: 'main-frame:loader-1',
      },
      pageMetadata: { url: 'https://example.com/', title: 'Example', loading: false },
    });

    assert.equal(normalized.viewport.documentHeight, 4200);
  });

  it('joins AX and DOM on backendNodeId without duplicates', () => {
    const ax: CdpAccessibilityTreeResponse = {
      nodes: [
        {
          nodeId: 'ax-button',
          role: { value: 'button' },
          name: { value: 'Submit' },
          backendDOMNodeId: 3,
          properties: [{ name: 'focusable', value: { type: 'boolean', value: true } }],
        },
      ],
    };

    const normalized = normalizeCollectedSources({
      frameTree: frameTree(),
      layoutMetrics: layoutMetrics(),
      accessibilityTree: ax,
      domSnapshot: baseSnapshot(),
      documentIdentity: {
        mainFrameId: 'main-frame',
        loaderId: 'loader-1',
        revision: 'main-frame:loader-1',
      },
      pageMetadata: {
        url: 'https://example.com/',
        title: 'Example',
        loading: false,
      },
    });

    const joined = normalized.candidates.filter(
      (candidate) => candidate.role === 'button' && candidate.frameId === 'main-frame',
    );
    assert.equal(joined.length, 3);
    const mainButton = joined.find((candidate) => candidate.targetIdentity?.backendNodeId === 3);
    assert.ok(mainButton);
    assert.equal(mainButton.targetIdentity?.axNodeId, 'ax-button');
    assert.equal(mainButton.interactive, true);
    assert.equal(mainButton.priority, ObservationPriority.VisibleInteractiveInViewport);
  });

  it('keeps semantic-only AX nodes without target identity', () => {
    const normalized = normalizeCollectedSources({
      frameTree: frameTree(),
      layoutMetrics: layoutMetrics(),
      accessibilityTree: {
        nodes: [{ nodeId: 'ax-only', role: { value: 'status' }, name: { value: 'Saved' } }],
      },
      domSnapshot: { strings: [], documents: [] },
      documentIdentity: {
        mainFrameId: 'main-frame',
        loaderId: 'loader-1',
        revision: 'main-frame:loader-1',
      },
      pageMetadata: { url: 'about:blank', title: '', loading: false },
    });

    const axOnly = normalized.candidates.find((candidate) => candidate.role === 'status');
    assert.ok(axOnly);
    assert.equal(axOnly.targetIdentity, undefined);
  });

  it('emits DOM-only visible text and same-origin child frame nodes', () => {
    const normalized = normalizeCollectedSources({
      frameTree: frameTree({
        frameTree: {
          frame: {
            id: 'main-frame',
            loaderId: 'loader-1',
            securityOrigin: 'https://example.com',
          },
          childFrames: [
            {
              frame: {
                id: 'child-frame',
                securityOrigin: 'https://example.com',
              },
            },
          ],
        },
      }),
      layoutMetrics: layoutMetrics(),
      accessibilityTree: { nodes: [] },
      domSnapshot: baseSnapshot(),
      documentIdentity: {
        mainFrameId: 'main-frame',
        loaderId: 'loader-1',
        revision: 'main-frame:loader-1',
      },
      pageMetadata: { url: 'https://example.com/', title: 'Example', loading: false },
    });

    const text = normalized.candidates.find((candidate) => candidate.text === 'Hello');
    assert.ok(text);
    assert.equal(text.frameId, 'main-frame');

    const childButton = normalized.candidates.find(
      (candidate) => candidate.targetIdentity?.backendNodeId === 11,
    );
    assert.ok(childButton);
    assert.equal(childButton.frameId, 'child-frame');
  });

  it('decodes child document frameId from the DOMSnapshot string table', () => {
    const normalized = normalizeCollectedSources({
      frameTree: frameTree({
        frameTree: {
          frame: {
            id: 'main-frame',
            loaderId: 'loader-1',
            securityOrigin: 'https://example.com',
          },
          childFrames: [
            {
              frame: {
                id: 'child-frame',
                securityOrigin: 'https://example.com',
              },
            },
          ],
        },
      }),
      layoutMetrics: layoutMetrics(),
      accessibilityTree: { nodes: [] },
      domSnapshot: {
        strings: ['#document', 'button', 'child-frame', 'block', 'visible', '1'],
        documents: [
          {
            nodes: {
              parentIndex: [-1],
              nodeType: [9],
              nodeName: [0],
              backendNodeId: [100],
              attributes: [[]],
            },
            layout: { nodeIndex: [], bounds: [], styles: [] },
          },
          {
            frameId: 2,
            nodes: {
              parentIndex: [-1, 0],
              nodeType: [9, 1],
              nodeName: [0, 1],
              backendNodeId: [10, 11],
              attributes: [[], []],
            },
            layout: {
              nodeIndex: [1],
              bounds: [0, 0, 50, 20],
              styles: [3, 4, 5],
            },
          },
        ],
      },
      documentIdentity: {
        mainFrameId: 'main-frame',
        loaderId: 'loader-1',
        revision: 'main-frame:loader-1',
      },
      pageMetadata: { url: 'https://example.com/', title: 'Example', loading: false },
    });

    const child = normalized.candidates.find(
      (candidate) => candidate.targetIdentity?.backendNodeId === 11,
    );
    assert.ok(child);
    assert.equal(child.frameId, 'child-frame');
  });

  it('creates bounded cross-origin iframe placeholders without interior claims', () => {
    const normalized = normalizeCollectedSources({
      frameTree: frameTree({
        frameTree: {
          frame: {
            id: 'main-frame',
            loaderId: 'loader-1',
            securityOrigin: 'https://example.com',
          },
          childFrames: [
            {
              frame: {
                id: 'child-frame',
                securityOrigin: 'https://other.test',
              },
            },
          ],
        },
      }),
      layoutMetrics: layoutMetrics(),
      accessibilityTree: { nodes: [] },
      domSnapshot: baseSnapshot(),
      documentIdentity: {
        mainFrameId: 'main-frame',
        loaderId: 'loader-1',
        revision: 'main-frame:loader-1',
      },
      pageMetadata: { url: 'https://example.com/', title: 'Example', loading: false },
    });

    const iframe = normalized.candidates.find((candidate) => candidate.role === 'iframe');
    assert.ok(iframe);
    assert.equal(iframe.frameId, 'child-frame');
    assert.equal(iframe.interactive, false);
    assert.equal(iframe.attributes?.src, 'https://other.test/frame');
    assert.equal(
      normalized.candidates.some((candidate) => candidate.targetIdentity?.backendNodeId === 11),
      false,
    );
    assert.equal(normalized.sourceStats.crossOriginFrameCount, 1);
    assert.equal(normalized.sourceStats.frameCount, 2);
  });
});

describe('builder integration via normalizeCollectedSources', () => {
  it('assigns opaque target IDs, hides backend IDs, and redacts password values', () => {
    const normalized = normalizeCollectedSources({
      frameTree: frameTree(),
      layoutMetrics: layoutMetrics(),
      accessibilityTree: {
        nodes: [
          {
            nodeId: 'ax-password',
            role: { value: 'textbox' },
            name: { value: 'Password' },
            value: { value: 'secret' },
            backendDOMNodeId: 4,
          },
        ],
      },
      domSnapshot: {
        strings: ['#document', 'input', 'type', 'password', 'block', 'visible', '1'],
        documents: [
          {
            nodes: {
              parentIndex: [-1, 0],
              nodeType: [9, 1],
              nodeName: [0, 1],
              backendNodeId: [1, 4],
              attributes: [[], [2, 3]],
            },
            layout: {
              nodeIndex: [1],
              bounds: [110, 70, 100, 30],
              styles: [4, 5, 6],
            },
          },
        ],
      },
      documentIdentity: {
        mainFrameId: 'main-frame',
        loaderId: 'loader-1',
        revision: 'main-frame:loader-1',
      },
      pageMetadata: { url: 'https://example.com/', title: 'Example', loading: false },
    });

    const built = buildObservation({
      observationId: 'obs-1',
      tabId: 'tab-1',
      capturedAt: 1,
      document: normalized.document,
      viewport: normalized.viewport,
      candidates: normalized.candidates,
      sourceStats: normalized.sourceStats,
    });

    const passwordNode = built.observation.nodes.find((node) => node.role === 'textbox');
    assert.ok(passwordNode?.targetId);
    assert.equal((passwordNode as { backendNodeId?: number }).backendNodeId, undefined);
    assert.equal(passwordNode.value, undefined);
    assert.equal(built.observation.stats.redactedValueCount, 1);
    assert.equal(built.observation.stats.sourceAxNodeCount, 1);
    assert.equal(built.observation.viewport.deviceScaleFactor, 2);
  });
});
