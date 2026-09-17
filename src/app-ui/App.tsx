import { useCallback, useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from 'react';

import type { AiAnswerEvent } from '../shared/ai-types';
import type { BrowserState, BrowserTab, TabId } from '../shared/browser-types';
import { AiSidePanel, type AiTranscriptEntry } from './AiSidePanel';

const NAV_ERROR = 'Invalid or unsupported address';

interface TabAiUiState {
  entries: AiTranscriptEntry[];
  activeAskId: string | null;
  draft: string;
}

function tabLabel(tab: BrowserTab): string {
  if (tab.title) {
    return tab.title;
  }

  if (tab.url === 'about:blank') {
    return 'New Tab';
  }

  try {
    const hostname = new URL(tab.url).hostname;
    return hostname || tab.url;
  } catch {
    return tab.url;
  }
}

function addressBarValue(url: string): string {
  return url === 'about:blank' ? '' : url;
}

function emptyTabAiState(): TabAiUiState {
  return { entries: [], activeAskId: null, draft: '' };
}

export function App() {
  const [browserState, setBrowserState] = useState<BrowserState | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tabAiState, setTabAiState] = useState<Record<TabId, TabAiUiState>>({});
  const lastSyncedUrlRef = useRef('');

  const activeTab =
    browserState?.tabs.find((tab) => tab.id === browserState.activeTabId) ?? null;
  const activeAi = activeTab ? tabAiState[activeTab.id] ?? emptyTabAiState() : emptyTabAiState();

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;

    void window.browserShell
      .getBrowserState()
      .then((state) => {
        setBrowserState(state);
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to load initial browser state:', error);
      });

    unsubscribe = window.browserShell.onStateChanged((state) => {
      setBrowserState(state);
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    void window.aiAssistant.setPanelOpen(false).catch((error: unknown) => {
      console.error('[app-ui] failed to synchronize AI panel closed:', error);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.aiAssistant.onAnswerEvent((event) => {
      applyAiEvent(event, setTabAiState);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!browserState) {
      return;
    }
    const liveIds = new Set(browserState.tabs.map((tab) => tab.id));
    setTabAiState((current) => {
      const next: Record<TabId, TabAiUiState> = {};
      let changed = false;
      for (const [tabId, state] of Object.entries(current)) {
        if (liveIds.has(tabId)) {
          next[tabId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [browserState]);

  useEffect(() => {
    if (!activeTab || isEditingAddress) {
      return;
    }

    const nextValue = addressBarValue(activeTab.url);
    if (lastSyncedUrlRef.current !== activeTab.url) {
      setAddressDraft(nextValue);
      lastSyncedUrlRef.current = activeTab.url;
      setNavError(null);
    }
  }, [activeTab, isEditingAddress]);

  const runBrowserAction = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error: unknown) {
      console.error('[app-ui] browser action failed:', error);
    }
  }, []);

  const handleCreateTab = () => {
    void runBrowserAction(() => window.browserShell.createTab());
  };

  const handleActivateTab = (tabId: string) => {
    void runBrowserAction(() => window.browserShell.activateTab(tabId));
  };

  const handleCloseTab = (tabId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    void runBrowserAction(() => window.browserShell.closeTab(tabId));
  };

  const handleBack = () => {
    if (!activeTab) {
      return;
    }
    void runBrowserAction(() => window.browserShell.back(activeTab.id));
  };

  const handleForward = () => {
    if (!activeTab) {
      return;
    }
    void runBrowserAction(() => window.browserShell.forward(activeTab.id));
  };

  const handleReload = () => {
    if (!activeTab) {
      return;
    }
    void runBrowserAction(() => window.browserShell.reload(activeTab.id));
  };

  const handleAddressSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!activeTab) {
      return;
    }

    void window.browserShell
      .navigate(activeTab.id, addressDraft)
      .then(() => {
        setNavError(null);
        setIsEditingAddress(false);
      })
      .catch(() => {
        setNavError(NAV_ERROR);
      });
  };

  const handleTogglePanel = () => {
    const nextOpen = !panelOpen;
    void window.aiAssistant
      .setPanelOpen(nextOpen)
      .then((result) => {
        if (!result.ok) {
          console.error('[app-ui] failed to set AI panel open:', result.error.message);
          return;
        }
        setPanelOpen(nextOpen);
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to set AI panel open:', error);
      });
  };

  const handleClosePanel = () => {
    void window.aiAssistant
      .setPanelOpen(false)
      .then((result) => {
        if (!result.ok) {
          console.error('[app-ui] failed to close AI panel:', result.error.message);
          return;
        }
        setPanelOpen(false);
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to close AI panel:', error);
      });
  };

  const updateActiveTabAi = (updater: (current: TabAiUiState) => TabAiUiState) => {
    if (!activeTab) {
      return;
    }
    const tabId = activeTab.id;
    setTabAiState((current) => ({
      ...current,
      [tabId]: updater(current[tabId] ?? emptyTabAiState()),
    }));
  };

  const handleAsk = () => {
    if (!activeTab) {
      return;
    }
    const tabId = activeTab.id;
    const question = activeAi.draft.trim();
    if (!question || activeAi.activeAskId) {
      return;
    }

    const userEntry: AiTranscriptEntry = {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
    };
    updateActiveTabAi((current) => ({
      ...current,
      draft: '',
      entries: [...current.entries, userEntry],
    }));

    void window.aiAssistant
      .askCurrentPage({ tabId, question })
      .then((result) => {
        if (!result.ok) {
          const errorEntry: AiTranscriptEntry = {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: '',
            status: 'error',
            errorMessage: result.error.message,
          };
          setTabAiState((current) => {
            const tabState = current[tabId] ?? emptyTabAiState();
            return {
              ...current,
              [tabId]: {
                ...tabState,
                activeAskId: null,
                entries: [...tabState.entries, errorEntry],
              },
            };
          });
          return;
        }

        const assistantEntry: AiTranscriptEntry = {
          id: crypto.randomUUID(),
          role: 'assistant',
          text: '',
          status: 'streaming',
          askId: result.askId,
        };
        setTabAiState((current) => {
          const tabState = current[tabId] ?? emptyTabAiState();
          return {
            ...current,
            [tabId]: {
              ...tabState,
              activeAskId: result.askId,
              entries: [...tabState.entries, assistantEntry],
            },
          };
        });
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to start AI ask:', error);
      });
  };

  const handleStop = () => {
    if (!activeTab || !activeAi.activeAskId) {
      return;
    }
    void window.aiAssistant
      .cancelAsk({ tabId: activeTab.id, askId: activeAi.activeAskId })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to cancel AI ask:', error);
      });
  };

  const handleClear = () => {
    if (!activeTab) {
      return;
    }
    const tabId = activeTab.id;
    void window.aiAssistant
      .clearConversation(tabId)
      .then((result) => {
        if (!result.ok) {
          console.error('[app-ui] failed to clear conversation:', result.error.message);
          return;
        }
        setTabAiState((current) => ({
          ...current,
          [tabId]: emptyTabAiState(),
        }));
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to clear conversation:', error);
      });
  };

  const controlsDisabled = !activeTab;

  return (
    <div className="app-shell">
      <div className="browser-chrome">
        <div className="tab-strip" role="tablist" aria-label="Tabs">
          {browserState?.tabs.map((tab) => {
            const isActive = tab.id === browserState.activeTabId;
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                className={`tab ${isActive ? 'tab-active' : ''}`}
              >
                <button
                  type="button"
                  className="tab-select"
                  onClick={() => handleActivateTab(tab.id)}
                >
                  <span className="tab-label">{tabLabel(tab)}</span>
                </button>
                <button
                  type="button"
                  className="tab-close"
                  aria-label={`Close ${tabLabel(tab)}`}
                  onClick={(event) => handleCloseTab(tab.id, event)}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="tab-new"
            aria-label="New tab"
            onClick={handleCreateTab}
            disabled={controlsDisabled && !browserState}
          >
            +
          </button>
        </div>

        <div className="toolbar">
          <div className="nav-controls">
            <button
              type="button"
              className="nav-button"
              onClick={handleBack}
              disabled={controlsDisabled || !activeTab?.canGoBack}
              aria-label="Back"
            >
              ←
            </button>
            <button
              type="button"
              className="nav-button"
              onClick={handleForward}
              disabled={controlsDisabled || !activeTab?.canGoForward}
              aria-label="Forward"
            >
              →
            </button>
            <button
              type="button"
              className="nav-button"
              onClick={handleReload}
              disabled={controlsDisabled}
              aria-label="Reload"
            >
              ↻
            </button>
          </div>

          <form className="address-form" onSubmit={handleAddressSubmit}>
            <input
              type="text"
              className={`address-input ${navError ? 'address-input-error' : ''}`}
              value={addressDraft}
              placeholder="Enter address"
              disabled={controlsDisabled}
              onChange={(event) => setAddressDraft(event.target.value)}
              onFocus={(event) => {
                setIsEditingAddress(true);
                event.currentTarget.select();
              }}
              onBlur={() => setIsEditingAddress(false)}
              spellCheck={false}
            />
          </form>

          {activeTab?.loading ? <span className="loading-indicator">Loading…</span> : null}
          {navError ? <span className="nav-error">{navError}</span> : null}

          <button
            type="button"
            className={`nav-button ai-toggle ${panelOpen ? 'ai-toggle-open' : ''}`}
            onClick={handleTogglePanel}
            aria-pressed={panelOpen}
            aria-label="AI assistant"
          >
            AI
          </button>
        </div>
      </div>

      {panelOpen ? (
        <AiSidePanel
          hasActiveTab={Boolean(activeTab)}
          entries={activeAi.entries}
          isAsking={activeAi.activeAskId !== null}
          draft={activeAi.draft}
          onDraftChange={(value) => updateActiveTabAi((current) => ({ ...current, draft: value }))}
          onAsk={handleAsk}
          onStop={handleStop}
          onClear={handleClear}
          onClose={handleClosePanel}
        />
      ) : null}
    </div>
  );
}

function applyAiEvent(
  event: AiAnswerEvent,
  setTabAiState: Dispatch<SetStateAction<Record<TabId, TabAiUiState>>>,
): void {
  if (event.type === 'conversation-cleared') {
    setTabAiState((current) => ({
      ...current,
      [event.tabId]: emptyTabAiState(),
    }));
    return;
  }

  setTabAiState((current) => {
    const tabState = current[event.tabId] ?? emptyTabAiState();
    if (tabState.activeAskId && tabState.activeAskId !== event.askId) {
      return current;
    }

    if (event.type === 'answer-started') {
      return {
        ...current,
        [event.tabId]: {
          ...tabState,
          activeAskId: event.askId,
        },
      };
    }

    const entries = tabState.entries.map((entry) => {
      if (entry.role !== 'assistant' || entry.askId !== event.askId) {
        return entry;
      }
      if (event.type === 'answer-text') {
        return {
          ...entry,
          status: 'streaming' as const,
          text: `${entry.text}${event.delta}`,
        };
      }
      if (event.type === 'answer-finished') {
        return {
          ...entry,
          status: 'complete' as const,
          text: event.answer.text,
          truncatedContext: event.answer.truncatedContext,
        };
      }
      if (event.type === 'answer-cancelled') {
        return {
          ...entry,
          status: 'cancelled' as const,
        };
      }
      return {
        ...entry,
        status: 'error' as const,
        errorMessage: event.error.message,
      };
    });

    const activeAskId =
      event.type === 'answer-finished' ||
      event.type === 'answer-cancelled' ||
      event.type === 'answer-error'
        ? null
        : tabState.activeAskId;

    return {
      ...current,
      [event.tabId]: {
        ...tabState,
        entries,
        activeAskId,
      },
    };
  });
}
