import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InteractionError } from '../shared/interaction-errors';
import type {
  CdpAccessibilityTreeResponse,
  CdpAxProperty,
  CdpDomSnapshotResponse,
} from '../observation/cdp-types';
import {
  deriveNativeSelectKeyboardPlan,
  MAX_NATIVE_SELECT_KEY_STEPS,
} from './native-select-preflight';

const ELEMENT_NODE = 1;

interface SnapshotOption {
  backendNodeId: number;
  selected?: boolean;
  disabled?: boolean;
  parent?: 'select' | 'optgroup' | number;
}

function intern(strings: string[], value: string): number {
  const existing = strings.indexOf(value);
  if (existing >= 0) {
    return existing;
  }
  strings.push(value);
  return strings.length - 1;
}

function buildLiveSelectSources(input: {
  selectBackendNodeId?: number;
  multiple?: boolean;
  includeOptgroup?: boolean;
  options: SnapshotOption[];
  extraSelect?: {
    backendNodeId: number;
    options: SnapshotOption[];
  };
}): { accessibilityTree: CdpAccessibilityTreeResponse; domSnapshot: CdpDomSnapshotResponse } {
  const selectBackendNodeId = input.selectBackendNodeId ?? 10;
  const strings: string[] = [];
  const parentIndex: number[] = [];
  const nodeType: number[] = [];
  const nodeName: number[] = [];
  const nodeValue: number[] = [];
  const backendNodeId: number[] = [];
  const attributes: number[][] = [];

  const pushElement = (
    tag: string,
    id: number,
    parent: number,
    attrs: Record<string, string> = {},
  ): number => {
    const index = backendNodeId.length;
    parentIndex.push(parent);
    nodeType.push(ELEMENT_NODE);
    nodeName.push(intern(strings, tag.toUpperCase()));
    nodeValue.push(intern(strings, ''));
    backendNodeId.push(id);
    const pairs: number[] = [];
    for (const [name, value] of Object.entries(attrs)) {
      pairs.push(intern(strings, name), intern(strings, value));
    }
    attributes.push(pairs);
    return index;
  };

  pushElement('html', 1, -1);
  const selectAttrs: Record<string, string> = {};
  if (input.multiple) {
    selectAttrs.multiple = '';
  }
  const selectIndex = pushElement('select', selectBackendNodeId, 0, selectAttrs);

  let optgroupIndex: number | undefined;
  if (input.includeOptgroup) {
    optgroupIndex = pushElement('optgroup', 99, selectIndex, { label: 'Group' });
  }

  for (const option of input.options) {
    const optionAttrs: Record<string, string> = {};
    if (option.selected) {
      optionAttrs.selected = '';
    }
    if (option.disabled) {
      optionAttrs.disabled = '';
    }
    const parent =
      option.parent === 'optgroup' && optgroupIndex !== undefined
        ? optgroupIndex
        : typeof option.parent === 'number'
          ? option.parent
          : selectIndex;
    pushElement('option', option.backendNodeId, parent, optionAttrs);
  }

  if (input.extraSelect) {
    const extraSelectIndex = pushElement('select', input.extraSelect.backendNodeId, 0);
    for (const option of input.extraSelect.options) {
      pushElement('option', option.backendNodeId, extraSelectIndex);
    }
  }

  const accessibilityTree: CdpAccessibilityTreeResponse = {
    nodes: [
      {
        nodeId: 'select',
        role: { value: 'combobox' },
        backendDOMNodeId: selectBackendNodeId,
      },
      ...input.options.map((option, index) => {
        const properties: CdpAxProperty[] = [];
        if (option.selected) {
          properties.push({ name: 'selected', value: { type: 'boolean', value: true } });
        }
        if (option.disabled) {
          properties.push({ name: 'disabled', value: { type: 'boolean', value: true } });
        }
        return {
          nodeId: `option-${index}`,
          role: { value: 'option' },
          backendDOMNodeId: option.backendNodeId,
          properties,
        };
      }),
    ],
  };

  return {
    accessibilityTree,
    domSnapshot: {
      strings,
      documents: [
        {
          frameId: 'frame-1',
          nodes: {
            parentIndex,
            nodeType,
            nodeName,
            nodeValue,
            backendNodeId,
            attributes,
          },
          layout: { nodeIndex: [], bounds: [], styles: [] },
        },
      ],
    },
  };
}

