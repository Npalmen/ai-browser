# Plan: V0 — Browser Shell

**Status:** complete  
**Explicit reference:** Implementation tasks must cite `docs/plans/V0-browser-shell.md` to treat this file as authoritative.

V0 completed on Windows development environment.

This plan is implementation-ready for Composer. It does not reopen the accepted runtime. Authoritative architecture remains:

```text
docs/architecture/browser-architecture.md
docs/architecture/ADR-001-browser-runtime.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
```

---

## Objective

Ship a real Windows desktop browser **shell** that can launch, show isolated application chrome, render arbitrary HTTP/HTTPS pages in `WebContentsView` tabs, and support basic navigation and tab management.

V0 establishes the secure process model, sessions, IPC, and a small `BrowserAdapter` that later phases can extend. **V0 contains no AI functionality.**

## Out of scope

Do not add any of the following in this plan’s implementation:

- LLM providers, agents, prompts, tool schemas
- DOM/AX observation or screenshots for AI
- Autonomous actions, action classification, approval UI
- Purchases, sends, bookings, or other semantic business operations
- Cloud backend, authentication, browser sync
- Extensions, ad blocking, password manager
- Chromium modifications, CEF, Chromium fork, `<webview>` tabs
- Production installers, auto-update, CI, Docker, E2E frameworks
- macOS/Linux as required targets (do not break a later macOS path)
- `src/agent/`, `src/actions/`, Redux, Tailwind, shadcn, component libraries

If a later idea is useful for V1+, leave a comment only when the V0 code would otherwise become a trap. Do not scaffold unused modules.

---

## Execution controls

```yaml
execution:
  model: composer
  stronger_model_allowed: false
  stronger_model_reason: null
  subagents: false

verification:
  mode: targeted

permissions:
  commit: false
  push: false
  create_pr: false
  wait_for_ci: false
  watch_ci: false
  fix_ci: false
  merge: false
  post_merge_verify: false
  deploy: false
  deployment_verify: false
  live_effects: false
```

Template-equivalent fields (same meaning):

```yaml
model:
  default: composer
  escalation_allowed: false

subagents:
  allowed: false

verification:
  mode: targeted

permissions:
  commit: false
  push: false
  create_pr: false
  wait_for_ci: false
  watch_ci: false
  fix_ci: false
  merge: false
  post_merge_verify: false
  deploy: false
  deployment_verify: false
  live_effects: false
```

Composer is the implementation model. Do not escalate. Do not use subagents. Do not commit or push unless a later prompt grants those permissions. Targeted verification only — see §Verification.

---

## Selected V0 stack

| Choice | Decision |
|--------|----------|
| Runtime | Electron 44.x (stable), Chromium bundled with Electron |
| Language | TypeScript (strict) |
| Package manager | npm |
| Tooling | Electron Forge + Webpack + TypeScript |
| Application UI | React + TypeScript, no component library |
| Website tabs | `WebContentsView` (not `BrowserView`, not `<webview>`) |
| Window | `BrowserWindow` for chrome + child `WebContentsView`s for pages |
| State | Main process is authoritative |

Do not reopen Electron vs fork/CEF/extension unless an actual V0 blocker is found (security isolation cannot be met, or `WebContentsView` cannot host tabs). Record that as a stop, not a silent architecture change.

---

## Technical decisions

### 1. Electron version policy

Use **Electron 44.x**, the current stable major as of September 2026 (44.4.1 on 2026-09-15).

- `package.json` may declare `"electron": "^44.4.1"` (or the newest **stable** 44.x at implementation time).
- The **lockfile** (`package-lock.json`) pins the exact resolved version.
- Do **not** use alpha, beta, or nightly.
- Do **not** jump to Electron 45+ in V0.

**Upgrade policy:** stay on the 44.x stable line during V0/V1 shell work. Take 44.x patch/minor security releases via lockfile updates when implementing. A major Electron bump is a separate, explicit task — not part of ordinary V0 work.

### 2. Package manager

**npm.** One desktop app, Windows-first, Electron Forge docs and templates assume npm, no monorepo, no extra toolchain.

Do not introduce pnpm, yarn, or workspaces.

### 3. Build / development tooling

**Electron Forge + Webpack + TypeScript.**

