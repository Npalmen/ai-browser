import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type { BrowserState, BrowserTab } from '../shared/browser-types';

const NAV_ERROR = 'Invalid or unsupported address';

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

export function App() {
  const [browserState, setBrowserState] = useState<BrowserState | null>(null);
  const [addressDraft, setAddressDraft] = useState('');
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [navError, setNavError] = useState<string | null>(null);
  const lastSyncedUrlRef = useRef('');

  const activeTab =
    browserState?.tabs.find((tab) => tab.id === browserState.activeTabId) ?? null;

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

  const controlsDisabled = !activeTab;

  return (
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
      </div>
    </div>
  );
}