function derive(input: {
  optionBackendNodeId: number;
  selectBackendNodeId?: number;
  sources: ReturnType<typeof buildLiveSelectSources>;
}) {
  return deriveNativeSelectKeyboardPlan({
    selectBackendNodeId: input.selectBackendNodeId ?? 10,
    optionBackendNodeId: input.optionBackendNodeId,
    expectedFrameId: 'frame-1',
    mainFrameId: 'frame-1',
    accessibilityTree: input.sources.accessibilityTree,
    domSnapshot: input.sources.domSnapshot,
  });
}

/** Defective catalog-index algorithm retained only to prove it is unsafe. */
function unsafeCatalogKeyboardDelta(
  nativeOptions: Array<{ targetId: string; selected?: true }>,
  optionTargetId: string,
): number {
  const targetIndex = nativeOptions.findIndex((option) => option.targetId === optionTargetId);
  const selectedIndex = nativeOptions.findIndex((option) => option.selected === true);
  const startIndex = selectedIndex >= 0 ? selectedIndex : 0;
  return targetIndex - startIndex;
}

describe('native select live preflight', () => {
  it('does not use filtered nativeOptions indexes for keyboard movement', () => {
    const sources = buildLiveSelectSources({
      options: [
        { backendNodeId: 11, selected: true },
        { backendNodeId: 12 },
        { backendNodeId: 13 },
      ],
    });

    const catalog = [
      { targetId: 'option-a', selected: true as const },
      { targetId: 'option-c' },
    ];
    assert.equal(unsafeCatalogKeyboardDelta(catalog, 'option-c'), 1);

    const plan = derive({ optionBackendNodeId: 13, sources });
    assert.equal(plan.keyboardDelta, 2);
    assert.deepEqual(plan.liveOptionBackendNodeIds, [11, 12, 13]);
    assert.equal(plan.optionBackendNodeId, 13);
    assert.equal(plan.selectedBackendNodeId, 11);
  });

  it('derives current selected position when the selected option is omitted from the exported catalog', () => {
    const sources = buildLiveSelectSources({
      options: [
        { backendNodeId: 11 },
        { backendNodeId: 12 },
        { backendNodeId: 13, selected: true },
        { backendNodeId: 14 },
        { backendNodeId: 15 },
      ],
    });

    const catalog = [{ targetId: 'option-a' }, { targetId: 'option-e' }];
    assert.equal(unsafeCatalogKeyboardDelta(catalog, 'option-e'), 1);

    const plan = derive({ optionBackendNodeId: 15, sources });
    assert.equal(plan.keyboardDelta, 2);
    assert.equal(plan.selectedBackendNodeId, 13);
    assert.equal(plan.optionBackendNodeId, 15);
  });

  it('never defaults a missing selected catalog entry to index 0', () => {
    const sources = buildLiveSelectSources({
      options: [
        { backendNodeId: 11 },
        { backendNodeId: 12 },
        { backendNodeId: 13, selected: true },
        { backendNodeId: 14 },
      ],
    });
    const catalog = [{ targetId: 'option-a' }, { targetId: 'option-d' }];
    assert.equal(unsafeCatalogKeyboardDelta(catalog, 'option-d'), 1);

    const plan = derive({ optionBackendNodeId: 14, sources });
    assert.equal(plan.keyboardDelta, 1);
    assert.equal(plan.selectedBackendNodeId, 13);
    assert.notEqual(plan.selectedBackendNodeId, plan.liveOptionBackendNodeIds[0]);
  });

  it('fails closed when no uniquely selected starting option can be proven', () => {
    const sources = buildLiveSelectSources({
      options: [
        { backendNodeId: 11 },
        { backendNodeId: 12 },
        { backendNodeId: 13 },
      ],
    });

    assert.throws(
      () => derive({ optionBackendNodeId: 13, sources }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'UNSUPPORTED_TARGET');
        return true;
      },
    );
  });

  it('fails closed when the granted option was removed', () => {
    const sources = buildLiveSelectSources({
      options: [
        { backendNodeId: 11, selected: true },
        { backendNodeId: 12 },
      ],
    });

    assert.throws(
      () => derive({ optionBackendNodeId: 13, sources }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_NOT_FOUND');
        return true;
      },
    );
  });

  it('fails closed when the granted option moved to another select', () => {
    const sources = buildLiveSelectSources({
      options: [{ backendNodeId: 11, selected: true }],
      extraSelect: {
        backendNodeId: 20,
        options: [{ backendNodeId: 13 }],
      },
    });

    assert.throws(
      () => derive({ optionBackendNodeId: 13, sources }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'TARGET_STALE');
        return true;
      },
    );
  });

  it('fails closed for disabled options rather than guessing keyboard skips', () => {
    const sources = buildLiveSelectSources({
      options: [
        { backendNodeId: 11, selected: true },
        { backendNodeId: 12, disabled: true },
        { backendNodeId: 13 },
      ],
    });

    assert.throws(
      () => derive({ optionBackendNodeId: 13, sources }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'UNSUPPORTED_TARGET');
        return true;
      },
    );
  });

  it('fails closed for multiple native selects', () => {
    const sources = buildLiveSelectSources({
      multiple: true,
      options: [
        { backendNodeId: 11, selected: true },
        { backendNodeId: 12 },
      ],
    });

    assert.throws(
      () => derive({ optionBackendNodeId: 12, sources }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'UNSUPPORTED_TARGET');
        return true;
      },
    );
  });

  it('fails closed for optgroup structures', () => {
    const sources = buildLiveSelectSources({
      includeOptgroup: true,
      options: [
        { backendNodeId: 11, selected: true, parent: 'optgroup' },
        { backendNodeId: 12, parent: 'optgroup' },
      ],
    });

    assert.throws(
      () => derive({ optionBackendNodeId: 12, sources }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'UNSUPPORTED_TARGET');
        return true;
      },
    );
  });

  it('fails closed when keyboard steps exceed the bound', () => {
    const options: SnapshotOption[] = [{ backendNodeId: 11, selected: true }];
    for (let index = 0; index < MAX_NATIVE_SELECT_KEY_STEPS + 1; index += 1) {
      options.push({ backendNodeId: 12 + index });
    }
    const sources = buildLiveSelectSources({ options });
    const targetBackendNodeId = 12 + MAX_NATIVE_SELECT_KEY_STEPS;

    assert.throws(
      () => derive({ optionBackendNodeId: targetBackendNodeId, sources }),
      (error: unknown) => {
        assert.ok(error instanceof InteractionError);
        assert.equal(error.code, 'UNSUPPORTED_TARGET');
        return true;
      },
    );
  });

  it('matches the granted option by backend identity rather than name or value', () => {
    const sources = buildLiveSelectSources({
      options: [
        { backendNodeId: 11, selected: true },
        { backendNodeId: 12 },
        { backendNodeId: 13 },
      ],
    });

    const plan = derive({ optionBackendNodeId: 13, sources });
    assert.equal(plan.optionBackendNodeId, 13);
    assert.equal(plan.liveOptionBackendNodeIds[plan.liveOptionBackendNodeIds.length - 1], 13);
    assert.equal(JSON.stringify(plan).includes('Charlie'), false);
    assert.equal(JSON.stringify(plan).includes('value'), false);
  });
});
