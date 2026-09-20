import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  AGENT_RUN_FIXTURE_DIR,
  APPROVAL_FIXTURE_DIR,
  INTERACTION_FIXTURE_DIR,
  OBSERVATION_FIXTURE_DIR,
  AUTONOMOUS_TASK_FIXTURE_DIR,
  resolveAgentRunFixtureRoute,
  resolveApprovalFixtureRoute,
  resolveAutonomousTaskFixtureRoute,
  resolveFixtureRoute,
  resolveInteractionFixtureRoute,
  resolveObservationFixtureRoute,
} from './observation-fixture-routes';

describe('resolveObservationFixtureRoute', () => {
  it('maps known observation fixture routes to files under the fixture directory', () => {
    const index = resolveObservationFixtureRoute('/');
    assert.ok(index);
    assert.equal(index.absolutePath, path.join(OBSERVATION_FIXTURE_DIR, 'index.html'));
    assert.equal(index.contentType, 'text/html; charset=utf-8');

    const iframe = resolveObservationFixtureRoute('/iframe.html');
    assert.ok(iframe);
    assert.equal(iframe.absolutePath, path.join(OBSERVATION_FIXTURE_DIR, 'iframe.html'));

    const aiReadonly = resolveObservationFixtureRoute('/ai-readonly.html');
    assert.ok(aiReadonly);
    assert.equal(aiReadonly.absolutePath, path.join(OBSERVATION_FIXTURE_DIR, 'ai-readonly.html'));
    assert.equal(aiReadonly.contentType, 'text/html; charset=utf-8');

    const hostileAsk = resolveObservationFixtureRoute('/v8-hostile-ask.html');
    assert.ok(hostileAsk);
    assert.equal(hostileAsk.absolutePath, path.join(OBSERVATION_FIXTURE_DIR, 'v8-hostile-ask.html'));
    const hostileWorkflow = resolveObservationFixtureRoute('/v8-hostile-workflow.html');
    assert.ok(hostileWorkflow);
    assert.equal(
      hostileWorkflow.absolutePath,
      path.join(OBSERVATION_FIXTURE_DIR, 'v8-hostile-workflow.html'),
    );
  });

  it('rejects unknown and traversal paths for observation routes', () => {
    assert.equal(resolveObservationFixtureRoute('/unknown'), null);
    assert.equal(resolveObservationFixtureRoute('/../../package.json'), null);
    assert.equal(resolveObservationFixtureRoute('/../package.json'), null);
  });
});

describe('resolveInteractionFixtureRoute', () => {
  it('maps known interaction fixture routes to files under the interaction directory', () => {
    const safe = resolveInteractionFixtureRoute('/interaction/safe-interact.html');
    assert.ok(safe);
    assert.equal(safe.absolutePath, path.join(INTERACTION_FIXTURE_DIR, 'safe-interact.html'));

    const policy = resolveInteractionFixtureRoute('/interaction/policy-deny.html');
    assert.ok(policy);
    assert.equal(policy.absolutePath, path.join(INTERACTION_FIXTURE_DIR, 'policy-deny.html'));

    const sensitive = resolveInteractionFixtureRoute('/interaction/sensitive-fields.html');
    assert.ok(sensitive);
    assert.equal(
      sensitive.absolutePath,
      path.join(INTERACTION_FIXTURE_DIR, 'sensitive-fields.html'),
    );

    const stale = resolveInteractionFixtureRoute('/interaction/stale-target.html');
    assert.ok(stale);
    assert.equal(stale.absolutePath, path.join(INTERACTION_FIXTURE_DIR, 'stale-target.html'));

    const injection = resolveInteractionFixtureRoute('/interaction/prompt-injection.html');
    assert.ok(injection);
    assert.equal(
      injection.absolutePath,
      path.join(INTERACTION_FIXTURE_DIR, 'prompt-injection.html'),
    );

    const frameParent = resolveInteractionFixtureRoute('/interaction/frame-parent.html');
    assert.ok(frameParent);
    assert.equal(frameParent.absolutePath, path.join(INTERACTION_FIXTURE_DIR, 'frame-parent.html'));

    const frameChild = resolveInteractionFixtureRoute('/interaction/frame-child.html');
    assert.ok(frameChild);
    assert.equal(frameChild.absolutePath, path.join(INTERACTION_FIXTURE_DIR, 'frame-child.html'));

    const exactSelect = resolveInteractionFixtureRoute('/interaction/select-exact-target.html');
    assert.ok(exactSelect);
    assert.equal(
      exactSelect.absolutePath,
      path.join(INTERACTION_FIXTURE_DIR, 'select-exact-target.html'),
    );

    const delayedA = resolveInteractionFixtureRoute('/interaction/delayed-navigation-a.html');
    assert.ok(delayedA);
    assert.equal(
      delayedA.absolutePath,
      path.join(INTERACTION_FIXTURE_DIR, 'delayed-navigation-a.html'),
    );
    const delayedB = resolveInteractionFixtureRoute('/interaction/delayed-navigation-b.html');
    assert.ok(delayedB);
    const sameDocument = resolveInteractionFixtureRoute('/interaction/same-document.html');
    assert.ok(sameDocument);
    const popupSource = resolveInteractionFixtureRoute('/interaction/popup-source.html');
    assert.ok(popupSource);
  });

  it('rejects unknown and traversal paths for interaction routes', () => {
    assert.equal(resolveInteractionFixtureRoute('/interaction/unknown.html'), null);
    assert.equal(resolveInteractionFixtureRoute('/interaction/../../package.json'), null);
    assert.equal(resolveInteractionFixtureRoute('/interaction/%2e%2e/package.json'), null);
  });
});

