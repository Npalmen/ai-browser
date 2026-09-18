import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fingerprintAction, type ActionFingerprintInput } from './action-fingerprint';

describe('action fingerprint', () => {
  it('is deterministic for equivalent explicit fields and ignores object key order', () => {
    const first = fingerprintAction({
      kind: 'click',
      documentRevision: 'rev-1',
      targetId: 'target-a',
    });
    const second = fingerprintAction({
      targetId: 'target-a',
      documentRevision: 'rev-1',
      kind: 'click',
    });
    assert.equal(first, second);
    assert.match(first, /^[a-f0-9]{64}$/);
  });

  it('differs when click target, type text, select option, scroll amount, or revision change', () => {
    const clickA = fingerprintAction({ kind: 'click', documentRevision: 'rev-1', targetId: 'target-a' });
    const clickB = fingerprintAction({ kind: 'click', documentRevision: 'rev-1', targetId: 'target-b' });
    const clickRev = fingerprintAction({ kind: 'click', documentRevision: 'rev-2', targetId: 'target-a' });
    assert.notEqual(clickA, clickB);
    assert.notEqual(clickA, clickRev);

    const typeShort = fingerprintAction({
      kind: 'type',
      documentRevision: 'rev-1',
      targetId: 'target-a',
      text: 'abc',
    });
    const typeLong = fingerprintAction({
      kind: 'type',
      documentRevision: 'rev-1',
      targetId: 'target-a',
      text: 'abcd',
    });
    assert.notEqual(typeShort, typeLong);

    const selectOne = fingerprintAction({
      kind: 'select',
      documentRevision: 'rev-1',
      targetId: 'target-a',
      optionTargetId: 'option-1',
    });
    const selectTwo = fingerprintAction({
      kind: 'select',
      documentRevision: 'rev-1',
      targetId: 'target-a',
      optionTargetId: 'option-2',
    });
    assert.notEqual(selectOne, selectTwo);

    const scroll100 = fingerprintAction({
      kind: 'scroll',
      mode: 'viewport',
      documentRevision: 'rev-1',
      direction: 'down',
      amountPx: 100,
    });
    const scroll200 = fingerprintAction({
      kind: 'scroll',
      mode: 'viewport',
      documentRevision: 'rev-1',
      direction: 'down',
      amountPx: 200,
    });
    assert.notEqual(scroll100, scroll200);

    const intoView = fingerprintAction({
      kind: 'scroll',
      mode: 'into-view',
      documentRevision: 'rev-1',
      targetId: 'target-a',
    });
    assert.notEqual(intoView, clickA);
  });

  it('does not expose the canonical source or typed payload in the digest', () => {
    const secret = 'typed-secret-payload';
    const input: ActionFingerprintInput = {
      kind: 'type',
      documentRevision: 'rev-1',
      targetId: 'target-a',
      text: secret,
    };
    const digest = fingerprintAction(input);
    assert.equal(digest.includes(secret), false);
    assert.equal(digest.includes('type'), false);
    assert.equal(digest.includes('target-a'), false);
    assert.equal(digest.includes('rev-1'), false);
  });
});
