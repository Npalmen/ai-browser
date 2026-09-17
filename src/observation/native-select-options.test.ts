import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { OBSERVATION_BUDGETS } from './budgets';
import { buildNativeSelectOptionCatalogs } from './native-select-options';
import { ObservationPriority, type ObservationCandidate } from './observation-builder';

function candidate(
  partial: Partial<ObservationCandidate> & Pick<ObservationCandidate, 'documentOrder'>,
): ObservationCandidate {
  return {
    frameId: 'frame-1',
    role: 'generic',
    interactive: false,
    visible: true,
    inViewport: true,
    priority: ObservationPriority.VisibleInteractiveInViewport,
    ...partial,
  };
}

describe('buildNativeSelectOptionCatalogs', () => {
  it('builds a bounded nativeOptions catalog for native select/option pairs', () => {
    const catalogs = buildNativeSelectOptionCatalogs(
      [
        {
          targetId: 'select-1',
          displayName: 'Color',
          candidate: candidate({
            documentOrder: 0,
            tag: 'select',
            role: 'combobox',
            targetIdentity: { backendNodeId: 1 },
          }),
        },
        {
          targetId: 'option-1',
          displayName: 'Red',
          selected: true,
          candidate: candidate({
            documentOrder: 1,
            tag: 'option',
            role: 'option',
            name: 'Red',
            parentBackendNodeId: 1,
            targetIdentity: { backendNodeId: 2 },
            selected: true,
          }),
        },
        {
          targetId: 'option-2',
          displayName: 'Blue',
          candidate: candidate({
            documentOrder: 2,
            tag: 'option',
            role: 'option',
            name: 'Blue',
            parentBackendNodeId: 1,
            targetIdentity: { backendNodeId: 3 },
          }),
        },
      ],
      OBSERVATION_BUDGETS,
    );

    const catalog = catalogs.get('select-1');
    assert.ok(catalog);
    assert.equal(catalog.length, 2);
    assert.equal(catalog[0]?.targetId, 'option-1');
    assert.equal(catalog[0]?.name, 'Red');
    assert.equal(catalog[0]?.selected, true);
    assert.equal(catalog[1]?.targetId, 'option-2');
    assert.equal(catalog[1]?.name, 'Blue');
  });

  it('omits catalogs for custom comboboxes and unreliable associations', () => {
    const catalogs = buildNativeSelectOptionCatalogs(
      [
        {
          targetId: 'combo-1',
          displayName: 'Fruit',
          candidate: candidate({
            documentOrder: 0,
            tag: 'div',
            role: 'combobox',
            targetIdentity: { backendNodeId: 10 },
          }),
        },
        {
          targetId: 'option-orphan',
          displayName: 'Apple',
          candidate: candidate({
            documentOrder: 1,
            tag: 'option',
            role: 'option',
            parentBackendNodeId: 99,
            targetIdentity: { backendNodeId: 11 },
          }),
        },
      ],
      OBSERVATION_BUDGETS,
    );

    assert.equal(catalogs.size, 0);
  });

  it('omits options whose prepared display name was redacted to empty', () => {
    const catalogs = buildNativeSelectOptionCatalogs(
      [
        {
          targetId: 'select-1',
          displayName: 'Color',
          candidate: candidate({
            documentOrder: 0,
            tag: 'select',
            role: 'combobox',
            targetIdentity: { backendNodeId: 1 },
          }),
        },
        {
          targetId: 'option-1',
          displayName: '',
          candidate: candidate({
            documentOrder: 1,
            tag: 'option',
            role: 'option',
            text: 'fixture-password-secret',
            attributes: { type: 'password' },
            parentBackendNodeId: 1,
            targetIdentity: { backendNodeId: 2 },
          }),
        },
      ],
      OBSERVATION_BUDGETS,
    );

    assert.equal(catalogs.size, 0);
  });
});
