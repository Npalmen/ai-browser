import path from 'node:path';

export const OBSERVATION_FIXTURE_DIR = path.resolve(__dirname, '..', 'fixtures', 'observation');

const ROUTE_MAP: Record<string, { fileName: string; contentType: string }> = {
  '/': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/iframe.html': { fileName: 'iframe.html', contentType: 'text/html; charset=utf-8' },
};

export interface ResolvedFixtureFile {
  absolutePath: string;
  contentType: string;
}

export function resolveObservationFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  const normalizedPath = decodeURIComponent(requestPath.split('?')[0] ?? '/');
  if (normalizedPath.includes('..')) {
    return null;
  }

  const route = ROUTE_MAP[normalizedPath];
  if (!route) {
    return null;
  }

  const absolutePath = path.resolve(OBSERVATION_FIXTURE_DIR, route.fileName);
  if (!absolutePath.startsWith(OBSERVATION_FIXTURE_DIR)) {
    return null;
  }

  return {
    absolutePath,
    contentType: route.contentType,
  };
}
