import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAllowedWebsiteNavigation,
  normalizeNavigationUrl,
} from './navigation-url';

describe('normalizeNavigationUrl', () => {
  it('allows explicit https URLs', () => {
    const result = normalizeNavigationUrl('https://example.com');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.url, 'https://example.com/');
    }
  });

  it('allows explicit http URLs with path', () => {
    const result = normalizeNavigationUrl('http://example.com/path');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.url, 'http://example.com/path');
    }
  });

  it('prefixes bare hostnames with https', () => {
    const result = normalizeNavigationUrl('example.com');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.url, 'https://example.com/');
    }
  });

  it('allows localhost and localhost with port', () => {
    assert.deepEqual(normalizeNavigationUrl('localhost'), {
      ok: true,
      url: 'https://localhost/',
    });
    assert.deepEqual(normalizeNavigationUrl('localhost:3000'), {
      ok: true,
      url: 'https://localhost:3000/',
    });
  });

  it('allows about:blank', () => {
    const result = normalizeNavigationUrl('about:blank');
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.url, 'about:blank');
    }
  });

  it('rejects empty input', () => {
    const result = normalizeNavigationUrl('   ');
    assert.equal(result.ok, false);
  });

  it('rejects search-like text', () => {
    const result = normalizeNavigationUrl('cats');
    assert.equal(result.ok, false);
  });

  it('rejects strings with spaces', () => {
    const result = normalizeNavigationUrl('example search');
    assert.equal(result.ok, false);
  });

  it('rejects unsupported protocols', () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,hello',
      'blob:https://example.com/uuid',
      'chrome://settings',
      'chrome-extension://abc/page.html',
    ]) {
      const result = normalizeNavigationUrl(url);
      assert.equal(result.ok, false, `expected reject for ${url}`);
    }
  });

  it('rejects malformed URLs', () => {
    const result = normalizeNavigationUrl('https://');
    assert.equal(result.ok, false);
  });
});

describe('isAllowedWebsiteNavigation', () => {
  it('allows http, https, and about:blank', () => {
    assert.equal(isAllowedWebsiteNavigation('https://example.com'), true);
    assert.equal(isAllowedWebsiteNavigation('http://example.com'), true);
    assert.equal(isAllowedWebsiteNavigation('about:blank'), true);
  });

  it('denies unsupported schemes', () => {
    assert.equal(isAllowedWebsiteNavigation('file:///tmp/a'), false);
    assert.equal(isAllowedWebsiteNavigation('javascript:alert(1)'), false);
    assert.equal(isAllowedWebsiteNavigation('data:text/plain,hi'), false);
  });
});
