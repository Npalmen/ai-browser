import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatAgentLoopModelStepFailed,
  formatModelRequestFailed,
} from './model-diagnostics';

describe('model diagnostics formatting', () => {
  it('formats agent-loop model step failures with iteration and post-navigation context', () => {
    const line = formatAgentLoopModelStepFailed({
      code: 'MODEL_OUTPUT_INVALID',
      iteration: 2,
      postNavigation: true,
      alias: 'page-standard',
      fallbackAttempts: 1,
    });
    assert.equal(
      line,
      '[agent-loop] model-step-failed code=MODEL_OUTPUT_INVALID iteration=2 postNavigation=true alias=page-standard fallbackAttempts=1 category=unknown phase=unknown',
    );
  });

  it('keeps MODEL_TIMEOUT and MODEL_RATE_LIMITED distinguishable', () => {
    const timeout = formatAgentLoopModelStepFailed({
      code: 'MODEL_TIMEOUT',
      iteration: 1,
      postNavigation: false,
    });
    const rateLimited = formatAgentLoopModelStepFailed({
      code: 'MODEL_RATE_LIMITED',
      iteration: 1,
      postNavigation: false,
      alias: 'page-fast',
    });
    assert.match(timeout, /code=MODEL_TIMEOUT/);
    assert.match(rateLimited, /code=MODEL_RATE_LIMITED/);
    assert.notEqual(timeout, rateLimited);
  });

  it('does not include prompt, page, or API-key shaped content in diagnostic output', () => {
    const line = formatAgentLoopModelStepFailed({
      code: 'MODEL_OUTPUT_INVALID',
      iteration: 1,
      postNavigation: false,
      alias: 'page-standard',
    });
    assert.doesNotMatch(line, /sk-[A-Za-z0-9]+/);
    assert.doesNotMatch(line, /target-/i);
    assert.doesNotMatch(line, /prompt/i);
    assert.doesNotMatch(line, /duckduckgo/i);
  });

  it('formats gateway request failures with alias, normalized code, and safe runtime category', () => {
    const line = formatModelRequestFailed({
      alias: 'page-standard',
      code: 'MODEL_REQUEST_FAILED',
      category: 'provider-http',
      failurePhase: 'awaiting-structured',
      providerStatus: 502,
    });
    assert.equal(
      line,
      '[model] request-failed alias=page-standard code=MODEL_REQUEST_FAILED category=provider-http phase=awaiting-structured providerStatus=502',
    );
  });

  it('omits unsafe provider status values and does not leak request content', () => {
    const line = formatModelRequestFailed({
      alias: 'page-standard',
      code: 'MODEL_REQUEST_FAILED',
      category: 'unknown',
      failurePhase: 'before-stream',
      providerStatus: 12,
    });
    assert.equal(
      line,
      '[model] request-failed alias=page-standard code=MODEL_REQUEST_FAILED category=unknown phase=before-stream',
    );
    assert.doesNotMatch(line, /sk-[A-Za-z0-9]+/);
    assert.doesNotMatch(line, /target-/i);
    assert.doesNotMatch(line, /prompt/i);
  });
});
