import type { BrowserTab } from '../shared/browser-types';
import { MAX_CONTEXT_TABS } from '../shared/ai-native-types';
import {
  isTabEligibleForPicker,
  type OmniboxCapability,
  type OmniboxContext,
  type OmniboxUiState,
} from './omnibox-ui-state';

function tabHostname(tab: BrowserTab): string {
  if (tab.url === 'about:blank') {
    return 'about:blank';
  }
  try {
    return new URL(tab.url).hostname || tab.url;
  } catch {
    return tab.url;
  }
}

function tabTitle(tab: BrowserTab): string {
  if (tab.title) {
    return tab.title;
  }
  if (tab.url === 'about:blank') {
    return 'New Tab';
  }
  return tabHostname(tab);
}

export interface OmniboxContextPickerProps {
  readonly state: OmniboxUiState;
  readonly capability: OmniboxCapability;
  readonly tabs: readonly BrowserTab[];
  readonly activeTabId: string | null;
  readonly context: OmniboxContext;
  readonly onSetContextMode: (mode: 'current-tab' | 'selected-tabs') => void;
  readonly onToggleTab: (tabId: string) => void;
}

export function OmniboxContextPicker(props: OmniboxContextPickerProps) {
  const selectedIds =
    props.context?.kind === 'selected-tabs' ? new Set(props.context.tabIds) : new Set<string>();
  const atMax =
    props.context?.kind === 'selected-tabs' &&
    props.context.tabIds.length >= MAX_CONTEXT_TABS;

  return (
    <div className="omnibox-context-picker" role="dialog" aria-label="Browser context">
      <div className="omnibox-context-mode">
        <button
          type="button"
          className={`omnibox-context-mode-button ${
            props.context?.kind === 'current-tab' ? 'omnibox-context-mode-active' : ''
          }`}
          aria-pressed={props.context?.kind === 'current-tab'}
          onClick={() => props.onSetContextMode('current-tab')}
        >
          Current tab
        </button>
        <button
          type="button"
          className={`omnibox-context-mode-button ${
            props.context?.kind === 'selected-tabs' ? 'omnibox-context-mode-active' : ''
          }`}
          aria-pressed={props.context?.kind === 'selected-tabs'}
          onClick={() => props.onSetContextMode('selected-tabs')}
        >
          Selected tabs
        </button>
      </div>

      {props.context?.kind === 'selected-tabs' ? (
        <ul className="omnibox-context-tab-list">
          {props.tabs.map((tab) => {
            const eligible = isTabEligibleForPicker(props.capability, tab);
            const selected = selectedIds.has(tab.id);
            const disabled = !eligible || (atMax && !selected);
            return (
              <li key={tab.id}>
                <label className={`omnibox-context-tab-item ${!eligible ? 'omnibox-context-tab-ineligible' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={disabled}
                    onChange={() => props.onToggleTab(tab.id)}
                  />
                  <span className="omnibox-context-tab-copy">
                    <span className="omnibox-context-tab-title">
                      {tabTitle(tab)}
                      {tab.id === props.activeTabId ? ' (active)' : ''}
                    </span>
                    <span className="omnibox-context-tab-url">{tabHostname(tab)}</span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
