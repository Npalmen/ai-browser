import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { containsSensitiveValueLiteral, isSecretCandidate, redactCandidateValue } from './redaction';

describe('redaction', () => {
  it('treats password inputs as secret', () => {
    assert.equal(
      isSecretCandidate({
        tag: 'input',
        attributes: { type: 'password' },
      }),
      true,
    );
  });

  it('treats sensitive autocomplete values as secret', () => {
    assert.equal(
      isSecretCandidate({
        tag: 'input',
        attributes: { autocomplete: 'cc-number' },
      }),
      true,
    );
    assert.equal(
      isSecretCandidate({
        tag: 'input',
        attributes: { autocomplete: 'cvv' },
      }),
      true,
    );
  });

  it('treats sensitive metadata patterns as secret', () => {
    assert.equal(
      isSecretCandidate({
        tag: 'input',
        attributes: { placeholder: 'Card number' },
      }),
      true,
    );
  });

  it('omits secret values and increments redaction metadata', () => {
    const result = redactCandidateValue({
      tag: 'input',
      attributes: { type: 'password' },
      value: 'hunter2',
    });

    assert.equal(result.secret, true);
    assert.equal(result.redacted, true);
    assert.equal(result.value, undefined);
  });

  it('detects sensitive numeric literals', () => {
    assert.equal(containsSensitiveValueLiteral('4111111111111111'), true);
    assert.equal(containsSensitiveValueLiteral('fixture@example.test'), false);
  });

  it('keeps normal email and text values', () => {
    const email = redactCandidateValue({
      tag: 'input',
      attributes: { type: 'email' },
      value: 'user@example.com',
    });
    const text = redactCandidateValue({
      tag: 'input',
      attributes: { type: 'text' },
      value: 'hello',
    });

    assert.equal(email.secret, false);
    assert.equal(email.value, 'user@example.com');
    assert.equal(text.secret, false);
    assert.equal(text.value, 'hello');
  });
});
