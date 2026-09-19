import {
  MAX_BROWSER_INTENT_TEXT_CHARS,
  MAX_CONTEXT_TABS,
  type BrowserIntentCapability,
  type BrowserIntentRouteInput,
} from '../shared/ai-native-types';
import type { BrowserTab } from '../shared/browser-types';

export const OMNIBOX_NAV_ERROR = 'Unable to open this address or search.';
export const OMNIBOX_PHASE_UNAVAILABLE = 'Available in next V8 phase.';
export const OMNIBOX_ASK_UNAVAILABLE = 'Ask is unavailable for this tab.';
export const OMNIBOX_ACT_UNAVAILABLE = 'Act is unavailable for this tab.';

export type OmniboxCapability = BrowserIntentCapability;

export type OmniboxContext =
  | {
      readonly kind: 'current-tab';
      readonly tabId: string;
    }
  | {
      readonly kind: 'selected-tabs';
      readonly tabIds: readonly string[];
    }
  | null;

export interface OmniboxUiState {
  readonly draft: string;
  readonly capability: OmniboxCapability;
  readonly context: OmniboxContext;
  readonly contextPickerOpen: boolean;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly phaseUnavailableMessage: string | null;
  readonly isEditing: boolean;
}

export function emptyOmniboxState(): OmniboxUiState {
  return {
    draft: '',
    capability: 'default',
    context: null,
    contextPickerOpen: false,
    submitting: false,
    error: null,
    phaseUnavailableMessage: null,
    isEditing: false,
  };
}

export function draftFromUrl(url: string): string {
  return url === 'about:blank' ? '' : url;
}

export function isHttpTabUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isAskAvailableForTab(tab: BrowserTab | null): boolean {
  return tab !== null && isHttpTabUrl(tab.url);
}

export function isActAvailableForTab(tab: BrowserTab | null): boolean {
  return isAskAvailableForTab(tab);
}

export function capabilityUsesContext(capability: OmniboxCapability): boolean {
  return capability === 'ask' || capability === 'automate';
}

export function defaultContextForCapability(
  capability: OmniboxCapability,
  activeTab: BrowserTab | null,
): OmniboxContext {
  if (!activeTab) {
    return null;
  }
  if (capability === 'ask' && !isAskAvailableForTab(activeTab)) {
    return null;
  }
  if (capability === 'ask' || capability === 'automate') {
    return { kind: 'current-tab', tabId: activeTab.id };
  }
  return null;
}

export function selectCapability(
  state: OmniboxUiState,
  capability: OmniboxCapability,
  activeTab: BrowserTab | null,
): OmniboxUiState {
  const next: OmniboxUiState = {
    ...state,
    capability,
    error: null,
    phaseUnavailableMessage: null,
    contextPickerOpen: false,
  };
  if (capabilityUsesContext(capability)) {
    return {
      ...next,
      context: defaultContextForCapability(capability, activeTab),
    };
  }
  return {
    ...next,
    context: null,
    contextPickerOpen: false,
  };
}

export function setDraft(state: OmniboxUiState, draft: string): OmniboxUiState {
  return {
    ...state,
    draft,
    error: null,
    phaseUnavailableMessage: null,
  };
}

export function setEditing(state: OmniboxUiState, isEditing: boolean): OmniboxUiState {
  return { ...state, isEditing };
}

export function syncDraftFromUrl(state: OmniboxUiState, url: string): OmniboxUiState {
  if (state.isEditing) {
    return state;
  }
  const draft = draftFromUrl(url);
  if (state.draft === draft && state.error === null) {
    return state;
  }
  return {
    ...state,
    draft,
    error: null,
  };
}

export function toggleContextPicker(state: OmniboxUiState): OmniboxUiState {
  if (!capabilityUsesContext(state.capability)) {
    return state;
  }
  return {
    ...state,
    contextPickerOpen: !state.contextPickerOpen,
    error: null,
    phaseUnavailableMessage: null,
  };
}

export function closeContextPicker(state: OmniboxUiState): OmniboxUiState {
  if (!state.contextPickerOpen) {
    return state;
  }
  return { ...state, contextPickerOpen: false };
}

export function handleEscape(state: OmniboxUiState): OmniboxUiState {
  return closeContextPicker(state);
}

export function setContextMode(
  state: OmniboxUiState,
  mode: 'current-tab' | 'selected-tabs',
  activeTab: BrowserTab | null,
): OmniboxUiState {
  if (!capabilityUsesContext(state.capability) || !activeTab) {
    return state;
  }
  if (mode === 'current-tab') {
    return {
      ...state,
      context:
        state.capability === 'ask' && !isAskAvailableForTab(activeTab)
          ? null
          : { kind: 'current-tab', tabId: activeTab.id },
      error: null,
      phaseUnavailableMessage: null,
    };
  }
  return {
    ...state,
    context: { kind: 'selected-tabs', tabIds: [] },
    error: null,
    phaseUnavailableMessage: null,
  };
}

export function isTabEligibleForPicker(
  capability: OmniboxCapability,
  tab: BrowserTab,
): boolean {
  if (capability === 'ask') {
    return isHttpTabUrl(tab.url);
  }
  if (capability === 'automate') {
    return true;
  }
  return false;
}