| Option | Verdict |
|--------|---------|
| Forge + Vite + TS | Faster HMR, but `@electron-forge/plugin-vite` is still documented as experimental (minor releases may break). Rejected for V0. |
| Forge + Webpack + TS | Official non-experimental Forge plugin, known Windows behavior, clear packaging path later. **Selected.** |
| electron-vite / custom Vite outside Forge | Extra packaging machinery later. Rejected. |
| No bundler | Awkward TS + preload + React. Rejected. |

Packaging/installers are **not** a V0 acceptance requirement. Configure Forge so `npm start` runs a development app. A working `npm run package` is nice-to-have, not required.

Use the Forge **webpack-typescript** template as a reference. Do **not** run `create-electron-app` in a way that overwrites `AGENTS.md`, `.cursor/`, or `docs/`. Add Forge files at the repository root beside the existing bootstrap.

Renderer HMR for the small chrome UI is sufficient. Website tabs do not go through the bundler.

### 4. Application UI technology

**React + TypeScript.**

V0 chrome is simple (tabs, back/forward/reload, address bar, loading/title). Later chrome will include sidebar, approval, permissions, settings, and downloads. React without a design system is the smallest setup that will not have to be rewritten for that UI.

- React and `react-dom` only (current stable major at implement time, pinned in the lockfile).
- No React Router, Redux, Zustand, Tailwind, shadcn, MUI, Chakra, animation libraries.
- One CSS file for a basic, clean chrome. System fonts. No dark-theme framework.

Plain TypeScript/DOM was considered and rejected: future chrome complexity would force a rewrite.

---

## Process / trust model

V0 uses three trust domains. No utility process. No agent process.

```text
Electron Main Process (TCB)
│
├── owns the desktop BrowserWindow
├── owns tab registry and metadata
├── owns website WebContentsView instances
├── owns navigation
├── owns session + security handlers
├── implements ElectronBrowserAdapter
└── exposes a narrow typed IPC API to Application UI only

Application UI Renderer (trusted UI, unprivileged runtime)
│
├── local bundled chrome only (never remote websites)
├── React tab strip, toolbar, address bar
├── no Node, no website WebContents access
└── talks to main only through the app preload contract

Website WebContentsView(s) (untrusted)
│
├── arbitrary remote HTTP/HTTPS content
├── nodeIntegration = false
├── contextIsolation = true
├── sandbox = true
├── webSecurity = true
├── webviewTag = false
├── no preload (V0)
└── no privileged application IPC
```

This matches ADR-001 and architecture §4–§5. It is the correct V0 model.

Application UI `webPreferences` also use `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`, plus the **app-only** preload.

---

## Window strategy

**`BrowserWindow` for application chrome, with website `WebContentsView` children on `win.contentView`.**

`BaseWindow` plus two `WebContentsView`s (chrome + page) is not materially more secure and adds layout/lifetime complexity. `BrowserWindow` already provides the trusted application `WebContents`. Security is equivalent if sessions and `webPreferences` stay separated.

### Composition

```text
BrowserWindow
├── trusted application renderer / browser chrome
└── active WebContentsView   (website-content region only)
```

- Chrome is the `BrowserWindow` renderer (React).
- A **fixed chrome height** in main (e.g. 88px: tab strip + toolbar). Do not drive bounds from the renderer in V0.
- **Only the active** website `WebContentsView` is attached to `win.contentView`.
- That view occupies the bounds below the chrome: `getContentBounds()` minus `CHROME_HEIGHT`.
- Main owns bounds updates on window `resize`. Apply the same rectangle whenever a tab is activated.

Do not use `<webview>`. Do not use deprecated `BrowserView`.

Tab attach/detach, close, and shutdown cleanup are specified in **Tab-view lifecycle** below.

---

## Sessions

Two partitions, never mixed:

| Session | Partition | Persistence | Used by |
|---------|-----------|-------------|---------|
| Application UI | `app-ui` | **In-memory** (no `persist:` prefix) | `BrowserWindow` webContents only |
| Websites | `persist:website` | Persistent across restarts | All V0 website tabs |

`persist:website` is the **only** persistent browsing partition in V0.

### Application UI — `partition: "app-ui"`

The trusted chrome uses an in-memory session. It does not need persistent cookies or remote browsing state in V0. It must stay isolated from website sessions.