describe('resolveApprovalFixtureRoute', () => {
  it('maps known approval fixture routes to files under the approval directory', () => {
    const consequential = resolveApprovalFixtureRoute('/approval/consequential.html');
    assert.ok(consequential);
    assert.equal(consequential.absolutePath, path.join(APPROVAL_FIXTURE_DIR, 'consequential.html'));

    const injection = resolveApprovalFixtureRoute('/approval/prompt-injection.html');
    assert.ok(injection);
    assert.equal(injection.absolutePath, path.join(APPROVAL_FIXTURE_DIR, 'prompt-injection.html'));

    const replace = resolveApprovalFixtureRoute('/approval/replace-target.html');
    assert.ok(replace);
    assert.equal(replace.absolutePath, path.join(APPROVAL_FIXTURE_DIR, 'replace-target.html'));
  });

  it('rejects unknown and traversal paths for approval routes', () => {
    assert.equal(resolveApprovalFixtureRoute('/approval/unknown.html'), null);
    assert.equal(resolveApprovalFixtureRoute('/approval/../../package.json'), null);
  });
});

describe('resolveAgentRunFixtureRoute', () => {
  it('maps known agent-run fixture routes to files under the agent-run directory', () => {
    const twoSafe = resolveAgentRunFixtureRoute('/agent-run/two-safe.html');
    assert.ok(twoSafe);
    assert.equal(twoSafe.absolutePath, path.join(AGENT_RUN_FIXTURE_DIR, 'two-safe.html'));

    const navA = resolveAgentRunFixtureRoute('/agent-run/safe-navigation-a.html');
    assert.ok(navA);
    assert.equal(navA.absolutePath, path.join(AGENT_RUN_FIXTURE_DIR, 'safe-navigation-a.html'));
  });

  it('rejects unknown and traversal paths for agent-run routes', () => {
    assert.equal(resolveAgentRunFixtureRoute('/agent-run/unknown.html'), null);
    assert.equal(resolveAgentRunFixtureRoute('/agent-run/../../package.json'), null);
  });
});

describe('resolveAutonomousTaskFixtureRoute', () => {
  it('maps known autonomous-task fixture routes to files under the fixture directory', () => {
    const popup = resolveAutonomousTaskFixtureRoute('/autonomous-task/popup-click.html');
    assert.ok(popup);
    assert.equal(popup.absolutePath, path.join(AUTONOMOUS_TASK_FIXTURE_DIR, 'popup-click.html'));
  });

  it('rejects unknown and traversal paths for autonomous-task routes', () => {
    assert.equal(resolveAutonomousTaskFixtureRoute('/autonomous-task/unknown.html'), null);
    assert.equal(resolveAutonomousTaskFixtureRoute('/autonomous-task/../../package.json'), null);
  });
});

describe('resolveFixtureRoute', () => {
  it('resolves observation, interaction, approval, and agent-run routes', () => {
    assert.ok(resolveFixtureRoute('/'));
    assert.ok(resolveFixtureRoute('/interaction/safe-interact.html'));
    assert.ok(resolveFixtureRoute('/approval/consequential.html'));
    assert.ok(resolveFixtureRoute('/agent-run/two-safe.html'));
    assert.ok(resolveFixtureRoute('/autonomous-task/popup-click.html'));
    assert.equal(resolveFixtureRoute('/not-a-fixture'), null);
  });
});
