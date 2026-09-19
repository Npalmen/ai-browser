import { MAX_SEARCH_QUERY_CHARS } from '../shared/ai-native-types';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import { isAllowedWebsiteNavigation } from '../shared/navigation-url';

export interface BrowserSearchProvider {
  readonly id: string;
  buildSearchUrl(query: string): string;
}

export class DuckDuckGoHtmlSearchProvider implements BrowserSearchProvider {
  readonly id = 'duckduckgo-html';

  buildSearchUrl(query: string): string {
    return `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
  }
}

export const DEFAULT_BROWSER_SEARCH_PROVIDER: BrowserSearchProvider =
  new DuckDuckGoHtmlSearchProvider();

export function normalizeSearchQuery(
  value: unknown,
): { ok: true; query: string } | { ok: false; error: ReturnType<typeof aiNativeSafeError> } {
  if (typeof value !== 'string') {
    return { ok: false, error: aiNativeSafeError('AI_NATIVE_INVALID_REQUEST') };
  }

  const query = value.trim();
  if (!query) {
    return { ok: false, error: aiNativeSafeError('AI_NATIVE_EMPTY_INPUT') };
  }

  if (query.length > MAX_SEARCH_QUERY_CHARS) {
    return { ok: false, error: aiNativeSafeError('AI_NATIVE_SEARCH_INVALID') };
  }

  return { ok: true, query };
}

export function buildTrustedSearchNavigationUrl(
  query: unknown,
  provider: BrowserSearchProvider = DEFAULT_BROWSER_SEARCH_PROVIDER,
): { ok: true; url: string } | { ok: false; error: ReturnType<typeof aiNativeSafeError> } {
  const normalized = normalizeSearchQuery(query);
  if (!normalized.ok) {
    return normalized;
  }

  const url = provider.buildSearchUrl(normalized.query);
  if (!isAllowedWebsiteNavigation(url)) {
    return { ok: false, error: aiNativeSafeError('AI_NATIVE_SEARCH_INVALID') };
  }

  return { ok: true, url };
}
