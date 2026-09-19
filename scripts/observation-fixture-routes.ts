import path from 'node:path';

export const OBSERVATION_FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'observation');
export const INTERACTION_FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'interaction');
export const APPROVAL_FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'approval');
export const AGENT_RUN_FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'agent-run');
export const AUTONOMOUS_TASK_FIXTURE_DIR = path.resolve(process.cwd(), 'fixtures', 'autonomous-task');

const OBSERVATION_ROUTE_MAP: Record<string, { fileName: string; contentType: string }> = {
  '/': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/iframe.html': { fileName: 'iframe.html', contentType: 'text/html; charset=utf-8' },
  '/ai-readonly.html': { fileName: 'ai-readonly.html', contentType: 'text/html; charset=utf-8' },
  '/v8-hostile-ask.html': { fileName: 'v8-hostile-ask.html', contentType: 'text/html; charset=utf-8' },
  '/v8-hostile-workflow.html': { fileName: 'v8-hostile-workflow.html', contentType: 'text/html; charset=utf-8' },
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

const AGENT_RUN_ROUTE_MAP: Record<string, { fileName: string; contentType: string }> = {
  '/agent-run/two-safe.html': {
    fileName: 'two-safe.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/agent-run/safe-navigation-a.html': {
    fileName: 'safe-navigation-a.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/agent-run/safe-navigation-b.html': {
    fileName: 'safe-navigation-b.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/agent-run/multi-step.html': {
    fileName: 'multi-step.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/agent-run/prompt-injection.html': {
    fileName: 'prompt-injection.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/agent-run/repeat-safe.html': {
    fileName: 'repeat-safe.html',
    contentType: 'text/html; charset=utf-8',
  },
};

const APPROVAL_ROUTE_MAP: Record<string, { fileName: string; contentType: string }> = {
  '/approval/consequential.html': {
    fileName: 'consequential.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/approval/prompt-injection.html': {
    fileName: 'prompt-injection.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/approval/replace-target.html': {
    fileName: 'replace-target.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/approval/navigate-action.html': {
    fileName: 'navigate-action.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/approval/after-purchase.html': {
    fileName: 'after-purchase.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/approval/consequential-select.html': {
    fileName: 'consequential-select.html',
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

export function resolveApprovalFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  return resolveMappedFixtureRoute(requestPath, APPROVAL_FIXTURE_DIR, APPROVAL_ROUTE_MAP);
}

export function resolveAgentRunFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  return resolveMappedFixtureRoute(requestPath, AGENT_RUN_FIXTURE_DIR, AGENT_RUN_ROUTE_MAP);
}

const AUTONOMOUS_TASK_ROUTE_MAP: Record<string, { fileName: string; contentType: string }> = {
  '/autonomous-task/popup-click.html': {
    fileName: 'popup-click.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/autonomous-task/popup-child.html': {
    fileName: 'popup-child.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/autonomous-task/delayed-popup.html': {
    fileName: 'delayed-popup.html',
    contentType: 'text/html; charset=utf-8',
  },
  '/autonomous-task/background.html': {
    fileName: 'background.html',
    contentType: 'text/html; charset=utf-8',
  },
};

export function resolveAutonomousTaskFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  return resolveMappedFixtureRoute(requestPath, AUTONOMOUS_TASK_FIXTURE_DIR, AUTONOMOUS_TASK_ROUTE_MAP);
}

export function resolveFixtureRoute(requestPath: string): ResolvedFixtureFile | null {
  return (
    resolveObservationFixtureRoute(requestPath) ??
    resolveInteractionFixtureRoute(requestPath) ??
    resolveApprovalFixtureRoute(requestPath) ??
    resolveAgentRunFixtureRoute(requestPath) ??
    resolveAutonomousTaskFixtureRoute(requestPath)
  );
}
