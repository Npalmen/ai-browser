import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INTERACTION_SYSTEM_PROMPT,
  MAX_VIEWPORT_DISCOVERY_SCROLLS,
} from './interaction-system-prompt';

describe('INTERACTION_SYSTEM_PROMPT precedence', () => {
  it('tells the model to treat trusted progress as current-task facts', () => {
    assert.match(INTERACTION_SYSTEM_PROMPT, /TRUSTED_RUN_PROGRESS/);
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /immediately previous navigation step succeeded/,
    );
    assert.match(INTERACTION_SYSTEM_PROMPT, /confirm completion instead of searching/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /continue using the current page only for those remaining steps/);
  });

  it('defines bounded viewport discovery instead of premature not-found answers', () => {
    assert.equal(MAX_VIEWPORT_DISCOVERY_SCROLLS, 4);
    assert.match(INTERACTION_SYSTEM_PROMPT, /documentHeight/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /bounded viewport scroll/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /never reuse stale targetIds/);
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /truncated=true means the exported node list was shortened/,
    );
    assert.match(INTERACTION_SYSTEM_PROMPT, /continuation: "continue"/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /complete-on-success/);
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /Viewport and into-view scroll proposals must use continuation "continue"/,
    );
  });

  it('tells the model that prior user context is not current browser state', () => {
    assert.match(INTERACTION_SYSTEM_PROMPT, /PRIOR_USER_CONTEXT/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /not evidence of current browser state or completed actions/);
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /repeated imperative is a fresh request unless current-run trusted progress/,
    );
    assert.match(INTERACTION_SYSTEM_PROMPT, /current page observation is the current browser state/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /disposition must be informational/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /task-complete is not proof/);
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /Never use informational, cannot-complete, or needs-clarification to claim/,
    );
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /dispatched primitive without a verified observable effect is not completion evidence/,
    );
  });
});
