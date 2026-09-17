import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildInteractiveModelPageContext,
  buildInteractiveModelMessages,
} from './interaction-context-builder';
import {
  buildModelPageContext,
  MODEL_CONTEXT_BUDGETS,
} from './context-builder';
import { decideModelExport } from './export-policy';
import { INTERACTION_SYSTEM_PROMPT } from './interaction-system-prompt';
import { READ_ONLY_SYSTEM_PROMPT } from './system-prompt';
import type { ObservationNode, PageObservation } from '../shared/observation-types';

const SECRET_LITERAL = 'fixture-secret-value';

function node(
  overrides: Partial<ObservationNode> & Pick<ObservationNode, 'role'>,
): ObservationNode {
  return {
    frameId: 'frame-1',
    interactive: false,
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
    observationId: 'obs-1',
    tabId: 'tab-1',
    capturedAt: 1_700_000_000_000,
    document: {
      revision: 'rev-a',
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

describe('buildInteractiveModelPageContext', () => {
  it('exports nativeOptions only on the interactive path', () => {
    const page = observation([
      node({
        targetId: 'select-1',
        role: 'combobox',
        name: 'Color',
        tag: 'select',
        interactive: true,
        nativeOptions: [
          { targetId: 'option-1', name: 'Red', selected: true },
          { targetId: 'option-2', name: 'Blue' },
        ],
      }),
    ]);

    const v2 = buildModelPageContext(page);
    const interactive = buildInteractiveModelPageContext(page);

    assert.equal('nativeOptions' in (v2.context.nodes[0] ?? {}), false);
    assert.doesNotMatch(v2.serialized, /nativeOptions/);
    assert.deepEqual(interactive.context.nodes[0]?.nativeOptions, [
      { targetId: 'option-1', name: 'Red', selected: true },
      { targetId: 'option-2', name: 'Blue' },
    ]);
  });

  it('includes serialized native option target IDs in exportedTargetIds', () => {
    const built = buildInteractiveModelPageContext(
      observation([
        node({
          targetId: 'select-1',
          role: 'combobox',
          name: 'Color',
          tag: 'select',
          interactive: true,
          nativeOptions: [
            { targetId: 'option-1', name: 'Red' },
            { targetId: 'option-2', name: 'Blue' },
          ],
        }),
      ]),
    );

    assert.equal(built.exportedTargetIds.has('select-1'), true);
    assert.equal(built.exportedTargetIds.has('option-1'), true);
    assert.equal(built.exportedTargetIds.has('option-2'), true);
  });

  it('omits dropped native option target IDs from exportedTargetIds under budget pressure', () => {
    const options = Array.from({ length: 40 }, (_, index) => ({
      targetId: `option-${index}`,
      name: `Option ${index} `.repeat(40),
    }));
    const built = buildInteractiveModelPageContext(
      observation([
        node({
          targetId: 'select-1',
          role: 'combobox',
          name: 'Color',
          tag: 'select',
          interactive: true,
          nativeOptions: options,
        }),
      ]),
      { maxStructuredChars: 2_500 },
    );

    const exportedOptionIds = [...built.exportedTargetIds].filter((id) => id.startsWith('option-'));
    assert.ok(exportedOptionIds.length < options.length);
    for (const optionId of exportedOptionIds) {
      assert.match(built.serialized, new RegExp(optionId));
    }
    for (const option of options) {
      if (!exportedOptionIds.includes(option.targetId)) {
        assert.doesNotMatch(built.serialized, new RegExp(option.targetId));
        assert.equal(built.exportedTargetIds.has(option.targetId), false);
      }
    }
    assert.equal(built.context.truncated, true);
  });

  it('preserves the 24k structured budget default', () => {
    const built = buildInteractiveModelPageContext(
      observation([
        node({
          targetId: 'select-1',
          role: 'combobox',
          name: 'Color',
          tag: 'select',
          interactive: true,
          nativeOptions: [{ targetId: 'option-1', name: 'Red' }],
        }),
      ]),
    );

    assert.ok(built.serialized.length <= MODEL_CONTEXT_BUDGETS.maxStructuredChars);
  });

  it('keeps V2 buildModelPageContext unchanged for the same observation', () => {
    const page = observation([
      node({
        targetId: 'select-1',
        role: 'combobox',
        name: 'Color',
        tag: 'select',
        interactive: true,
        nativeOptions: [{ targetId: 'option-1', name: 'Red' }],
      }),
      node({
        targetId: 'button-1',
        role: 'button',
        name: 'Save',
        tag: 'button',
        interactive: true,
      }),
    ]);

    const v2 = buildModelPageContext(page);
    const v2Again = buildModelPageContext(page);

    assert.deepEqual(v2, v2Again);
    assert.doesNotMatch(v2.serialized, /nativeOptions/);
    assert.doesNotMatch(v2.serialized, /observationId/);
    assert.doesNotMatch(v2.serialized, /tabId/);
    assert.doesNotMatch(v2.serialized, /backendNodeId/);
    assert.doesNotMatch(v2.serialized, /frameId/);
  });

  it('uses redacted native option names from PageObservation only', () => {
    const built = buildInteractiveModelPageContext(
      observation([
        node({
          targetId: 'select-1',
          role: 'combobox',
          name: 'Color',
          tag: 'select',
          interactive: true,
          nativeOptions: [{ targetId: 'option-1', name: '[redacted]' }],
        }),
      ]),
    );

    assert.equal(built.context.nodes[0]?.nativeOptions?.[0]?.name, '[redacted]');
    assert.doesNotMatch(built.serialized, new RegExp(SECRET_LITERAL));
  });
});

describe('buildInteractiveModelMessages', () => {
  it('uses the interaction system prompt instead of the read-only prompt', () => {
    const messages = buildInteractiveModelMessages({
      instruction: 'Click save',
      serializedPageContext: '{"document":{"url":"https://example.com"}}',
      exportDecision: decideModelExport({
        privacy: 'remoteAllowed',
        needsVision: false,
        allowScreenshotExport: false,
        profile: {
          capabilities: { text: true, vision: false, structuredOutput: true, reasoning: false },
        },
        hasScreenshot: false,
      }),
    });

    const system = messages[0]?.content[0];
    assert.equal(system?.type, 'text');
    if (system?.type === 'text') {
      assert.equal(system.text, INTERACTION_SYSTEM_PROMPT);
      assert.notEqual(system.text, READ_ONLY_SYSTEM_PROMPT);
    }
  });
});
