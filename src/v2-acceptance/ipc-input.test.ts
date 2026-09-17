import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAskCurrentPageRequest, parseAskId, parsePanelOpen, parseQuestion, parseTabId, isAiSafeError } from '../main/ai-ipc-guards';
import { isExactTrustedAppSender } from '../main/ipc-security';

const ACTIVE = {
  activeTabId: 'tab-live',
  tabs: [{ id: 'tab-live' }, { id: 'tab-other' }],
};

describe('V2 IPC input fail-closed', () => {
  it('rejects empty or non-string tabId and question', () => {
    assert.equal(isAiSafeError(parseTabId('')), true);
    assert.equal(isAiSafeError(parseTabId(1)), true);
    assert.equal(isAiSafeError(parseQuestion('')), true);
    assert.equal(isAiSafeError(parseQuestion('   ')), true);
    assert.equal(isAiSafeError(parseQuestion(null)), true);
  });

  it('rejects malformed and oversized askId', () => {
    assert.equal(isAiSafeError(parseAskId('')), true);
    assert.equal(isAiSafeError(parseAskId(12)), true);
    assert.equal(isAiSafeError(parseAskId('x'.repeat(200))), true);
    assert.equal(parseAskId('ask-ok'), 'ask-ok');
  });

  it('rejects non-boolean panel open values', () => {
    assert.equal(isAiSafeError(parsePanelOpen('true')), true);
    assert.equal(isAiSafeError(parsePanelOpen(1)), true);
    assert.equal(parsePanelOpen(false), false);
  });

  it('rejects askCurrentPage for a nonexistent tab', () => {
    const result = parseAskCurrentPageRequest(
      { tabId: 'missing', question: 'What is this?' },
      ACTIVE,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'INVALID_REQUEST');
      assert.equal(result.error.message, 'The AI request was invalid.');
      assert.equal('stack' in result.error, false);
    }
  });

  it('rejects askCurrentPage for a non-active tab', () => {
    const result = parseAskCurrentPageRequest(
      { tabId: 'tab-other', question: 'What is this?' },
      ACTIVE,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'INVALID_REQUEST');
    }
  });

  it('accepts askCurrentPage only for the active existing tab', () => {
    const result = parseAskCurrentPageRequest(
      { tabId: 'tab-live', question: '  What is this?  ' },
      ACTIVE,
    );
    assert.deepEqual(result, { ok: true, tabId: 'tab-live', question: 'What is this?' });
  });
});

describe('V2 trusted sender identity', () => {
  it('requires exact sender and mainFrame object identity', () => {
    const mainWebContents = { id: 'main-wc' };
    const mainFrame = { id: 'main-frame' };
    const websiteWebContents = { id: 'website-wc' };
    const otherFrame = { id: 'other-frame' };

    assert.equal(
      isExactTrustedAppSender(mainWebContents, mainFrame, mainWebContents, mainFrame),
      true,
    );
    assert.equal(
      isExactTrustedAppSender(websiteWebContents, mainFrame, mainWebContents, mainFrame),
      false,
    );
    assert.equal(
      isExactTrustedAppSender(mainWebContents, otherFrame, mainWebContents, mainFrame),
      false,
    );
    assert.equal(
      isExactTrustedAppSender(mainWebContents, null, mainWebContents, mainFrame),
      false,
    );
    assert.equal(
      isExactTrustedAppSender(mainWebContents, mainFrame, mainWebContents, null),
      false,
    );
    assert.equal(
      isExactTrustedAppSender(mainWebContents, mainFrame, websiteWebContents, mainFrame),
      false,
    );
  });
});
