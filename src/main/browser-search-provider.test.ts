import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { MAX_SEARCH_QUERY_CHARS } from '../shared/ai-native-types';
import {
  DEFAULT_BROWSER_SEARCH_PROVIDER,
  DuckDuckGoHtmlSearchProvider,
  buildTrustedSearchNavigationUrl,
  normalizeSearchQuery,
} from './browser-search-provider';

const ROOT = path.resolve(__dirname, '..', '..');

describe('DuckDuckGoHtmlSearchProvider', () => {
  const provider = new DuckDuckGoHtmlSearchProvider();

  it('uses the locked provider id', () => {
    assert.equal(provider.id, 'duckduckgo-html');
    assert.equal(DEFAULT_BROWSER_SEARCH_PROVIDER.id, 'duckduckgo-html');
  });

  it('builds encoded search URLs', () => {
    const url = provider.buildSearchUrl('cats and dogs');
    assert.equal(url, 'https://duckduckgo.com/?q=cats%20and%20dogs');
    assert.match(url, /cats%20and%20dogs$/);
  });

  it('encodes reserved URL characters and Unicode', () => {
    assert.equal(provider.buildSearchUrl('a&b=c'), 'https://duckduckgo.com/?q=a%26b%3Dc');
    assert.equal(provider.buildSearchUrl('café'), 'https://duckduckgo.com/?q=caf%C3%A9');
  });
});

describe('normalizeSearchQuery', () => {
  it('accepts normal queries', () => {
    const result = normalizeSearchQuery('best laptops');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.query, 'best laptops');
    }
  });

  it('trims whitespace', () => {
    const result = normalizeSearchQuery('  cats  ');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.query, 'cats');
    }
  });

  it('rejects empty and whitespace-only queries', () => {
    assert.equal(normalizeSearchQuery('').ok, false);
    assert.equal(normalizeSearchQuery('   ').ok, false);
  });

  it('rejects queries longer than 512 characters', () => {
    assert.equal(normalizeSearchQuery('a'.repeat(512)).ok, true);
    const result = normalizeSearchQuery('a'.repeat(513));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_SEARCH_INVALID');
    }
  });

  it('rejects non-string input', () => {
    const result = normalizeSearchQuery(42);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, 'AI_NATIVE_INVALID_REQUEST');
    }
  });
});

describe('buildTrustedSearchNavigationUrl', () => {
  it('returns an allowed https URL containing the encoded query', () => {
    const result = buildTrustedSearchNavigationUrl('open source browser');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.url, 'https://duckduckgo.com/?q=open%20source%20browser');
      assert.match(result.url, /^https:\/\//);
    }
  });

  it('never constructs about: URLs', () => {
    const result = buildTrustedSearchNavigationUrl('cats');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.url.startsWith('about:'), false);
    }
  });
});

describe('browser-search-provider model boundary', () => {
  it('contains no model runtime imports', () => {
    const source = readFileSync(path.join(ROOT, 'src/main/browser-search-provider.ts'), 'utf8');
    for (const forbidden of [
      'ModelRuntime',
      'ModelRouter',
      'ReadOnlyAgent',
      'generateText',
      'streamText',
      'from "ai"',
      "from 'ai'",
    ]) {
      assert.equal(source.includes(forbidden), false, forbidden);
    }
  });
});
