import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { INTERACTION_SYSTEM_PROMPT } from './interaction-system-prompt';

describe('INTERACTION_SYSTEM_PROMPT precedence', () => {
  it('tells the model to treat trusted progress as current-task facts', () => {
    assert.match(INTERACTION_SYSTEM_PROMPT, /TRUSTED_RUN_PROGRESS/);
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /confirm completion instead of searching the destination page/,
    );
    assert.match(INTERACTION_SYSTEM_PROMPT, /continue using the current page/);
  });

  it('tells the model that prior conversation is not current browser state', () => {
    assert.match(INTERACTION_SYSTEM_PROMPT, /PRIOR_CONVERSATION/);
    assert.match(INTERACTION_SYSTEM_PROMPT, /not evidence of current browser state/);
    assert.match(
      INTERACTION_SYSTEM_PROMPT,
      /repeated imperative is a fresh request unless current-run trusted progress/,
    );
    assert.match(INTERACTION_SYSTEM_PROMPT, /current page observation is the current browser state/);
  });
});
