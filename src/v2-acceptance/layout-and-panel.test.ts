import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AiSidePanel } from '../app-ui/AiSidePanel';
import type { AiTranscriptEntry } from '../app-ui/ai-ui-state';
import { AI_SIDE_PANEL_WIDTH_PX } from '../shared/ai-types';
import { calculateWebsiteViewBounds, CHROME_HEIGHT } from '../main/website-view-bounds';

describe('V2 native panel layout', () => {
  it('uses full website width when the panel is closed', () => {
    for (const width of [800, 1024, 1600]) {
      const bounds = calculateWebsiteViewBounds(width, 768, 0);
      assert.equal(bounds.width, width);
      assert.equal(bounds.y, CHROME_HEIGHT);
      assert.equal(bounds.x, 0);
    }
  });

  it('narrows the website by 360px when the panel is open', () => {
    for (const width of [800, 1024, 1600]) {
      const bounds = calculateWebsiteViewBounds(width, 900, AI_SIDE_PANEL_WIDTH_PX);
      assert.equal(bounds.width, Math.max(0, width - 360));
      assert.equal(bounds.y, CHROME_HEIGHT);
    }
  });

  it('keeps y below chrome after resize and never accepts a negative website width', () => {
    const closed = calculateWebsiteViewBounds(500, 400, 0);
    const opened = calculateWebsiteViewBounds(500, 400, AI_SIDE_PANEL_WIDTH_PX);
    const resizedOpen = calculateWebsiteViewBounds(300, 240, AI_SIDE_PANEL_WIDTH_PX);
    assert.equal(closed.y, CHROME_HEIGHT);
    assert.equal(opened.y, CHROME_HEIGHT);
    assert.equal(resizedOpen.y, CHROME_HEIGHT);
    assert.equal(resizedOpen.width, 0);
  });
});

describe('V2 side panel treats model output as text', () => {
  it('escapes HTML and Markdown-looking assistant text', () => {
    const entries: AiTranscriptEntry[] = [
      { id: 'u1', role: 'user', text: 'What is this?' },
      {
        id: 'a1',
        role: 'assistant',
        text: '<img src=x onerror=alert(1)> **bold**',
        status: 'complete',
        askId: 'ask-1',
      },
    ];
    const markup = renderToStaticMarkup(
      createElement(AiSidePanel, {
        hasActiveTab: true,
        entries,
        isAsking: false,
        approvalBusy: false,
        mode: 'read',
        draft: '',
        onDraftChange: () => {},
        onModeChange: () => {},
        onAsk: () => {},
        onStop: () => {},
        onClear: () => {},
        onClose: () => {},
      }),
    );
    assert.equal(/<img\b/.test(markup), false);
    assert.ok(markup.includes('&lt;img'));
    assert.ok(markup.includes('onerror=alert(1)'));
    assert.ok(markup.includes('**bold**'));
    assert.equal(markup.includes('<strong>'), false);
  });
});
