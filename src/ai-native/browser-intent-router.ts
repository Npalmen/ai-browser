import {
  MAX_BROWSER_INTENT_TEXT_CHARS,
  MAX_CONTEXT_TABS,
  MAX_SEARCH_QUERY_CHARS,
  type BrowserContextScope,
  type BrowserIntentRoute,
  type BrowserIntentRouteRequest,
  type BrowserIntentRouteResult,
  type BrowserIntentRouterState,
} from '../shared/ai-native-types';
import { aiNativeSafeError } from '../shared/ai-native-safe-error';
import {
  isExplicitlyDeniedNavigationInput,
  normalizeNavigationUrl,
} from '../shared/navigation-url';
import type { BrowserTab, TabId } from '../shared/browser-types';

function fail(code: Parameters<typeof aiNativeSafeError>[0]): BrowserIntentRouteResult {
  return { ok: false, error: aiNativeSafeError(code) };
}

function ok(route: BrowserIntentRoute): BrowserIntentRouteResult {
  return { ok: true, route };
}

function trimText(text: string): string {
  return text.trim();
}

function isHttpDocumentUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function findTab(browserState: BrowserIntentRouterState, tabId: TabId): BrowserTab | undefined {
  return browserState.tabs.find((tab) => tab.id === tabId);
}

function enforceCapabilityContextContract(
  input: BrowserIntentRouteRequest,
): BrowserIntentRouteResult | null {
  const hasContext = input.context !== undefined;

  if (input.capability === 'ask' || input.capability === 'automate') {
    if (!hasContext) {
      return fail('AI_NATIVE_CONTEXT_INVALID');
    }
    return null;
  }

  if (hasContext) {
    return fail('AI_NATIVE_INVALID_REQUEST');
  }

  return null;
}

function resolveNavigateOrSearch(text: string): BrowserIntentRouteResult {
  const trimmed = trimText(text);
  if (!trimmed) {
    return fail('AI_NATIVE_EMPTY_INPUT');
  }

  if (trimmed.length > MAX_BROWSER_INTENT_TEXT_CHARS) {
    return fail('AI_NATIVE_INVALID_REQUEST');
  }

  if (isExplicitlyDeniedNavigationInput(trimmed)) {
    return fail('AI_NATIVE_SEARCH_INVALID');
  }

  const normalized = normalizeNavigationUrl(trimmed);
  if (normalized.ok) {
    return ok({ kind: 'navigate', url: normalized.url });
  }

  if (trimmed.length > MAX_SEARCH_QUERY_CHARS) {
    return fail('AI_NATIVE_SEARCH_INVALID');
  }

  return ok({ kind: 'search', query: trimmed });
}

function validateIntentText(text: string): string | BrowserIntentRouteResult {
  const trimmed = trimText(text);
  if (!trimmed) {
    return fail('AI_NATIVE_EMPTY_INPUT');
  }
  if (trimmed.length > MAX_BROWSER_INTENT_TEXT_CHARS) {
    return fail('AI_NATIVE_INVALID_REQUEST');
  }
  return trimmed;
}