Hardening (required):

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
webSecurity = true
```

plus the explicitly typed application preload only.

Application UI must not load remote website URLs. Only the local Forge renderer URL (dev) or bundled app files (prod).

### Website tabs — `partition: "persist:website"`

All normal website tabs share this partition. That is browser-like shared website state across tabs and across application restarts, including cookies/session state where Chromium allows it.

Do **not** expose this session to the application renderer or to a future AI/model layer. The app-ui renderer does not read website cookie stores.

Do not implement profiles, incognito, cookie UI, or session-management UX in V0. Those remain deferred.

Website tabs must not use the app preload or the `app-ui` partition.

---

## Tab architecture

Main owns all tab truth. The renderer receives only serializable `BrowserState`. `WebContentsView` and `webContents` never cross IPC.

```ts
type TabId = string;

interface BrowserTab {
  id: TabId;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: TabId;
}
```

`TabId` is a UUID (or equivalent opaque string) generated in main.

After the window is ready, `activeTabId` is always a real tab. Closing the last tab immediately replaces it (see lifecycle). Do not leave a zero-tab or null-active state.

| Concern | Owner | V0 behavior |
|---------|-------|-------------|
| Tab registry + metadata | Main | `TabRegistry` in `src/browser/` |
| `WebContentsView` instances | Main | `Map<TabId, WebContentsView>` in the Electron adapter; never serialized |
| Active tab identity | Main | `activeTabId`; only that view is attached to the window |
| Website lifecycle | Main | create, attach/detach, navigate, close, shutdown cleanup |
| Presentation | App UI renderer | `BrowserState` only |

The **tab list** is not restored across app restarts. Website **cookies/session** in `persist:website` may persist. No tab groups, mute, or pin.

### Tab-view lifecycle

#### Active tab

Only the active website `WebContentsView` is attached to the browser window’s content view and shown in the website-content region (below the fixed chrome). Main applies current bounds and may focus the view where appropriate.

#### Inactive tabs

When switching away from a tab:

- **Detach** its `WebContentsView` from the visible view hierarchy (`removeChildView` / equivalent). Do not leave it covering the chrome or the new tab.
- **Keep** its `WebContents` alive.
- **Preserve** its page and `persist:website` session state.
- Do **not** destroy, discard, or reload it merely because it became inactive.

When activating another tab:

1. Detach the previous active view.
2. Attach the selected tab’s view to `win.contentView`.
3. Apply current website-content bounds.
4. Focus the website view where appropriate.

Do **not** introduce tab eviction or suspension in V0.

#### Closing a tab

When a tab is actually closed:

1. If it is attached, detach it from the view hierarchy.
2. Explicitly `webContents.close()` (and drop the `WebContentsView` reference) so the renderer process is destroyed.
3. Remove it from the tab registry.
4. Update `activeTabId` deterministically:
   - If other tabs remain, activate a neighbor (prefer the tab to the right, else the last remaining tab).
   - If it was the **final** tab, create one new `about:blank` tab and activate it. Do not quit the app. Do not leave an empty tab strip.

Do not leak orphaned `WebContents`.

#### Final-tab behavior (locked)

```text
closing the final tab creates/replaces it with one new about:blank tab
```

No sophisticated new-tab page. `about:blank` plus an empty address bar is enough.

#### Launch and new tabs

- Launch: one tab navigating to `https://example.com`.
- User “new tab”: `about:blank`, focus the address bar.

#### Shutdown

When the browser window or application shuts down, main must:

- detach any attached website view
- explicitly close/destroy **every remaining** website `webContents`
- clear the tab registry

Electron does not always destroy `WebContentsView` contents when the window closes. Explicit cleanup is required.

---

## V0 BrowserAdapter

Implement **only** the shell surface. Put the interface in `src/browser/` (or `src/shared/` for the type, implementation in `src/browser/`). Application UI does **not** import the adapter; it uses IPC. Main calls the adapter.

```ts
interface BrowserAdapter {
  createTab(input?: { url?: string }): Promise<TabId>;
  closeTab(tabId: TabId): Promise<void>;
  activateTab(tabId: TabId): Promise<void>;

  navigate(tabId: TabId, url: string): Promise<void>;
  back(tabId: TabId): Promise<void>;
  forward(tabId: TabId): Promise<void>;
  reload(tabId: TabId): Promise<void>;

  getPageState(tabId: TabId): Promise<PageState>;
}

interface PageState {
  tabId: TabId;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}
```