export function toggleSelectedTab(
  state: OmniboxUiState,
  tabId: string,
  tabs: readonly BrowserTab[],
): OmniboxUiState {
  if (state.context?.kind !== 'selected-tabs') {
    return state;
  }
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !isTabEligibleForPicker(state.capability, tab)) {
    return state;
  }

  const current = state.context.tabIds;
  if (current.includes(tabId)) {
    return {
      ...state,
      context: {
        kind: 'selected-tabs',
        tabIds: current.filter((id) => id !== tabId),
      },
    };
  }
  if (current.length >= MAX_CONTEXT_TABS) {
    return state;
  }
  return {
    ...state,
    context: {
      kind: 'selected-tabs',
      tabIds: [...current, tabId],
    },
  };
}

export function reconcileWithBrowser(
  state: OmniboxUiState,
  tabs: readonly BrowserTab[],
  activeTabId: string | null,
): OmniboxUiState {
  const liveIds = new Set(tabs.map((tab) => tab.id));
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  let next = state;

  if (next.context?.kind === 'current-tab') {
    if (!activeTab || !liveIds.has(activeTab.id)) {
      next = { ...next, context: null };
    } else if (next.capability === 'ask' && !isAskAvailableForTab(activeTab)) {
      next = { ...next, context: null };
    } else {
      next = {
        ...next,
        context: { kind: 'current-tab', tabId: activeTab.id },
      };
    }
  }

  if (next.context?.kind === 'selected-tabs') {
    const tabIds = next.context.tabIds.filter((tabId) => {
      if (!liveIds.has(tabId)) {
        return false;
      }
      const tab = tabById.get(tabId);
      return tab ? isTabEligibleForPicker(next.capability, tab) : false;
    });
    next = {
      ...next,
      context: { kind: 'selected-tabs', tabIds },
    };
  }

  if (
    capabilityUsesContext(next.capability) &&
    next.context === null &&
    next.capability === 'automate' &&
    activeTab
  ) {
    next = { ...next, context: { kind: 'current-tab', tabId: activeTab.id } };
  }

  return next;
}

export function contextSummary(state: OmniboxUiState): string | null {
  if (!capabilityUsesContext(state.capability) || !state.context) {
    return null;
  }
  if (state.context.kind === 'current-tab') {
    return 'Current tab';
  }
  const count = state.context.tabIds.length;
  if (count === 0) {
    return 'Select tabs';
  }
  if (count === 1) {
    return '1 tab';
  }
  return `${count} tabs`;
}

export function isPhase5Capability(capability: OmniboxCapability): boolean {
  return capability === 'automate';
}

export function buildRouteIntentInput(
  state: OmniboxUiState,
): BrowserIntentRouteInput | null {
  const text = state.draft.trim();
  if (!text || text.length > MAX_BROWSER_INTENT_TEXT_CHARS) {
    return null;
  }
  if (state.capability === 'ask' || state.capability === 'automate') {
    if (!state.context) {
      return null;
    }
    return {
      text,
      capability: state.capability,
      context: state.context,
    };
  }
  return {
    text,
    capability: state.capability,
  };
}

export function beginSubmit(state: OmniboxUiState): OmniboxUiState {
  return {
    ...state,
    submitting: true,
    error: null,
    phaseUnavailableMessage: null,
  };
}

export function finishSubmit(state: OmniboxUiState): OmniboxUiState {
  return { ...state, submitting: false, isEditing: false };
}

export function resetAfterSuccessfulAiSubmit(state: OmniboxUiState): OmniboxUiState {
  return {
    ...state,
    draft: '',
    capability: 'default',
    context: null,
    contextPickerOpen: false,
    submitting: false,
    error: null,
    phaseUnavailableMessage: null,
    isEditing: false,
  };
}

export function setSubmitError(state: OmniboxUiState, error: string): OmniboxUiState {
  return { ...state, submitting: false, error, phaseUnavailableMessage: null };
}

export function setPhaseUnavailable(state: OmniboxUiState): OmniboxUiState {
  return {
    ...state,
    submitting: false,
    phaseUnavailableMessage: OMNIBOX_PHASE_UNAVAILABLE,
    error: null,
  };
}

export function mapRouteErrorMessage(code: string): string {
  if (code === 'AI_NATIVE_EMPTY_INPUT') {
    return 'Enter a URL, search, or command.';
  }
  if (code === 'AI_NATIVE_TAB_UNAVAILABLE' || code === 'AI_NATIVE_CONTEXT_INVALID') {
    return 'This command is unavailable for the current tab or context.';
  }
  return OMNIBOX_NAV_ERROR;
}

export function mapAiStartErrorMessage(message: string): string {
  return message;
}

export const OMNIBOX_CAPABILITIES: readonly {
  id: OmniboxCapability;
  label: string;
}[] = [
  { id: 'search', label: 'Search' },
  { id: 'ask', label: 'Ask' },
  { id: 'act', label: 'Act' },
  { id: 'delegate', label: 'Delegate' },
  { id: 'automate', label: 'Automate' },
];
