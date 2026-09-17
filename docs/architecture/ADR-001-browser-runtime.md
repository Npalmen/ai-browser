# ADR-001: Browser runtime

**Status:** Accepted  
**Date:** 2026-09-17  
**Supersedes:** none  
**See also:** `docs/architecture/browser-architecture.md`, `docs/architecture/ADR-002-page-observation.md`

## Context

The product needs a desktop browser that can render arbitrary websites, own tabs and sessions, observe page state, and eventually mediate AI actions with explicit permission and approval.

The repository is at Cursor/development bootstrap only. Phase 0 must choose a runtime a small team can implement without collapsing observation, interaction, approval, and execution into unrestricted automation.

Candidates: Electron + `WebContentsView`; a Chromium fork; CEF; a Chrome/Chromium extension; plus Playwright-driven Chrome, Tauri/OS webviews, and WebView2-only.

## Decision

Use **Electron** as the V1 desktop shell and Chromium host:

- Chromium comes from Electron (not a self-maintained fork)
- TypeScript for application code
- privileged main process
- a separate application-UI `WebContents` and session
- `BrowserAdapter` as the only agent-facing browser-control surface
- agent, policy, and approval remain Electron-agnostic

### Embedded website content primitive

- **`WebContentsView` is the selected embedded website-content primitive** for in-window tabs.
- **Deprecated `BrowserView` is not the intended implementation.**
- **`<webview>` is not the primary application architecture** (`webviewTag: false`).

### Browser-control abstraction

`BrowserAdapter` sits **above** Electron. Agent and policy code must not import Electron browser types. A future `ChromiumBrowserAdapter` or `RemoteBrowserAdapter` may replace `ElectronBrowserAdapter` without rewriting agent, policy, or approval systems.

A Chromium fork or CEF may replace the adapter later. They are not the V1 runtime.

## Alternatives

| Alternative | Why not V1 |
|-------------|------------|
| Chromium fork | Maximum control; unaffordable complexity and update burden before a usable browser |
| CEF | Strong embed, C++ host cost, slower to a TypeScript product; possible later adapter |
| Chrome extension | Cannot own the browser, sessions, or approval shell |
| Playwright / installed Chrome | Automation, not a product browser |
| Tauri / OS webview / WebView2-only | Engine inconsistency or Windows-only; weaker observation/control |

## Consequences

**Positive**

- Fastest path to a real Windows (then macOS) browser with tabs
- Process isolation and security knobs exist if configured correctly
- CDP/Electron APIs are enough for V1 observe/navigate/interact
- Packaging and desktop UX stay in a well-known ecosystem
- Adapter boundary preserves a path to deeper Chromium integration

**Negative**

- Less Chromium control than a fork
- Electron Chromium lag vs Chrome
- Easy to leak Node/IPC into renderers or Electron types into the agent
- Per-tab `WebContentsView` memory cost
- Must close `webContents` explicitly to avoid leaks

**Required follow-through** (implementation phases, not this ADR):

See `browser-architecture.md` §4.2 for the full invariant set. Non-negotiable website-tab requirements include:

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
webSecurity enabled (never disabled)
```

Plus: separate website/app-ui trust domains; no website IPC to agent/policy/adapter; sender-validated application IPC; deny-by-default session permissions; controlled popups, protocols, and downloads; credentials/cookies never auto-exposed to the model.

Agent and adapter rules:

- Agent talks only to `BrowserAdapter`; no direct Electron/`WebContents` access
- No unrestricted `executeJavaScript` / `evaluate` / `runScript` agent tool
- Semantic action levels (`OBSERVE` … `EXECUTE`) live in the permission engine, not in the adapter
- `BrowserAdapter` stays runtime-oriented (tabs, navigation, observation, primitives) — no business verbs like `purchase` or `sendEmail`

## Revisit if

Do not reopen this decision merely because another runtime is theoretically more powerful. Revisit only if:

- Electron prevents required browser-engine control the product cannot obtain through CDP/adapter work
- Security isolation requirements for arbitrary remote content cannot be met within Electron
- Chromium modification becomes a **core product requirement**, not a convenience
- Unacceptable Electron-specific limitations appear at scale (observation, targeting, compatibility, or performance) and a CEF adapter or fork is staffed

Revisit means a new ADR and an adapter implementation, not an agent/policy rewrite, if V1 keeps the boundary in `browser-architecture.md`.