function validateContext(
  browserState: BrowserIntentRouterState,
  context: BrowserContextScope,
  options: { requireHttpTabs: boolean },
): BrowserContextScope | BrowserIntentRouteResult {
  if (context.kind === 'current-tab') {
    if (typeof context.tabId !== 'string' || context.tabId.length === 0) {
      return fail('AI_NATIVE_CONTEXT_INVALID');
    }
    if (browserState.activeTabId !== context.tabId) {
      return fail('AI_NATIVE_CONTEXT_INVALID');
    }
    const tab = findTab(browserState, context.tabId);
    if (!tab) {
      return fail('AI_NATIVE_TAB_UNAVAILABLE');
    }
    if (options.requireHttpTabs && !isHttpDocumentUrl(tab.url)) {
      return fail('AI_NATIVE_CONTEXT_INVALID');
    }
    return context;
  }

  if (!Array.isArray(context.tabIds)) {
    return fail('AI_NATIVE_CONTEXT_INVALID');
  }

  if (context.tabIds.length === 0 || context.tabIds.length > MAX_CONTEXT_TABS) {
    return fail('AI_NATIVE_CONTEXT_INVALID');
  }

  const seen = new Set<TabId>();
  for (const tabId of context.tabIds) {
    if (typeof tabId !== 'string' || tabId.length === 0) {
      return fail('AI_NATIVE_CONTEXT_INVALID');
    }
    if (seen.has(tabId)) {
      return fail('AI_NATIVE_CONTEXT_INVALID');
    }
    seen.add(tabId);
    const tab = findTab(browserState, tabId);
    if (!tab) {
      return fail('AI_NATIVE_TAB_UNAVAILABLE');
    }
    if (options.requireHttpTabs && !isHttpDocumentUrl(tab.url)) {
      return fail('AI_NATIVE_CONTEXT_INVALID');
    }
  }

  return context;
}

function routeAsk(
  input: BrowserIntentRouteRequest,
  browserState: BrowserIntentRouterState,
): BrowserIntentRouteResult {
  const question = validateIntentText(input.text);
  if (typeof question !== 'string') {
    return question;
  }

  if (!input.context) {
    return fail('AI_NATIVE_CONTEXT_INVALID');
  }

  const context = validateContext(browserState, input.context, { requireHttpTabs: true });
  if (typeof context !== 'object' || !('kind' in context)) {
    return context;
  }

  return ok({ kind: 'ask', question, context });
}

function routeAct(
  input: BrowserIntentRouteRequest,
  browserState: BrowserIntentRouterState,
): BrowserIntentRouteResult {
  const instruction = validateIntentText(input.text);
  if (typeof instruction !== 'string') {
    return instruction;
  }

  const activeTabId = browserState.activeTabId;
  if (!activeTabId) {
    return fail('AI_NATIVE_TAB_UNAVAILABLE');
  }

  const activeTab = findTab(browserState, activeTabId);
  if (!activeTab) {
    return fail('AI_NATIVE_TAB_UNAVAILABLE');
  }

  if (activeTab.url === 'about:blank' || !isHttpDocumentUrl(activeTab.url)) {
    return fail('AI_NATIVE_TAB_UNAVAILABLE');
  }

  return ok({ kind: 'act', instruction, tabId: activeTabId });
}

function routeDelegate(input: BrowserIntentRouteRequest): BrowserIntentRouteResult {
  const objective = validateIntentText(input.text);
  if (typeof objective !== 'string') {
    return objective;
  }

  return ok({ kind: 'delegate', objective });
}

function routeAutomate(
  input: BrowserIntentRouteRequest,
  browserState: BrowserIntentRouterState,
): BrowserIntentRouteResult {
  const instruction = validateIntentText(input.text);
  if (typeof instruction !== 'string') {
    return instruction;
  }

  if (!input.context) {
    return fail('AI_NATIVE_CONTEXT_INVALID');
  }

  const context = validateContext(browserState, input.context, { requireHttpTabs: false });
  if (typeof context !== 'object' || !('kind' in context)) {
    return context;
  }

  return ok({ kind: 'draft-workflow', instruction, context });
}

export function routeBrowserIntent(
  input: BrowserIntentRouteRequest,
  browserState: BrowserIntentRouterState,
): BrowserIntentRouteResult {
  const contractViolation = enforceCapabilityContextContract(input);
  if (contractViolation) {
    return contractViolation;
  }

  switch (input.capability) {
    case 'default':
    case 'search':
      return resolveNavigateOrSearch(input.text);
    case 'ask':
      return routeAsk(input, browserState);
    case 'act':
      return routeAct(input, browserState);
    case 'delegate':
      return routeDelegate(input);
    case 'automate':
      return routeAutomate(input, browserState);
    default:
      return fail('AI_NATIVE_INVALID_REQUEST');
  }
}
