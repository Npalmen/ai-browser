import type { TabId } from '../shared/browser-types';

export type BrowserTabCreationCause = 'explicit' | 'website-popup';

export interface BrowserTabCreatedEvent {
  readonly tabId: TabId;
  readonly cause: BrowserTabCreationCause;
  readonly sourceTabId?: TabId;
  /**
   * True only when the popup request was captured while an Agent browser
   * click was inside its exact input-dispatch scope.
   * Trusted main-process correlation only. Not renderer/IPC.
   */
  readonly causedByAgentInputDispatch: boolean;
}

export interface CreateTabInput {
  readonly url?: string;
  readonly activate?: boolean;
}

/**
 * Website popups steal the foreground only when their source tab is already active.
 * Inactive source tabs (including background task tabs) must not displace the user.
 */
export function shouldActivateConvertedPopup(
  sourceTabId: TabId,
  activeTabId: TabId | undefined,
): boolean {
  return activeTabId === sourceTabId;
}

export function explicitTabCreatedEvent(tabId: TabId): BrowserTabCreatedEvent {
  return {
    tabId,
    cause: 'explicit',
    causedByAgentInputDispatch: false,
  };
}

export function websitePopupCreatedEvent(input: {
  readonly tabId: TabId;
  readonly sourceTabId: TabId;
  readonly causedByAgentInputDispatch: boolean;
}): BrowserTabCreatedEvent {
  return {
    tabId: input.tabId,
    cause: 'website-popup',
    sourceTabId: input.sourceTabId,
    causedByAgentInputDispatch: input.causedByAgentInputDispatch,
  };
}
