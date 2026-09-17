# ADR-002: Page observation

**Status:** Accepted  
**Date:** 2026-09-17  
**Supersedes:** none  
**See also:** `docs/architecture/browser-architecture.md` §7 and §10, `docs/architecture/ADR-001-browser-runtime.md`, `docs/plans/V1-page-observation.md`

## Context

V0 owns tabs, navigation, isolated `WebContentsView`s, and a small `BrowserAdapter`. A future AI agent will need a structured, serializable representation of a live page: where it is, what it contains, which controls exist, and how to name those controls later.

Observation is a privileged main-process capability. It must not:

- inject a website preload
- expose `executeJavaScript` / `evaluate` / `runScript` upward
- expose a generic CDP `sendCommand(any)` API
- stream DOM mutations continuously
- send data to a model provider in this milestone

The architecture already prefers accessibility-first catalogs plus optional screenshots (`browser-architecture.md` §10). This ADR locks the **mechanism** and the **security envelope**. Exact TypeScript shapes live in the V1 plan and later in `src/shared/`.

## Decision

Use a **hybrid structured + screenshot observation** produced entirely in privileged main/browser code:

```text
Website WebContents
        │
        ├── Chrome DevTools Protocol (allowlisted commands only)
        │     ├── Accessibility.getFullAXTree
        │     ├── DOMSnapshot.captureSnapshot
        │     └── Page.getLayoutMetrics / Page.getFrameTree
        │
        └── Electron webContents.capturePage()
                 │
                 ▼
          Observation builder (prune, redact, budget)
                 │
                 ▼
          PageObservation + opaque target map
```

### Mechanism

- **Primary semantic source:** Chromium Accessibility domain (`Accessibility.getFullAXTree`).
- **Primary structure/layout/targeting source:** `DOMSnapshot.captureSnapshot` with layout rects and a tiny attribute/style allowlist.
- **Viewport/layout metadata:** `Page.getLayoutMetrics` plus `Page.getFrameTree` for frame identity and document revision.
- **Visible-viewport screenshot:** Electron `webContents.capturePage()`, not `Page.captureScreenshot`, and not a generic CDP screenshot path.
- **No page-world JavaScript.** No website preload. No `Runtime.evaluate`.

### Public surface

Add one observation method to `BrowserAdapter`:

```ts
observePage(tabId, options?: ObservePageOptions): Promise<PageObservation>
```

Implement it by delegation to a dedicated observation module (`src/observation/`). Do not grow `ElectronBrowserAdapter` into a CDP client. Do not put observation in React or in generic IPC handlers.

`captureScreenshot` is **not** a separate V1 adapter method. Screenshots are an optional field on `PageObservation`.

### CDP encapsulation

CDP is an internal implementation detail of the Electron observer.

- Only main/observation code may attach `webContents.debugger`.
- Commands are a **closed allowlist**. Unknown method names are a type/implementation error, not a runtime parameter.
- There is no public or agent-facing `sendCdpCommand(command, params)`.
- A private helper, if any, must take a typed allowlisted method, not `string`.

Allowed V1 CDP methods:

```text
Accessibility.enable
Accessibility.getFullAXTree
DOMSnapshot.captureSnapshot
Page.getLayoutMetrics
Page.getFrameTree
```

Everything else is forbidden, including but not limited to:

```text
Runtime.evaluate / Runtime.callFunctionOn
Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText
Page.navigate / Page.reload / Page.handleJavaScriptDialog
Network.getCookies / Network.getAllCookies / Network.setCookie
DOM.getOuterHTML / DOM.setOuterHTML / DOM.focus
Emulation.*
Overlay.*
HeapProfiler.* / Profiler.*
```

`Accessibility.enable` is instrumentation (builds an AX tree). It is not a website INTERACT/EXECUTE action.

### Lifecycle

**Attach per observation, then detach if this observer attached.**

Do not keep a long-lived debugger session on every tab. Do not automatically retry mid-observation after debugger detach; a later caller may request a fresh observation.

**Before observation:**

- Reject if the tab no longer exists or its `webContents` is destroyed.
- Reject if another observation is already in flight for the same tab (`OBSERVATION_IN_PROGRESS`).
- Reject if `webContents.debugger.isAttached()` is already true and the attachment is not owned by the current observation — typically DevTools is open. Fail `CDP_UNAVAILABLE`. Do not take over or detach another debugger session.

**During observation:**

- Register for debugger `detach`. If detach occurs unexpectedly (including DevTools opening while this observation owns the debugger), invalidate the observation and fail `CDP_UNAVAILABLE`. Do not return partial AX/DOM/layout data after such detach.

**Cleanup:**

- Remove observation-specific listeners.
- Detach only if this observation successfully attached and the debugger is still attached.
- Cleanup must be safe if navigation, crash, or close already caused detachment.

