import type { FormEvent, KeyboardEvent } from 'react';

import { AI_SIDE_PANEL_WIDTH_PX, type AiRequestMode } from '../shared/ai-types';

import type { AiTranscriptEntry } from './ai-ui-state';

export function AiSidePanel(props: {
  hasActiveTab: boolean;
  entries: AiTranscriptEntry[];
  isAsking: boolean;
  mode: AiRequestMode;
  draft: string;
  onDraftChange: (value: string) => void;
  onModeChange: (mode: AiRequestMode) => void;
  onAsk: () => void;
  onStop: () => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const canAsk =
    props.hasActiveTab && props.draft.trim().length > 0 && !props.isAsking;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canAsk) {
      return;
    }
    props.onAsk();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canAsk) {
        props.onAsk();
      }
    }
  };

  return (
    <aside
      className="ai-side-panel"
      style={{ width: AI_SIDE_PANEL_WIDTH_PX }}
      aria-label="AI assistant"
    >
      <header className="ai-panel-header">
        <h1 className="ai-panel-title">AI assistant</h1>
        <div className="ai-panel-header-actions">
          <button type="button" className="ai-panel-button" onClick={props.onClear}>
            Clear
          </button>
          <button
            type="button"
            className="ai-panel-button"
            onClick={props.onClose}
            aria-label="Close AI panel"
          >
            Close
          </button>
        </div>
      </header>

      <div className="ai-mode-selector" role="group" aria-label="AI request mode">
        <button
          type="button"
          className={`ai-mode-button ${props.mode === 'read' ? 'ai-mode-button-active' : ''}`}
          disabled={props.isAsking}
          aria-pressed={props.mode === 'read'}
          onClick={() => props.onModeChange('read')}
        >
          Ask
        </button>
        <button
          type="button"
          className={`ai-mode-button ${props.mode === 'interact' ? 'ai-mode-button-active' : ''}`}
          disabled={props.isAsking}
          aria-pressed={props.mode === 'interact'}
          onClick={() => props.onModeChange('interact')}
        >
          Act
        </button>
      </div>

      <div className="ai-panel-body">
        {props.entries.length === 0 ? (
          <p className="ai-empty-state">
            {props.mode === 'interact'
              ? 'Describe one action for the current page.'
              : 'Ask a question about the current page.'}
          </p>
        ) : (
          props.entries.map((entry) => (
            <article
              key={entry.id}
              className={`ai-message ai-message-${entry.role}${
                entry.status === 'error' ? ' ai-message-error' : ''
              }${entry.status === 'cancelled' ? ' ai-message-cancelled' : ''}${
                entry.status === 'denied' ? ' ai-message-denied' : ''
              }`}
            >
              <div className="ai-message-label">
                {entry.role === 'user' ? 'You' : assistantLabel(entry)}
              </div>
              {entry.role === 'assistant' &&
              (entry.status === 'error' || entry.status === 'denied') ? (
                <div className="ai-message-text">
                  {entry.text}
                  {entry.errorMessage ? (
                    <div className="ai-message-error-detail">{entry.errorMessage}</div>
                  ) : null}
                </div>
              ) : (
                <div className="ai-message-text">{entry.text}</div>
              )}
              {entry.role === 'assistant' && entry.status === 'complete' && entry.truncatedContext ? (
                <p className="ai-truncated-note">
                  Some page content was omitted to fit the AI context.
                </p>
              ) : null}
            </article>
          ))
        )}
      </div>

      <form className="ai-panel-footer" onSubmit={handleSubmit}>
        <textarea
          className="ai-question-input"
          value={props.draft}
          placeholder={
            props.mode === 'interact' ? 'Describe one action' : 'Ask about this page'
          }
          disabled={!props.hasActiveTab}
          rows={3}
          onChange={(event) => props.onDraftChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="ai-panel-footer-actions">
          {props.isAsking ? (
            <button type="button" className="ai-panel-button ai-panel-button-primary" onClick={props.onStop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="ai-panel-button ai-panel-button-primary" disabled={!canAsk}>
              {props.mode === 'interact' ? 'Act' : 'Ask'}
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}

function assistantLabel(entry: AiTranscriptEntry): string {
  if (entry.status === 'streaming') {
    return 'Assistant';
  }
  if (entry.status === 'cancelled') {
    return 'Assistant (cancelled)';
  }
  if (entry.status === 'denied') {
    return 'Assistant';
  }
  if (entry.status === 'error') {
    return 'Assistant';
  }
  return 'Assistant';
}
