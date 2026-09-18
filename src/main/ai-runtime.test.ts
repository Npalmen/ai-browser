import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const ROOT = path.resolve(__dirname, '..', '..');

describe('ai-runtime composition', () => {
  it('uses the browser adapter target registry accessor instead of creating a new registry', () => {
    const source = readFileSync(path.join(ROOT, 'src/main/ai-runtime.ts'), 'utf8');
    assert.equal(source.includes('new TargetRegistry'), false);
    assert.match(source, /getInteractionTargetRegistry\(\)/);
    assert.match(source, /new InteractionExecutor\(/);
    assert.match(source, /new ReadOnlyAgent\(/);
    assert.match(source, /new InteractiveAgent\(/);
  });
});
