import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  OBSERVATION_FIXTURE_DIR,
  resolveObservationFixtureRoute,
} from './observation-fixture-routes';

describe('resolveObservationFixtureRoute', () => {
  it('maps known fixture routes to files under the fixture directory', () => {
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

  it('rejects unknown and traversal paths', () => {
    assert.equal(resolveObservationFixtureRoute('/unknown'), null);
    assert.equal(resolveObservationFixtureRoute('/../../package.json'), null);
    assert.equal(resolveObservationFixtureRoute('/../package.json'), null);
  });
});
