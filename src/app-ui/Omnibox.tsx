import { type FormEvent, type RefObject } from 'react';

import type { BrowserTab } from '../shared/browser-types';
import { MAX_BROWSER_INTENT_TEXT_CHARS } from '../shared/ai-native-types';
import { OmniboxContextPicker } from './OmniboxContextPicker';
import {
  capabilityUsesContext,
  contextSummary,
  isActAvailableForTab,
  isAskAvailableForTab,
  OMNIBOX_ACT_UNAVAILABLE,
  OMNIBOX_ASK_UNAVAILABLE,
  OMNIBOX_CAPABILITIES,
  selectCapability,
  setContextMode,
  setDraft,
  setEditing,
  toggleContextPicker,
  handleEscape,
  toggleSelectedTab,
  type OmniboxUiState,
} from './omnibox-ui-state';

export interface OmniboxProps {
  readonly state: OmniboxUiState;
  readonly activeTab: BrowserTab | null;
  readonly tabs: readonly BrowserTab[];
  readonly activeTabId: string | null;
  readonly disabled: boolean;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly onStateChange: (state: OmniboxUiState) => void;
  readonly onSubmit: () => void;
}

export function Omnibox(props: OmniboxProps) {
  const { state, activeTab, onStateChange, onSubmit } = props;
  const askUnavailable = state.capability === 'ask' && !isAskAvailableForTab(activeTab);
  const actUnavailable = state.capability === 'act' && !isActAvailableForTab(activeTab);
  const summary = contextSummary(state);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  const handleCapabilitySelect = (capability: OmniboxUiState['capability']) => {
    if (capability === state.capability) {
      onStateChange(selectCapability(state, 'default', activeTab));
      return;
    }
    onStateChange(selectCapability(state, capability, activeTab));
  };

  return (
    <div className="omnibox">
      <div className="omnibox-capabilities" role="toolbar" aria-label="Omnibox capabilities">
        {OMNIBOX_CAPABILITIES.map((chip) => (
          <button
            key={chip.id}
            type="button"
            className={`omnibox-capability ${state.capability === chip.id ? 'omnibox-capability-active' : ''}`}
            aria-pressed={state.capability === chip.id}
            disabled={props.disabled}
            onClick={() => handleCapabilitySelect(chip.id)}
          >
            {chip.label}
          </button>
        ))}
      </div>

      <form className="omnibox-form" onSubmit={handleSubmit}>
        <input
          ref={props.inputRef}
          type="text"
          className={`omnibox-input ${state.error ? 'omnibox-input-error' : ''}`}
          value={state.draft}
          placeholder="Search or enter address"
          disabled={props.disabled || state.submitting}
          maxLength={MAX_BROWSER_INTENT_TEXT_CHARS}
          aria-label="Omnibox"
          spellCheck={false}
          onChange={(event) => onStateChange(setDraft(state, event.target.value))}
          onFocus={(event) => {
            onStateChange(setEditing(state, true));
            event.currentTarget.select();
          }}
          onBlur={() => onStateChange(setEditing(state, false))}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onStateChange(handleEscape(state));
            }
          }}
        />

        {capabilityUsesContext(state.capability) ? (
          <button
            type="button"
            className="omnibox-context-button"
            disabled={props.disabled || askUnavailable}
            aria-expanded={state.contextPickerOpen}
            aria-haspopup="dialog"
            onClick={() => onStateChange(toggleContextPicker(state))}
          >
            {summary ?? 'Context'}
          </button>
        ) : null}

        <button
          type="submit"
          className="omnibox-submit"
          disabled={props.disabled || state.submitting}
          aria-label="Submit"
        >
          Go
        </button>
      </form>

      {askUnavailable ? (
        <p className="omnibox-hint omnibox-hint-warning">{OMNIBOX_ASK_UNAVAILABLE}</p>
      ) : null}
      {actUnavailable ? (
        <p className="omnibox-hint omnibox-hint-warning">{OMNIBOX_ACT_UNAVAILABLE}</p>
      ) : null}
      {state.phaseUnavailableMessage ? (
        <p className="omnibox-hint">{state.phaseUnavailableMessage}</p>
      ) : null}
      {state.error ? <p className="omnibox-error">{state.error}</p> : null}

      {state.contextPickerOpen && state.context ? (
        <OmniboxContextPicker
          state={state}
          capability={state.capability}
          tabs={props.tabs}
          activeTabId={props.activeTabId}
          context={state.context}
          onSetContextMode={(mode) => onStateChange(setContextMode(state, mode, activeTab))}
          onToggleTab={(tabId) => onStateChange(toggleSelectedTab(state, tabId, props.tabs))}
        />
      ) : null}
    </div>
  );
}
