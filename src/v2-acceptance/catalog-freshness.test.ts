import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MODEL_CATALOG } from '../ai/model-catalog';
import { MODEL_ALIASES } from '../ai/model-types';

interface GatewayModel {
  id: string;
  context_window?: number;
  modalities?: { input?: string[] };
}

describe('V2 Gateway catalog freshness', () => {
  it('confirms every catalog slug still exists with a compatible context window', async () => {
    const response = await fetch('https://ai-gateway.vercel.sh/v1/models');
    assert.equal(response.ok, true, `Gateway model list HTTP ${response.status}`);
    const body = (await response.json()) as { data?: GatewayModel[] };
    assert.ok(Array.isArray(body.data));
    const byId = new Map((body.data ?? []).map((model) => [model.id, model]));

    for (const alias of MODEL_ALIASES) {
      const profile = MODEL_CATALOG[alias].profile;
      const live = byId.get(profile.providerModelId);
      assert.ok(live, `${alias} slug ${profile.providerModelId} missing from live Gateway list`);
      assert.equal(typeof live.context_window, 'number');
      assert.ok(
        (live.context_window ?? 0) >= profile.contextWindowTokens,
        `${alias} live context_window ${live.context_window} is smaller than catalog ${profile.contextWindowTokens}`,
      );
      if (alias === 'page-vision') {
        assert.equal(live.modalities?.input?.includes('image'), true);
      }
    }
  });
});
