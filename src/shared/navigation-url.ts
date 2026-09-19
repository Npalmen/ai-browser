export type NormalizeUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const DENIED_PROTOCOLS = new Set([
  'file:',
  'javascript:',
  'data:',
  'blob:',
  'chrome:',
  'chrome-extension:',
]);

export function isExplicitlyDeniedNavigationInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  for (const protocol of DENIED_PROTOCOLS) {
    if (lower.startsWith(protocol)) {
      return true;
    }
  }

  return false;
}

function isBareHostname(input: string): boolean {
  if (input.includes(' ')) {
    return false;
  }

  if (input === 'localhost' || input.startsWith('localhost:')) {
    return true;
  }

  return input.includes('.');
}

function tryParseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function isAllowedWebsiteNavigation(url: string): boolean {
  const parsed = tryParseUrl(url);
  if (!parsed) {
    return false;
  }

  if (parsed.protocol === 'about:' && parsed.href === 'about:blank') {
    return true;
  }

  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export function normalizeNavigationUrl(input: string): NormalizeUrlResult {
  const trimmed = input.trim();

  if (!trimmed) {
    return { ok: false, reason: 'URL is empty' };
  }

  if (trimmed.includes(' ')) {
    return { ok: false, reason: 'URL contains spaces' };
  }

  const lower = trimmed.toLowerCase();
  for (const protocol of DENIED_PROTOCOLS) {
    if (lower.startsWith(protocol)) {
      return { ok: false, reason: `Unsupported protocol: ${protocol}` };
    }
  }

  if (trimmed === 'about:blank') {
    return { ok: true, url: 'about:blank' };
  }

  if (lower.startsWith('about:')) {
    return { ok: false, reason: 'Unsupported about: URL' };
  }

  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    const explicit = tryParseUrl(trimmed);
    if (!explicit || (explicit.protocol !== 'http:' && explicit.protocol !== 'https:')) {
      return { ok: false, reason: 'Malformed URL' };
    }
    return { ok: true, url: explicit.toString() };
  }

  if (!isBareHostname(trimmed)) {
    return { ok: false, reason: 'Not a valid hostname or URL' };
  }

  const withScheme = tryParseUrl(`https://${trimmed}`);
  if (!withScheme || (withScheme.protocol !== 'http:' && withScheme.protocol !== 'https:')) {
    return { ok: false, reason: 'Malformed URL' };
  }

  return { ok: true, url: withScheme.toString() };
}
