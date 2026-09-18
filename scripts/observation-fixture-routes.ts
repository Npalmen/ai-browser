import path from 'node:path';

export const OBSERVATION_FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'observation');
export const INTERACTION_FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'interaction');

const OBSERVATION_ROUTE_MAP: Record<string, { fileName: string; contentType: string }> = {
  '/': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/iframe.html': { fileName: 'iframe.html', contentType: 'text/html; charset=utf-8' },
  '/ai-readonly.html': { fileName: 'ai-readonly.html', contentType: 'text/html; charset=utf-8' },
};

const INTERACTION_ROUTE_MAP: Record<string, { fileName: string; contentType: string }> = {
  '/interaction/safe-interact.html': {
    fileName: 'safe-interact.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/policy-deny.html': {
    fileName: 'policy-deny.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/sensitive-fields.html': {
    fileName: 'sensitive-fields.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/stale-target.html': {
    fileName: 'stale-target.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/prompt-injection.html': {
    fileName: 'prompt-injection.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/frame-parent.html': {
    fileName: 'frame-parent.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/frame-child.html': {
    fileName: 'frame-child.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/cross-origin-parent.html': {
    fileName: 'cross-origin-parent.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/interaction/select-exact-target.html': {
    fileName: 'select-exact-target.html',
    contentType: 'text/html; charset=utf-8',
  },
};

export interface ResolvedFixtureFile {
  absolutePath: string;
  contentType: string;
}

function resolveMappedFixtureRoute(
  requestPath: string,
  baseDir: string,
  routeMap: Record<string, { fileName: string; contentType: string }>,
): ResolvedFixtureFile | null {
  const normalizedPath = decodeURIComponent(requestPath.split('?')[0] ?? '/');
  if (normalizedPath.includes('..')) {
    return null;
  }

  const route = routeMap[normalizedPath];
  if (!route) {
    return null;
  }

  const absolutePath = path.resolve(baseDir, route.fileName);
  if (!absolutePath.startsWith(baseDir)) {
    return null;
  }

  return {
    absolutePath,
    contentType: route.contentType,
  };
}

export function resolveObservationFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  return resolveMappedFixtureRoute(requestPath, OBSERVATION_FIXTURE_DIR, OBSERVATION_ROUTE_MAP);
}

export function resolveInteractionFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  return resolveMappedFixtureRoute(requestPath, INTERACTION_FIXTURE_DIR, INTERACTION_ROUTE_MAP);
}

export function resolveFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  return (
    resolveObservationFixtureRoute(requestPath) ?? resolveInteractionFixtureRoute(requestPath)
  );
}
