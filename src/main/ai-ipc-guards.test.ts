import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isAiSafeError, parseAskId, parsePanelOpen, parseQuestion, parseTabId } from './ai-ipc-guards';

describe('AI IPC guards', () => {
  it('accepts a non-empty tab id and question', () => {
    assert.equal(parseTabId('tab-1'), 'tab-1');
    assert.equal(parseQuestion('  What is this?  '), 'What is this?');
  });

  it('rejects empty or non-string values', () => {
    assert.equal(isAiSafeError(parseTabId('')), true);
    assert.equal(isAiSafeError(parseTabId(1)), true);
    assert.equal(isAiSafeError(parseQuestion('')), true);
    assert.equal(isAiSafeError(parseQuestion('   ')), true);
    assert.equal(isAiSafeError(parseAskId('')), true);
    assert.equal(isAiSafeError(parseAskId('x'.repeat(200))), true);
    assert.equal(isAiSafeError(parsePanelOpen('true')), true);
    assert.equal(parsePanelOpen(true), true);
  });
});