`ElectronBrowserAdapter` is the V0 implementation. It is the **only** module that may touch website `WebContents` / `WebContentsView`.

**Do not add in V0:** `observePage`, DOM/AX snapshots, screenshots, `click`, `type`, `select`, `scroll`, `executeJavaScript`, `evaluate`, `runScript`, or business verbs (`purchase`, `sendEmail`, …).

Closed or unknown `tabId` → fail closed (throw or typed error). Do not no-op silently in a way that desyncs UI.

---

## URL / navigation policy

Address bar accepts:

```text
https://example.com
http://example.com
example.com
```

Normalization (`src/shared/`, pure function, unit-test this):

1. Trim whitespace.
2. Empty string → reject (no navigation).
3. If a parseable `http:` or `https:` URL → allow that origin/path/query/hash.
4. If it looks like a host (`localhost`, or a token containing a dot and no spaces) → prefix `https://` and parse.
5. Anything else (search queries, spaces, missing host) → **reject**. Do **not** implement search-engine fallback in V0.

**Denied from the address bar and from `navigate()`:** `file:`, `javascript:`, `data:`, `blob:`, `about:` other than `about:blank`, custom protocols, `chrome:` / `chrome-extension:`.

Denied navigations stay on the current page (or `about:blank` for a new tab) and set a chrome error string (`invalid URL` / `unsupported scheme`).

**In-page / renderer-initiated navigation** (redirects, links):

- `http:` / `https:` allowed in the website session.
- Other schemes: deny (`will-navigate` / `will-frame-navigate` as applicable). Do **not** `shell.openExternal` for arbitrary protocols.

**Redirects:** follow normal HTTP(S) redirects; the address bar tracks `webContents.getURL()` after navigation events.

**Load failure:** keep the tab; set `loading: false`; show a simple failure state in chrome (title/status). No custom error portal page required; a failed Chromium load plus chrome text is enough.

**Popups / `window.open` / `target=_blank`:** `setWindowOpenHandler` in main.

- HTTP(S) URL → `deny` the native window and `createTab({ url })` in the website session, then activate it.
- Other URLs → `deny`.
- Never grant an uncontrolled `BrowserWindow` to a page.

---

## Website security (implementation requirements)

Mandatory for every website `WebContentsView`:

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
webSecurity = true
webviewTag = false
```

No website preload in V0. No Node, no Electron primitives, no filesystem/process APIs, no IPC, no `BrowserAdapter`.

Install handlers on the **website** session (and on each tab `webContents` where the API is per-contents):

| Event / API | V0 behavior |
|-------------|-------------|
| `session.setPermissionRequestHandler` | **Deny all** (media, geolocation, notifications, midi, clipboard, idle-detection, etc.) |
| `session.setPermissionCheckHandler` | Deny |
| `setWindowOpenHandler` | HTTP(S) → new tab; else deny |
| `will-navigate` / frame navigations | Allow only `http:`, `https:`, and `about:blank` |
| `session.setDisplayMediaRequestHandler` if present | Deny / omit |
| `webContents` device/USB/serial/HID grants | Do not enable; deny if hooked |
| `session.on('will-download')` | `event.preventDefault()`; cancel; no auto-open; no execute. Optional chrome notice: downloads not supported in V0 |
| External protocols | Deny; never pass through to the OS automatically |
| Debugger attach | Do not attach because a page asked. V0 does not use CDP |

Application UI session: same hardening (`sandbox`, `contextIsolation`, no Node). It may only load the local chrome origin.

Do not disable `webSecurity` to “fix” mixed content or embedding.

Optional but recommended if the Forge template supports it without extra scope: Electron fuses that disable node CLI inspect and limit file-protocol privileges. Do not spend V0 on a fuse research project.

---

## Application IPC

Main is the only privileged peer. The app preload exposes a **fixed** API via `contextBridge`. No raw `ipcRenderer`, no generic `invoke`/`send`, no arbitrary channel names in the renderer.

### Renderer → main (invoke)

```text
getBrowserState
createTab
closeTab
activateTab
navigate
back
forward
reload
```

### Main → renderer (push)

One event is enough:

```text
browserStateChanged → BrowserState
```

Emit after tab create/close/activate and on navigation/title/loading/`canGo*` changes. Debounce only if event storms appear; do not add a framework.

### Preload contract (shape)

```ts
interface BrowserShellApi {
  getBrowserState(): Promise<BrowserState>;
  createTab(): Promise<TabId>;
  closeTab(tabId: TabId): Promise<void>;
  activateTab(tabId: TabId): Promise<void>;
  navigate(tabId: TabId, url: string): Promise<void>;
  back(tabId: TabId): Promise<void>;
  forward(tabId: TabId): Promise<void>;
  reload(tabId: TabId): Promise<void>;
  onStateChanged(listener: (state: BrowserState) => void): () => void;
}
```

Expose as `window.browserShell` (name is fixed). Types live in `src/shared/`.

### Sender validation

Every privileged handler must reject senders that are not the application-UI `webContents` (compare `event.sender` / frame URL / session partition to the app window). Website `webContents` must have **zero** registered handlers for these channels.

Channel names are an allowlist in main. Unknown channels are ignored.

---

## State flow

```text
Main process TabRegistry + adapter  =  source of truth
Application UI React state          =  presentation copy of BrowserState
```

- On chrome mount: `getBrowserState()`, then subscribe to `onStateChanged`.
- User actions call IPC; UI updates from the pushed `BrowserState`, not from optimistic Electron objects.
- The address bar may hold **local draft** text while focused; on submit, send `navigate`; on blur/navigation event, sync from `activeTab.url`.
- No Redux, no extra global store.

---

## Source layout

Create only what V0 needs. Do **not** create `src/agent/` or `src/actions/`.

```text
package.json
package-lock.json
forge.config.ts
tsconfig.json
webpack / Forge plugin config as required by the webpack-typescript template
.gitignore          (node_modules, .webpack, out, dist)