### Readiness

Observation does not begin against a website tab in an unusable transitional state. Use existing tab/`webContents` state and `Page.getFrameTree`; do not introduce arbitrary sleeps.

If the page cannot produce a stable main-frame/document identity (no usable frame tree or main-frame `loaderId`), fail `PAGE_NOT_READY` rather than hanging or fabricating a revision. Page loading in progress is not a blocker; unfinished network requests are not a blocker.

### Document revision

```text
documentRevision = `${mainFrameId}:${loaderId}`
```

Source: `Page.getFrameTree` for the current main frame. If `loaderId` cannot be obtained, fail `PAGE_NOT_READY`. Do not invent a fallback revision from URL, timestamps, or navigation history.

Main-frame cross-document navigation and reload change revision. Renderer crash and document replacement invalidate all observation targets. Same-document SPA/hash/history changes may retain the same revision — intentional for V1.

### Targeting

Consumers receive opaque `targetId` values scoped to an `observationId` and `document.revision`. `observationId` is generated in privileged code (`crypto.randomUUID()`).

Internal maps may store backend DOM node IDs and AX node IDs. Those integers never appear on `PageObservation`.

A `targetId` is valid only within the observation that produced it. Future interaction must validate tab existence, matching `observationId`, matching `documentRevision`, frame/document existence, and live backend DOM resolution. If the DOM changed within the same loader and the backend node no longer resolves, fail stale — do not retarget by text, selector, label, position, or coordinates.

`targetId` is assigned only where future resolution semantics are sound (reliable backend DOM join). Semantic AX nodes without a reliable DOM join may still be emitted but are not actionable targets.

Registry eviction (V1): replace on successful observe; clear on main-frame revision change, tab close, renderer crash, and observer disposal. No observation history storage.

IDs are invalidated on main-frame navigation, reload, renderer crash, document replacement, tab close, and the next observation of the same tab.

### Screenshot sensitivity

Structured observation redaction does **not** guarantee screenshot redaction. A viewport screenshot may contain password-like text, emails, balances, messages, or other visible sensitive content. V1 remains local. Future remote-model export must treat screenshots as raw potentially sensitive page content and pass through a separate export/policy boundary. No DLP system in V1.

### What this is not

- Not an agent loop
- Not a model-provider integration
- Not INTERACT / click / type
- Not pixel-only computer-use
- Not a full accessibility or DOM inspector dump

## Alternatives

| Alternative | Why not V1 |
|-------------|------------|
| `webContents.executeJavaScript` | Bypasses targeting, hits CSP, weak cross-origin iframe coverage, becomes an unrestricted execution primitive the moment it is reused |
| Website preload / injected script | Violates V0 isolation (`webview`/`preload` forbidden on website views); page can detect, break, or abuse it |
| Accessibility tree only | Strong semantics, weak layout/tag/attribute coverage for future targeting and form typing |
| Raw DOM / `outerHTML` | Token-hostile, poor roles/names, no stable targeting without a second map |
| Screenshot-only vision | No reliable `click target X`; OCR is deferred; expensive; fails closed targeting |
| Long-lived CDP attachment | Simpler command reuse, but fights DevTools, crash/detach, and keeps a privileged control plane open |
| Generic CDP wrapper | Will leak `Runtime.evaluate` and input dispatch into later agent tools |

## Consequences

**Positive**

- Works on arbitrary websites without page cooperation
- AX gives roles, names, and control state; snapshot gives bounds, tags, and backend identity
- Screenshot gives visual confirmation without becoming the targeting channel
- Adapter boundary stays Electron-agnostic for agent/policy later
- Migration path: a future `ChromiumBrowserAdapter` can produce the same `PageObservation`

**Negative**

- Debugger attach is privileged and can fail when DevTools is open
- Full AX + DOMSnapshot is large internally and **must** be pruned before emit
- Cross-origin iframes and closed shadow roots will be incomplete
- Document revision will not track every SPA DOM mutation; stale-click protection is navigation-grained plus observation-scoped IDs

**Required follow-through**

- Implement only under `docs/plans/V1-page-observation.md`
- Keep V0 website `webPreferences` unchanged
- Redact secret field values locally even though V1 does not call a model
- Do not add observation to `BrowserState` push events
- Do not persist screenshots to disk

## Revisit if

Do not reopen this ADR merely because another technique can inspect more page data.

- CDP proves unreliable in the supported Electron/Chromium lifecycle for explicit observe calls
- Structured observation cannot represent required page semantics for targeting
- A future Chromium integration offers a clearly safer or more reliable native observation mechanism
- Cross-origin frame requirements become product-critical and cannot be met safely without injection
- Screenshot-first computer-use replaces ID targeting as the primary mode (would be a new ADR)
- A later Chromium adapter replaces Electron; observation *types* should survive, the CDP transport should not
