import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  explicitTabCreatedEvent,
  shouldActivateConvertedPopup,
  websitePopupCreatedEvent,
} from './tab-creation';

describe('ElectronBrowserAdapter source isolation', () => {
  it('does not import AutonomousTask or AgentRun authority', () => {
    const source = readFileSync(path.join(__dirname, 'electron-adapter.ts'), 'utf8');
    for (const token of [
      'AutonomousTask',
      'TaskTabRegistry',
      'AgentRunCoordinator',
      'ApprovalManager',
    ]) {
      assert.equal(source.includes(token), false, token);
    }
  });
});


describe('tab creation helpers', () => {
  it('explicit createTab events are never causal', () => {
    const event = explicitTabCreatedEvent('tab-new');
    assert.equal(event.cause, 'explicit');
    assert.equal(event.causedByAgentInputDispatch, false);
    assert.equal(event.sourceTabId, undefined);
  });

  it('does not activate a popup when the source tab is inactive', () => {
    assert.equal(shouldActivateConvertedPopup('tab-a', 'tab-b'), false);
  });

  it('activates a popup when the source tab is currently active', () => {
    assert.equal(shouldActivateConvertedPopup('tab-a', 'tab-a'), true);
  });

  it('records causal website popups from the captured dispatch marker', () => {
    const event = websitePopupCreatedEvent({
      tabId: 'tab-c',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: true,
    });
    assert.equal(event.cause, 'website-popup');
    assert.equal(event.causedByAgentInputDispatch, true);
    assert.equal(event.sourceTabId, 'tab-a');
  });

  it('records non-causal popups captured outside the dispatch marker', () => {
    const event = websitePopupCreatedEvent({
      tabId: 'tab-c',
      sourceTabId: 'tab-a',
      causedByAgentInputDispatch: false,
    });
    assert.equal(event.causedByAgentInputDispatch, false);
  });
});
