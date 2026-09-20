import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatAgentLoopAnswerReceived,
  formatAgentLoopCompleteOnSuccessDeferred,
  formatAgentLoopCompleteOnSuccessHonored,
  formatAgentLoopFalseCompletionReplan,
  formatAgentLoopModelStepFailed,
  formatAgentLoopTrustedActionSuccess,
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

  it('formats agent-loop request failures with safe category, phase, and provider status', () => {
    const line = formatAgentLoopModelStepFailed({
      code: 'MODEL_REQUEST_FAILED',
      iteration: 3,
      postNavigation: false,
      alias: 'page-fast',
      fallbackAttempts: 1,
      category: 'provider-http',
      failurePhase: 'awaiting-structured',
      providerStatus: 502,
    });
    assert.equal(
      line,
      '[agent-loop] model-step-failed code=MODEL_REQUEST_FAILED iteration=3 postNavigation=false alias=page-fast fallbackAttempts=1 category=provider-http phase=awaiting-structured providerStatus=502',
    );
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

  it('formats false-completion diagnostics without page content', () => {
    assert.equal(
      formatAgentLoopAnswerReceived({
        disposition: 'task-complete',
        browserDispatches: 1,
        verifiedEffects: 0,
        navigations: 0,
        approvedExecutions: 0,
        latestSemanticFrontier: 'unverified',
        iteration: 1,
      }),
      '[agent-loop] answer-received disposition=task-complete browserDispatches=1 verifiedEffects=0 navigations=0 approvedExecutions=0 latestSemanticFrontier=unverified iteration=1',
    );
    assert.equal(
      formatAgentLoopFalseCompletionReplan(1),
      '[agent-loop] false-completion-replan iteration=1',
    );
    assert.equal(
      formatAgentLoopTrustedActionSuccess({
        kind: 'click',
        navigated: false,
        observableEffect: false,
      }),
      '[agent-loop] trusted-action-success kind=click navigated=false observableEffect=false',
    );
    assert.equal(
      formatAgentLoopCompleteOnSuccessHonored({
        kind: 'click',
        evidence: 'navigation',
      }),
      '[agent-loop] complete-on-success-honored kind=click evidence=navigation',
    );
    assert.equal(
      formatAgentLoopCompleteOnSuccessDeferred({
        kind: 'click',
        reason: 'no-observable-effect',
      }),
      '[agent-loop] complete-on-success-deferred kind=click reason=no-observable-effect',
    );
  });
});
