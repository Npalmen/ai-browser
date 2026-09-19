import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createMainRules, createRendererRules } from './webpack.rules';

const ROOT = path.resolve(__dirname);

function ruleText(rules: unknown): string {
  return JSON.stringify(rules);
}

describe('webpack target-specific rules', () => {
  it('keeps native-module relocation on the main process only', () => {
    const main = ruleText(createMainRules());
    assert.match(main, /@vercel\/webpack-asset-relocator-loader/);
    assert.match(main, /node-loader/);
    assert.match(main, /native_modules/);
  });

  it('keeps renderer and preload rules free of native relocation runtime', () => {
    const renderer = ruleText(createRendererRules());
    assert.equal(renderer.includes('@vercel/webpack-asset-relocator-loader'), false);
    assert.equal(renderer.includes('node-loader'), false);
    assert.equal(renderer.includes('native_modules'), false);
    assert.match(renderer, /ts-loader/);
    assert.match(renderer, /css-loader/);
  });

  it('does not share or mutate one exported rules array between targets', () => {
    const mainConfig = readFileSync(path.join(ROOT, 'webpack.main.config.ts'), 'utf8');
    const rendererConfig = readFileSync(path.join(ROOT, 'webpack.renderer.config.ts'), 'utf8');
    const rulesModule = readFileSync(path.join(ROOT, 'webpack.rules.ts'), 'utf8');

    assert.match(mainConfig, /createMainRules\(\)/);
    assert.match(rendererConfig, /createRendererRules\(\)/);
    assert.equal(mainConfig.includes('rules.push'), false);
    assert.equal(rendererConfig.includes('rules.push'), false);
    assert.equal(rulesModule.includes('export const rules'), false);
  });
});

describe('webpack bundle invariants', () => {
  it('rejects renderer bundles that require __dirname for native_modules relocation', () => {
    const rendererBundle = path.join(ROOT, '.webpack', 'renderer', 'main_window', 'index.js');
    try {
      const source = readFileSync(rendererBundle, 'utf8');
      assert.equal(
        source.includes('__dirname+"/native_modules/"') ||
          source.includes('__dirname + "/native_modules/"'),
        false,
        'renderer bundle must not contain native relocation runtime',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  });

  it('rejects preload bundles that require __dirname for native_modules relocation', () => {
    const preloadBundle = path.join(ROOT, '.webpack', 'renderer', 'main_window', 'preload.js');
    try {
      const source = readFileSync(preloadBundle, 'utf8');
      assert.equal(
        source.includes('__dirname+"/native_modules/"') ||
          source.includes('__dirname + "/native_modules/"'),
        false,
        'preload bundle must not contain native relocation runtime',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
  });
});
