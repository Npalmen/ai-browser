import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ModelError } from '../ai/model-errors';
import { ObservationError } from '../shared/observation-types';
import { aiSafeError, toAiSafeError } from './ai-safe-error';

const SECRET = 'provider-secret-body-DO-NOT-LEAK';

describe('toAiSafeError', () => {
  it('maps known model and observation codes to fixed messages', () => {
    assert.deepEqual(toAiSafeError(new ModelError('MODEL_NOT_CONFIGURED', SECRET)), {
      code: 'MODEL_NOT_CONFIGURED',
      message: 'AI is not configured.',
    });
    assert.deepEqual(toAiSafeError(new ModelError('MODEL_TIMEOUT', SECRET)), {
      code: 'MODEL_TIMEOUT',
      message: 'The AI request timed out.',
    });
    assert.deepEqual(
      toAiSafeError(new ObservationError('CDP_UNAVAILABLE', SECRET)),
      aiSafeError('CDP_UNAVAILABLE'),
    );
    assert.deepEqual(
      toAiSafeError(new ObservationError('PAGE_CHANGED_DURING_OBSERVATION', SECRET)),
      aiSafeError('PAGE_CHANGED_DURING_OBSERVATION'),
    );
  });

  it('maps unknown failures to AI_REQUEST_FAILED', () => {
    assert.deepEqual(toAiSafeError(new Error(SECRET)), aiSafeError('AI_REQUEST_FAILED'));
  });

  it('never serializes secret error causes or messages', () => {
    const error = new ModelError('MODEL_UNAVAILABLE', `wrapper ${SECRET}`, {
      cause: { body: SECRET, stack: SECRET },
    });
    const safe = toAiSafeError(error);
    const serialized = JSON.stringify(safe);
    assert.equal(serialized.includes(SECRET), false);
    assert.equal(serialized.includes('stack'), false);
  });
});
