import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createMainRules, createRendererRules } from './webpack.rules';

const ROOT = path.resolve(__dirname);

function ruleText(rules: unknown): string {
  return JSON.stringify(rules);
}

function countSubstringMatches(source: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function readOptionalBundle(bundlePath: string): string | null {
  try {
    return readFileSync(bundlePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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

  it('disables webpack-dev-server client/HMR injection for the shared renderer dev server', () => {
    const forgeConfig = readFileSync(path.join(ROOT, 'forge.config.ts'), 'utf8');
    assert.match(forgeConfig, /devServer:\s*\{/);
    assert.match(forgeConfig, /hot:\s*false/);
    assert.match(forgeConfig, /liveReload:\s*false/);
    assert.match(forgeConfig, /client:\s*false/);
  });

  it('keeps renderer devtool CSP-compatible with the trusted UI meta policy', () => {
    const rendererConfig = readFileSync(path.join(ROOT, 'webpack.renderer.config.ts'), 'utf8');
    assert.match(rendererConfig, /devtool:\s*'source-map'/);
    assert.equal(/devtool:\s*'eval-source-map'/.test(rendererConfig), false);
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
    const source = readOptionalBundle(preloadBundle);
    if (!source) {
      return;
    }
    assert.equal(
      source.includes('__dirname+"/native_modules/"') ||
        source.includes('__dirname + "/native_modules/"'),
      false,
      'preload bundle must not contain native relocation runtime',
    );
  });

  it('rejects sandboxed preload bundles contaminated by webpack-dev-server client/HMR runtime', () => {
    const preloadBundle = path.join(ROOT, '.webpack', 'renderer', 'main_window', 'preload.js');
    const source = readOptionalBundle(preloadBundle);
    if (!source) {
      return;
    }

    assert.equal(
      countSubstringMatches(source, 'webpack-dev-server/client'),
      0,
      'sandboxed preload must not include webpack-dev-server client runtime',
    );
    assert.equal(
      countSubstringMatches(source, 'webpack/hot'),
      0,
      'sandboxed preload must not include webpack HMR runtime',
    );
    assert.equal(
      source.includes('new Function('),
      false,
      'sandboxed preload must not include eval-based HMR helpers',
    );
    assert.equal(
      source.includes('__dirname'),
      false,
      'sandboxed preload must not include Node __dirname runtime',
    );
    assert.equal(
      source.includes('process.'),
      false,
      'sandboxed preload must not include process globals',
    );
    assert.equal(
      /require\("(?!electron")/.test(source) || /require\('(?!electron')/.test(source),
      false,
      'sandboxed preload must not require Node built-ins beyond electron',
    );
    assert.equal(
      source.includes('eval('),
      false,
      'sandboxed preload must not include eval-based devtool output',
    );
  });
});