src/
  main/
    main.ts                 app lifecycle, security defaults
    window.ts               BrowserWindow + chrome bounds / resize
    ipc.ts                  typed handlers + sender checks
    security.ts             session permission / protocol / download hooks

  browser/
    types.ts                re-export or local adapter types if not all in shared
    tab-registry.ts         metadata + activeTabId
    electron-adapter.ts     WebContentsView map, navigation, BrowserAdapter impl

  preload/
    app-preload.ts          contextBridge for application UI only

  app-ui/
    index.html
    renderer.tsx            React mount
    App.tsx                 chrome: tabs + toolbar + address bar
    styles.css

  shared/
    browser-types.ts        TabId, BrowserTab, BrowserState, PageState
    ipc-contract.ts         channel names + BrowserShellApi
    navigation-url.ts       normalize/validate URL (pure)
```

Split `App.tsx` only if it becomes unwieldy (e.g. `TabStrip.tsx`). Do not pre-create empty component folders.

`src/browser/` must not be imported from `src/app-ui/`. `src/app-ui/` and `src/preload/` must not import Electron browser-control types (`WebContents`, `WebContentsView`). Shared modules must stay Electron-free.

---

## Styling

Deliberately basic:

- Light gray chrome, darker tab strip, white address field
- System font stack
- Disabled back/forward when `canGo*` is false
- Loading indicator: a thin bar or “Loading…” in the toolbar — not a spinner library

This is not the final visual design.

---

## Error handling

Keep failures local. No recovery framework.

| Case | Behavior |
|------|----------|
| Invalid / unsupported URL | No navigation; chrome shows a short error |
| HTTP(S) load failure | Tab remains; `loading: false`; chrome shows load error; URL still reflects attempted/current URL |
| Closed `tabId` | Adapter/IPC returns an error; UI refreshes from `getBrowserState` |
| Website renderer crash (`render-process-gone`) | Destroy that view; recreate a view for the same tab at `about:blank` or last URL; chrome shows “Page crashed” |
| App-UI renderer crash | Recreate the `BrowserWindow` chrome; restore views into the new window if still alive, or recreate the window + tabs from registry |
| Main process crash | Process exits; no special recovery |

Do not persist crash reports remotely.

---

## Logging

- `console` in main for navigation, denied permissions, denied protocols, downloads cancelled, IPC sender rejections.
- No telemetry, analytics, remote logging, or history upload.
- Do not log cookie values, credentials, or full form bodies.

---

## Implementation phases

### Phase 1 — Project / tooling scaffold

**Objective:** Electron Forge + Webpack + TypeScript + React app that starts an empty window on Windows.

**Likely files:** `package.json`, `package-lock.json`, `forge.config.ts`, `tsconfig.json`, webpack/Forge renderer config, `.gitignore`, `src/main/main.ts`, `src/app-ui/*` hello chrome, `src/preload/app-preload.ts`.

**Work:**

- Add npm + Forge webpack-typescript tooling at repo root without destroying existing docs/rules.
- Pin Electron 44.x and lockfile.
- Strict TypeScript. React in the app-ui renderer only.
- `npm start` launches a window loading local chrome (not a website).
- `.gitignore` for `node_modules`, Forge output (`.webpack`, `out`).

**Verification:** `npx tsc --noEmit` (or the project typecheck script); `npm start` shows a window.

**Done when:** A Windows developer can clone, `npm install`, `npm start`, and see application chrome with no remote page yet.

### Phase 2 — Secure window / runtime

**Objective:** Trust boundaries exist before tabs load the open web.

**Likely files:** `src/main/window.ts`, `src/main/security.ts`, session setup in `main.ts`.

**Work:**

- `BrowserWindow` with app-ui session + hardened `webPreferences` + app preload.
- Website session created and hardened even if unused until Phase 3.
- Deny-all permission handlers, download cancel, external protocol deny, `webviewTag: false`, `webSecurity: true`.
- Confirm app UI cannot be pointed at a remote URL as its document.

**Verification:** Inspect `webPreferences` and session wiring in code; launch; confirm chrome origin is local.

**Done when:** Two sessions exist (`app-ui` in-memory, `persist:website` persistent); app UI is sandboxed with the typed preload only; website session deny-by-default handlers are registered.

### Phase 3 — Tabs, adapter, navigation

**Objective:** Real website content in `WebContentsView`, controlled only through `BrowserAdapter`.

**Likely files:** `src/browser/*`, `src/shared/navigation-url.ts`, `src/main/window.ts` layout/resize.

**Work:**

- `TabRegistry` + `ElectronBrowserAdapter` with the V0 interface only.
- Launch tab → `https://example.com`.
- `navigate` / `back` / `forward` / `reload`.
- Popup → new tab for HTTP(S).
- Layout: only the active view is attached below fixed chrome height; resize handler; detach on deactivate; no eviction.
- Explicit `webContents.close()` on tab close and on window/app shutdown.

**Verification:** Typecheck; unit tests for `navigation-url`; manual load of example.com; denied `file:` / `javascript:` from `navigate()`.

**Done when:** Main can create/switch/close tabs and navigate without any React IPC yet (temporary main-only hooks or a minimal IPC stub is acceptable if it unblocks Phase 4). Prefer landing IPC in Phase 4 if that is cleaner; do not leave Electron objects in the renderer.

### Phase 4 — Browser chrome UI

**Objective:** Usable chrome: tabs, address bar, loading/title/URL, back/forward/reload.

**Likely files:** `src/app-ui/App.tsx`, `src/app-ui/styles.css`, `src/preload/app-preload.ts`, `src/main/ipc.ts`, `src/shared/ipc-contract.ts`.

**Work:**

- Typed preload API + sender-checked IPC.
- React chrome bound to `BrowserState`.
- Address bar draft vs committed URL.
- Tab strip: create, activate, close; closing the final tab replaces it with `about:blank`.
- Disabled back/forward; loading + title + URL display.

**Verification:** Manual smoke list in §Acceptance. Confirm website views are not using the app preload.

**Done when:** A user can perform the full V0 smoke flow from the UI.

### Phase 5 — Hardening + targeted verification

**Objective:** Invariants hold; obvious holes closed; V0 acceptance checklist executed.

**Likely files:** security handlers, IPC validation, tests, small bugfixes.

**Work:**

- Re-read architecture §4.2 against the implementation.
- Confirm no website IPC, no `executeJavaScript` tool, no AI modules.
- Renderer-crash path for a tab.
- `navigation-url` unit tests covering allow/deny cases.
- Manual Windows smoke test (below).
- Inspect the diff; remove stray template leftovers (Forge sample IPC, `nodeIntegration: true`, etc.).

**Verification:** Typecheck; URL unit tests; smoke test; diff review.

**Done when:** Acceptance criteria pass and security invariants are visible in code, not just in docs.

Do not add CI, installers, or E2E in Phase 5.

---

## Acceptance criteria

V0 is complete when all of the following are true on Windows:

1. App launches as a desktop window (`npm start`).
2. Application chrome renders (tabs + navigation + address bar).
3. Initial tab renders real website content in a `WebContentsView` (`https://example.com`).
4. Address bar can navigate to a second HTTP(S) URL (typed host or full URL).
5. Back works.
6. Forward works.
7. Reload works.
8. A second tab can be created.
9. Switching tabs attaches only the active `WebContentsView`; inactive tabs stay alive but detached.
10. A tab can be closed; `webContents` is destroyed; closing the last tab replaces it with one `about:blank` tab and does not quit the app.
11. Page title updates in chrome.
12. Displayed URL updates after navigation and redirects.
13. Website content has no Node / Electron / app-IPC / `BrowserAdapter` access (`nodeIntegration` false, sandboxed, no website preload, `app-ui` vs `persist:website`).
14. Unsupported schemes and permission/download/protocol requests fail closed.
15. No AI/agent/model code is present.

---

## Verification

```yaml
verification:
  mode: targeted
```

**Required for V0 completion (Phase 5):**

- TypeScript typecheck
- Unit tests for `normalize`/`validate` navigation URLs (allow `http`/`https`/host; deny `file`, `javascript`, search-like strings)
- Development launch smoke test on Windows (acceptance list above)

**Optional if already cheap (do not add a framework to enable them):**

- Targeted lint on edited files if the Forge scaffold includes ESLint
- A tiny unit test around last-tab-close / unknown `tabId` fail-closed behavior if it stays pure

**Do not run / do not add by default:**

- Docker, E2E (Playwright/Cypress/Spectron), CI workflows
- Full installer generation as a gate
- Cross-platform test matrix
- Full-repo lint/test “run everything” if more than the targeted commands above
- Deployment

A failed targeted check does not authorize broader suites, model escalation, or subagents.

---

## Chapters / phases

| Phase | Scope | Verification | Notes |
|-------|-------|--------------|-------|
| 1 | Forge + Webpack + TS + React scaffold | typecheck, `npm start` | Preserve existing docs/rules |
| 2 | Sessions, window, security handlers | code review of invariants, launch | Before open-web tabs |
| 3 | Adapter, WebContentsView tabs, navigation | URL tests, manual example.com | No AI methods |
| 4 | Chrome UI + typed IPC | manual smoke | Main remains source of truth |
| 5 | Hardening + acceptance | typecheck, URL tests, Windows smoke, diff | No CI/installers |

## Completion criteria

This **plan document** is complete when it is the single V0 implementation guide (this file).

The **V0 product** is complete when Phases 1–5 and the acceptance list succeed under a later implementation prompt that cites this locked plan.

---

## Intentionally deferred

- Electron major > 44
- pnpm, Vite, BaseWindow-only composition
- Search-engine address bar, bookmarks, history UI, downloads UX
- Tab discard/eviction, restoring the tab strip across restarts, profiles, incognito, cookie UI
- Persistent application-UI session (`persist:app-ui` is not used)
- CDP, page observation, screenshots, input automation
- Agent runtime, model providers, policy/approval UI
- macOS packaging, auto-update, code signing, CI
- Electron fuses beyond what the template gives for free
- Password manager, extensions, adblock

---

## Consistency

- **ADR-001:** Electron + `WebContentsView`; adapter above Electron; `BrowserView`/`webview` rejected; separate application-UI session from website content.
- **Architecture §4.2:** website invariants are implementation requirements in Phases 2–3; app UI and websites remain separate trust domains.
- **Sessions:** `app-ui` is non-persistent; `persist:website` is the only persistent browsing partition; neither is exposed to a future AI layer.
- **Tab lifecycle:** only the active website view is mounted; inactive tabs stay alive detached; close and shutdown explicitly destroy `webContents`.
- **browser-agent-safety.mdc:** V0 does not implement action levels; it must not collapse them later by giving the renderer unrestricted primitives.
- **AGENTS.md / execution.mdc:** Composer, no subagents, targeted verification, no implicit git/CI/deploy permissions on implementation of this plan.
- **BrowserAdapter:** V0 subset only; no observation, input automation, script tools, or business verbs.
- **No AI in V0.**
