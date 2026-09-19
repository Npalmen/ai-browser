import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';

import type { AiPanelMode } from '../shared/autonomous-task-types';
import type { BrowserState, BrowserTab } from '../shared/browser-types';
import { AiSidePanel } from './AiSidePanel';
import {
  acknowledgeAsk,
  appendUserQuestion,
  applyAiAnswerEvent,
  applyAskStartFailure,
  emptyTabAiState,
  purgeClosedTabs,
  type AiUiState,
  type TabAiUiState,
} from './ai-ui-state';
import {
  applyApprovalDecideFailure,
  applyApprovalEvent,
  emptyTabApprovalState,
  isApprovalBusy,
  markApprovalDeciding,
  purgeClosedApprovalTabs,
  type ApprovalUiState,
} from './approval-ui-state';
import {
  applyAutonomousTaskEvent,
  applyAutonomousTaskStartFailure,
  autonomousTaskUiFromViews,
  emptyAutonomousTaskUiState,
  findAwaitingUserInputTask,
  hasAutonomousTaskAttention,
  ownedTaskTabIds,
  setAutonomousTaskReplyDraft,
  type AutonomousTaskUiState,
} from './autonomous-task-ui-state';

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
  const [panelOpen, setPanelOpen] = useState(false);
  const [tabAiState, setTabAiState] = useState<AiUiState>({});
  const [tabApprovalState, setTabApprovalState] = useState<ApprovalUiState>({});
  const [taskUiState, setTaskUiState] = useState<AutonomousTaskUiState>(emptyAutonomousTaskUiState());
  const [panelMode, setPanelMode] = useState<AiPanelMode>('read');
  const lastSyncedUrlRef = useRef('');
  const activeTabIdRef = useRef<string | null>(null);

  const activeTab =
    browserState?.tabs.find((tab) => tab.id === browserState.activeTabId) ?? null;
  const activeAi = activeTab ? tabAiState[activeTab.id] ?? emptyTabAiState() : emptyTabAiState();
  const activeApproval = activeTab
    ? tabApprovalState[activeTab.id] ?? emptyTabApprovalState()
    : emptyTabApprovalState();
  const approvalBusy = isApprovalBusy(activeApproval.status);
  activeTabIdRef.current = activeTab?.id ?? null;

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
      setTabAiState((current) => applyAiAnswerEvent(current, event));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.aiAssistant.onAutonomousTaskEvent((event) => {
      setTaskUiState((current) => applyAutonomousTaskEvent(current, event));
    });
    void window.aiAssistant
      .getAutonomousTaskState()
      .then((result) => {
        if (!result.ok) {
          return;
        }
        setTaskUiState(autonomousTaskUiFromViews(result.tasks));
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to load autonomous task state:', error);
      });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const unsubscribe = window.aiAssistant.onApprovalEvent((event) => {
      setTabApprovalState((current) => applyApprovalEvent(current, event));
      if (
        event.type === 'approval-required' &&
        event.approval.tabId === activeTabIdRef.current
      ) {
        void window.aiAssistant
          .setPanelOpen(true)
          .then((result) => {
            if (!result.ok) {
              return;
            }
            setPanelOpen(true);
          })
          .catch((error: unknown) => {
            console.error('[app-ui] failed to open AI panel for approval:', error);
          });
      }
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!panelOpen) {
      return;
    }
    void window.aiAssistant
      .getAutonomousTaskState()
      .then((result) => {
        if (!result.ok) {
          return;
        }
        setTaskUiState((current) => ({
          ...autonomousTaskUiFromViews(result.tasks),
          replyDraftByTaskId: current.replyDraftByTaskId,
          startError: current.startError,
        }));
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to refresh autonomous task state:', error);
      });
  }, [panelOpen]);

  useEffect(() => {
    if (!browserState) {
      return;
    }
    const liveIds = new Set(browserState.tabs.map((tab) => tab.id));
    setTabAiState((current) => purgeClosedTabs(current, liveIds));
    setTabApprovalState((current) => purgeClosedApprovalTabs(current, liveIds));
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
    if (!activeTab || panelMode === 'delegate') {
      return;
    }
    const tabId = activeTab.id;
    const question = activeAi.draft.trim();
    if (!question || activeAi.activeAskId || approvalBusy) {
      return;
    }

    const rendererRequestId = crypto.randomUUID();
    setTabAiState((current) => appendUserQuestion(current, tabId, question, rendererRequestId));

    const mode = activeAi.mode;
    void window.aiAssistant
      .askCurrentPage({ tabId, question, mode })
      .then((result) => {
        if (!result.ok) {
          setTabAiState((current) =>
            applyAskStartFailure(current, tabId, result.error, rendererRequestId),
          );
          return;
        }
        setTabAiState((current) =>
          acknowledgeAsk(current, tabId, result.askId, rendererRequestId),
        );
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

  const handleApprovalDecision = (decision: 'approve' | 'reject') => {
    if (!activeTab || !activeApproval.approval) {
      return;
    }
    const tabId = activeTab.id;
    const approvalId = activeApproval.approval.approvalId;
    setTabApprovalState((current) => markApprovalDeciding(current, tabId, approvalId));
    void window.aiAssistant
      .decideApproval({ approvalId, decision })
      .then((result) => {
        if (result.ok) {
          return;
        }
        setTabApprovalState((current) =>
          applyApprovalDecideFailure(current, tabId, approvalId, result.error),
        );
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to decide approval:', error);
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
        setTabAiState((current) =>
          applyAiAnswerEvent(current, {
            type: 'conversation-cleared',
            tabId,
            reason: 'user',
          }),
        );
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to clear conversation:', error);
      });
  };

  const handleDelegate = () => {
    if (panelMode !== 'delegate') {
      return;
    }
    const objective = activeAi.draft.trim();
    if (!objective) {
      return;
    }
    updateActiveTabAi((current) => ({ ...current, draft: '' }));
    void window.aiAssistant
      .startAutonomousTask({ objective })
      .then((result) => {
        if (!result.ok) {
          setTaskUiState((current) =>
            applyAutonomousTaskStartFailure(current, result.error.message),
          );
          return;
        }
        setTaskUiState((current) =>
          applyAutonomousTaskEvent(current, {
            type: 'autonomous-task-started',
            task: result.task,
          }),
        );
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to start autonomous task:', error);
      });
  };

  const handleTaskReply = (taskId?: string) => {
    const awaiting = findAwaitingUserInputTask(taskUiState);
    const replyTaskId = taskId ?? awaiting?.taskId;
    if (!replyTaskId) {
      return;
    }
    const reply =
      (taskId ? taskUiState.replyDraftByTaskId[replyTaskId] : undefined)?.trim() ||
      activeAi.draft.trim();
    if (!reply) {
      return;
    }
    updateActiveTabAi((current) => ({ ...current, draft: '' }));
    setTaskUiState((current) => setAutonomousTaskReplyDraft(current, replyTaskId, ''));
    void window.aiAssistant
      .replyToAutonomousTask({ taskId: replyTaskId, reply })
      .then((result) => {
        if (!result.ok) {
          return;
        }
        setTaskUiState((current) =>
          applyAutonomousTaskEvent(current, {
            type: 'autonomous-task-progress',
            task: result.task,
          }),
        );
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to reply to autonomous task:', error);
      });
  };

  const handlePauseTask = (taskId: string) => {
    void window.aiAssistant
      .pauseAutonomousTask({ taskId })
      .then((result) => {
        if (!result.ok) {
          return;
        }
        setTaskUiState((current) =>
          applyAutonomousTaskEvent(current, {
            type: result.task.state === 'paused' ? 'autonomous-task-paused' : 'autonomous-task-progress',
            task: result.task,
          }),
        );
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to pause autonomous task:', error);
      });
  };

  const handleResumeTask = (taskId: string) => {
    void window.aiAssistant
      .resumeAutonomousTask({ taskId })
      .then((result) => {
        if (!result.ok) {
          return;
        }
        setTaskUiState((current) =>
          applyAutonomousTaskEvent(current, {
            type: 'autonomous-task-resumed',
            task: result.task,
          }),
        );
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to resume autonomous task:', error);
      });
  };

  const handleStopTask = (taskId: string) => {
    void window.aiAssistant
      .stopAutonomousTask({ taskId })
      .then((result) => {
        if (!result.ok) {
          return;
        }
        setTaskUiState((current) =>
          applyAutonomousTaskEvent(current, {
            type: 'autonomous-task-cancelled',
            task: result.task,
          }),
        );
      })
      .catch((error: unknown) => {
        console.error('[app-ui] failed to stop autonomous task:', error);
      });
  };

  const handlePanelModeChange = (mode: AiPanelMode) => {
    setPanelMode(mode);
    if (mode === 'read' || mode === 'interact') {
      updateActiveTabAi((current) => ({ ...current, mode }));
    }
  };

  const taskOwnedTabs = ownedTaskTabIds(taskUiState);
  const taskAttention = hasAutonomousTaskAttention(taskUiState);

  const controlsDisabled = !activeTab;

  return (
    <div className="app-shell">
      <div className="browser-chrome">
        <div className="tab-strip" role="tablist" aria-label="Tabs">
          {browserState?.tabs.map((tab) => {
            const isActive = tab.id === browserState.activeTabId;
            const taskOwned = taskOwnedTabs.has(tab.id);
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                className={`tab ${isActive ? 'tab-active' : ''} ${taskOwned ? 'tab-task-owned' : ''}`}
              >
                <button
                  type="button"
                  className="tab-select"
                  onClick={() => handleActivateTab(tab.id)}
                >
                  {taskOwned ? <span className="tab-task-dot" aria-label="Task tab" /> : null}
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
            className={`nav-button ai-toggle ${panelOpen ? 'ai-toggle-open' : ''} ${
              taskAttention ? 'ai-toggle-attention' : ''
            }`}
            onClick={handleTogglePanel}
            aria-pressed={panelOpen}
            aria-label={taskAttention ? 'AI assistant, attention required' : 'AI assistant'}
          >
            AI
            {taskAttention ? <span className="ai-toggle-badge" aria-hidden="true" /> : null}
          </button>
        </div>
      </div>

      {panelOpen ? (
        <AiSidePanel
          hasActiveTab={Boolean(activeTab)}
          entries={activeAi.entries}
          isAsking={activeAi.activeAskId !== null}
          approvalBusy={approvalBusy}
          mode={panelMode}
          draft={activeAi.draft}
          onDraftChange={(value) => updateActiveTabAi((current) => ({ ...current, draft: value }))}
          onModeChange={handlePanelModeChange}
          onAsk={handleAsk}
          onDelegate={handleDelegate}
          onTaskReply={() => handleTaskReply()}
          onStop={handleStop}
          onClear={handleClear}
          onClose={handleClosePanel}
          approval={activeApproval}
          onApprove={() => handleApprovalDecision('approve')}
          onReject={() => handleApprovalDecision('reject')}
          tasks={taskUiState.tasks}
          startError={taskUiState.startError}
          replyDraftByTaskId={taskUiState.replyDraftByTaskId}
          onReplyDraftChange={(taskId, value) =>
            setTaskUiState((current) => setAutonomousTaskReplyDraft(current, taskId, value))
          }
          onPauseTask={handlePauseTask}
          onResumeTask={handleResumeTask}
          onStopTask={handleStopTask}
          onReplyTask={(taskId) => handleTaskReply(taskId)}
        />
      ) : null}
    </div>
  );
}
