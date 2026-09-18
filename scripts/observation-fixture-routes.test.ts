import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  INTERACTION_FIXTURE_DIR,
  OBSERVATION_FIXTURE_DIR,
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
  });

  it('rejects unknown and traversal paths for interaction routes', () => {
    assert.equal(resolveInteractionFixtureRoute('/interaction/unknown.html'), null);
    assert.equal(resolveInteractionFixtureRoute('/interaction/../../package.json'), null);
    assert.equal(resolveInteractionFixtureRoute('/interaction/%2e%2e/package.json'), null);
  });
});

describe('resolveFixtureRoute', () => {
  it('resolves both observation and interaction routes', () => {
    assert.ok(resolveFixtureRoute('/'));
    assert.ok(resolveFixtureRoute('/interaction/safe-interact.html'));
    assert.equal(resolveFixtureRoute('/not-a-fixture'), null);
  });
});
