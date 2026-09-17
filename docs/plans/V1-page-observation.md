# Plan: V1 — Page Observation

**Status:** locked  
**Explicit reference:** Implementation tasks must cite `docs/plans/V1-page-observation.md` to treat this file as authoritative.

This plan is implementation-ready for Composer. It does not reopen the accepted runtime or V0 security model. Authoritative architecture remains:

```text
docs/architecture/browser-architecture.md
docs/architecture/ADR-001-browser-runtime.md
docs/architecture/ADR-002-page-observation.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
docs/plans/V0-browser-shell.md
```

V0 is complete. This milestone adds **local OBSERVE infrastructure only**.

This is **not** architecture §13’s full “V1 AI can observe and navigate” product slice. It does not add an agent loop, model provider, or new navigation features.

---

## Objective

Give privileged main/browser code a way to produce a structured, serializable `PageObservation` of a website tab.

A future AI system should be able to consume that object and know:

- where the tab is (URL, title, loading, viewport, scroll)
- what is visible and meaningful
- which nodes are interactive, their roles, accessible names, and bounds
- how to name those nodes later (`targetId`) without receiving Electron/CDP objects
- what the visible page looks like (ephemeral screenshot)

Observation must be:

- structured and serializable
- bounded in size / token-efficient
- tied to a specific tab + document revision + observation id
- side-effect free at the product-semantics layer
- safe: no cookies, credentials, password values, or unrestricted script execution

V1 does **not** send observations to an LLM.

## Out of scope

Do not add any of the following:

- LLM SDKs, model providers, prompts, tool schemas, agent runtime
- INTERACT primitives: `click`, `type`, `select`, `scroll` as adapter methods
- PREPARE_ACTION, APPROVAL, EXECUTE
- `executeJavaScript`, `evaluate`, `runScript`, generic `sendCdpCommand`
- website preloads or injected page scripts
- MutationObserver / continuous observation / screenshot streaming
- pixel-only computer-use or OCR
- observation attached to `BrowserState` IPC events
- AI sidebar, redesigned chrome, settings, bookmarks
- `src/agent/`, `src/actions/`
- enabling `file:`, `data:`, `blob:`, or disabling `webSecurity` for fixtures
- CI, Docker, Playwright/Cypress, installers, macOS/Linux as required targets

If a later idea is useful for agent V1+, leave it as a deferred note. Do not scaffold unused modules.

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

Composer is the implementation model. Do not escalate. Do not use subagents. Do not commit or push unless a later prompt grants those permissions. Targeted verification only.

---

## Selected V1 observation strategy

**Hybrid structured + screenshot, via allowlisted CDP + Electron `capturePage()`.**

Rejected alternatives are recorded in ADR-002. Summary:

| Approach | V1 verdict |
|----------|------------|
| `executeJavaScript` | Rejected — execution primitive, CSP, weak iframe story |
| Injected preload | Rejected — breaks V0 website isolation |
| CDP AX + DOMSnapshot + layout | **Selected** structured path |
| AX only | Insufficient for layout/tag/targeting |
| Raw DOM | Token-hostile, weak semantics |
| Screenshot only | No targeting; OCR deferred |
| Hybrid structured + screenshot | **Selected** product shape |

Optimize for: security, arbitrary sites, future targeting, token efficiency, low page interference, adapter replaceability.

---

## Public API decision

Keep `BrowserAdapter` as the only browser-control surface, but **do not** implement CDP inside `electron-adapter.ts`.

```ts
interface BrowserAdapter {
  // existing V0 methods unchanged
  observePage(tabId: TabId, options?: ObservePageOptions): Promise<PageObservation>;
}
```

```ts
interface ObservePageOptions {
  includeScreenshot?: boolean; // default true for V1 local observe
}
```

`ElectronBrowserAdapter.observePage` resolves the tab’s `WebContents` and delegates to `ElectronPageObserver`.

Do **not** add to `BrowserAdapter` in V1:

```text
onStateChanged
subscribe
captureScreenshot
sendCdpCommand
executeJavaScript
click / type / select / scroll
```

Do **not** add observation methods to `BrowserShellApi` / app-ui IPC. Observation is main-only. Chrome stays the V0 tab/navigation UI.

A temporary main-process diagnostic for manual verification is allowed during implementation and **must be removed before completion** (same rule as V0 crash diagnostics).

---

## Source layout

Create only what this plan needs. Electron-free serializable types go in `shared/`. CDP/Electron stay out of `app-ui/` and `preload/`.

```text
src/shared/observation-types.ts      PageObservation, ObservationNode, errors, options
src/observation/page-observer.ts     PageObserver interface (Electron-free)
src/observation/cdp-client.ts        private allowlisted debugger wrapper
src/observation/electron-page-observer.ts
src/observation/observation-builder.ts
src/observation/target-registry.ts
src/observation/redaction.ts
src/observation/budgets.ts
```

Do not create `src/agent/` or `src/actions/`.

Do not put CDP types in `src/shared/`.

`src/browser/electron-adapter.ts` may import the observer. The observer may receive a `WebContents` only from the adapter. Shared modules and future agent code import `PageObservation` only.

If a file stays under ~150 lines of real logic, merging `redaction.ts` into the builder is acceptable. Do not create a framework.

### Fixture layout (dev/test only)

```text
fixtures/observation/index.html
fixtures/observation/iframe.html
scripts/observation-fixture-server.ts   Node http only, no Express
```

The fixture server binds `127.0.0.1` (not `0.0.0.0`) and is started only by explicit test/dev commands. It is not part of `npm start` product launch.

---

## Shared schema

Put these types in `src/shared/observation-types.ts`. Improve names if needed, but keep this information.

### Identifiers

```ts
type ObservationId = string;   // crypto.randomUUID() per observePage call
type TargetId = string;        // opaque UUID; never a CDP integer
type DocumentRevision = string;
type FrameId = string;         // opaque; may be derived from CDP frame id but not required to match it in the payload
```

### PageObservation

```ts
interface PageObservation {
  observationId: ObservationId;
  tabId: TabId;
  capturedAt: number; // Unix ms

  document: {
    revision: DocumentRevision;
    url: string;
    title: string;
    loading: boolean;
    mainFrameId: FrameId;
  };

  viewport: {
    width: number;
    height: number;
    scrollX: number;
    scrollY: number;
    deviceScaleFactor: number;
  };

  nodes: ObservationNode[];

  screenshot?: ObservationScreenshot;

  stats: {
    sourceAxNodeCount: number;
    sourceDomNodeCount: number;
    emittedNodeCount: number;
    truncated: boolean;
    redactedValueCount: number;
    frameCount: number;
    crossOriginFrameCount: number;
  };
}
```

### ObservationScreenshot

```ts
interface ObservationScreenshot {
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  encoding: 'base64';
  data: string;
}
```

JPEG is the V1 default (smaller than PNG for future model use). Do not write files. Do not include `NativeImage`. Do not put this object on `BrowserState`.

### ObservationNode

Keep nodes compact. Do not mirror the DOM API.

```ts
interface ObservationNode {
  targetId?: TargetId;   // present only when future DOM resolution is sound
  frameId: FrameId;

  role: string;
  name?: string;
  value?: string;
  text?: string;
  tag?: string;

  interactive: boolean;
  visible: boolean;
  inViewport: boolean;

  states?: {
    disabled?: boolean;
    focused?: boolean;
    checked?: boolean | 'mixed';
    selected?: boolean;
    expanded?: boolean;
    editable?: boolean;
    secret?: boolean;
  };

  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  attributes?: Record<string, string>;
}
```

Field purpose:

| Field | Why a future model needs it |
|-------|-----------------------------|
| `targetId` | Later `click`/`type` without CDP integers; omitted when no reliable DOM target |
| `frameId` | Do not flatten frames; targeting is frame-scoped |
| `role` / `name` | Semantic targeting (“Submit”, button) |
| `value` | Current control value when allowed |
| `text` | Visible text when distinct from name |
| `tag` | Distinguishes `a` / `button` / `input` |
| `interactive` | Action candidates |
| `visible` / `inViewport` | Pruning and “what the user sees” |
| `states` | Disabled/checked/expanded/secret |
| `bounds` | Spatial reasoning + screenshot alignment |
| `attributes` | Tiny allowlist (`type`, `href`, `placeholder`, `autocomplete`) |

Omit empty optional fields rather than sending `undefined` noise if serialization is custom; JSON.stringify already drops `undefined`.

Do **not** include: child arrays (flat list in document order), computed style dumps, HTML, classLists, event listeners, cookies.

---

## Element identity

This is a targeting foundation. V1 does not click.

```text
targetId  (opaque, observation-scoped)
    → TargetRegistry
        tabId
        observationId
        documentRevision
        frameId
        backendNodeId      (CDP, internal only)
        axNodeId           (CDP, internal only, optional)
```

Rules:

1. `observationId` is generated in privileged code via `crypto.randomUUID()` for every `observePage` call.
2. `targetId` is assigned only where backend DOM identity can be joined reliably. Semantic-only AX nodes may omit `targetId`.
3. CDP `backendNodeId` / `axNodeId` never appear on `PageObservation`.
4. The registry keeps **one live map per tab**: the latest successful observation. No observation history storage.
5. A `targetId` is valid only within the observation that produced it. `targetId` alone is never sufficient authority.
6. Future interaction must validate all of:
   - tab still exists
   - `observationId` matches the tab’s current target registry
   - `documentRevision` still matches the live page
   - frame/document still exists
   - backend DOM identity still resolves in the live document
7. If the DOM changed inside the same loader and the backend node no longer resolves: fail stale / target not found. Do not retarget by text, CSS selector, label, DOM position, or coordinates.
8. Taking a new successful observation **replaces** the previous registry for that tab.
9. Main-frame document revision change, tab close, renderer crash, and adapter/observer disposal **clear** the registry.

Do not try to keep IDs stable across SPA mutations in V1. The intended loop is:

```text
observe → reason → (later) act using this observation’s targetIds → observe again
```

---

## Document revision / staleness

V1 revision is **document replacement**, not every DOM mutation.

```text
documentRevision = `${mainFrameId}:${loaderId}`
```

Source: `Page.getFrameTree` — current main frame `frame.id` + `frame.loaderId`. If a usable main-frame `loaderId` cannot be obtained during collection, fail `PAGE_NOT_READY`. Do not invent a fallback revision from URL, timestamps, or navigation history.

Changes when:

- main-frame cross-document navigation commits
- reload
- renderer crash (new `WebContents` even if same `tabId`)
- document replacement

Does **not** change on:

- scroll
- hover
- same-document SPA/hash/history updates
- title-only changes
- loading flag changes while `loaderId` is unchanged

This behavior is intentional for V1.

### Page readiness

Before CDP collection, verify the tab/`webContents` is usable:

- tab exists and is not disposed
- `webContents` is not destroyed
- `Page.getFrameTree` returns a main frame with a usable `loaderId`

Do not begin observation in an unusable transitional state. Do not use arbitrary sleeps. Electron may defer CDP commands until navigation completes; bounded readiness checks prevent hanging on missing frame/document identity.

Page loading and in-flight network requests are **not** blockers. Normal dynamic pages must remain observable once frame/document identity is available.

### Observation consistency

Read document identity at least:

```text
before structured collection
after structured + screenshot collection
```

Pipeline:

1. Read `revisionBefore` (after readiness passes)
2. Collect AX + snapshot + layout (+ screenshot)
3. Read `revisionAfter`
4. If `revisionBefore !== revisionAfter`, **discard** the entire result and fail `PAGE_CHANGED_DURING_OBSERVATION`
5. If they match, commit registry + return

Also fail closed if the tab closes, renderer crashes, or the observer is disposed during collection. Never return an observation assembled from two documents or partial data after debugger detach.

Dynamic SPAs: two observes of the same URL may share a revision while the DOM differs. That is accepted. Future interaction must resolve `backendNodeId` against the live document and fail closed if the node is gone. V1 only stores the mapping.

Each observation has a unique `observationId` even when revision is unchanged.

---

## CDP transport

Private module: `src/observation/cdp-client.ts`.

Electron API: `webContents.debugger`.

```ts
type AllowedCdpMethod =
  | 'Accessibility.enable'
  | 'Accessibility.getFullAXTree'
  | 'DOMSnapshot.captureSnapshot'
  | 'Page.getLayoutMetrics'
  | 'Page.getFrameTree';
```

The send function accepts `AllowedCdpMethod` only. Do not take `command: string`. Do not define `sendCommand(command: string, params?: unknown)` on `BrowserAdapter`, `PageObserver`, shared types, IPC, or future model tools.

Explicitly forbidden (non-exhaustive): `Runtime.evaluate`, `Runtime.callFunctionOn`, `Page.navigate`, `Page.reload`, `DOM.setAttributeValue`, `DOM.setOuterHTML`, `Input.*`, `Network.set*`, `Storage.*`, `Page.setBypassCSP`. Additional commands require an explicit allowlist change in the observation implementation.

Protocol version: `'1.3'`.

### Lifecycle (locked)

**Attach for the observation, detach if this call attached.** No long-lived debugger owner. No automatic mid-observation retry after detach.

**Before starting:**

| Check | Result |
|-------|--------|
| Tab unknown / closed / disposed | `TAB_NOT_FOUND` |
| `webContents` destroyed | `TAB_NOT_FOUND` or `PAGE_NOT_READY` |
| Another observation in flight for same tab | `OBSERVATION_IN_PROGRESS` |
| `debugger.isAttached()` and not owned by this observation (typically DevTools open) | `CDP_UNAVAILABLE` — do not steal or detach |

**During observation:**

```text
attach('1.3') only if not already attached
register debugger 'detach' listener
try
  readiness check (frame tree + loaderId)
  revisionBefore = documentRevision
  Accessibility.enable
  Page.getFrameTree
  Page.getLayoutMetrics
  Accessibility.getFullAXTree
  DOMSnapshot.captureSnapshot
  webContents.capturePage()   // Electron, not CDP screenshot
  revisionAfter = documentRevision
  if revisionBefore !== revisionAfter → discard all, PAGE_CHANGED_DURING_OBSERVATION
finally
  remove observation listeners
  detach only if this observation attached and debugger still attached
```

If debugger `detach` fires unexpectedly (including DevTools opening while this observation owns the debugger), invalidate the observation and fail `CDP_UNAVAILABLE`. Do not return partial AX/DOM/layout data after detach.

`about:blank` is observable. Set `document.loading` from `isLoading()`; loading is not a readiness blocker.

### Concurrent observations

Maximum **one in-flight observation per tab**.

A second concurrent `observePage` for the same tab fails `OBSERVATION_IN_PROGRESS`. Do not share Promises. Do not build a global observation queue.

Different tabs may observe independently in parallel.

---

## Accessibility strategy

Call `Accessibility.enable` then `Accessibility.getFullAXTree`.

**Why full tree:** one round trip; V1 will prune anyway. Partial AX (`getPartialAXTree`, `getChildAXNodes`) needs walk/round-trips and is easier to get wrong.

**Use:**

- `role`
- `name`
- `value` (then redact)
- `description` only if name is empty (copy into `name` or `text`, do not add a fourth string by default)
- boolean / tristate states: `disabled`, `focused`, `checked`, `selected`, `expanded`, `editable`, `hidden`, `focusable`
- `backendDOMNodeId` for joining to snapshot (internal)
- `ignored` → drop unless needed to reach a useful descendant (prefer drop)

**Do not serialize** the rest of AX properties automatically.

AX is the **primary semantic source**. Interactive classification:

```text
interactive if role in {
  button, link, textbox, searchbox, combobox, listbox, checkbox,
  radio, switch, slider, tab, menuitem, treeitem, spinbutton
}
or AX focusable/editable
or snapshot tag in { a, button, input, select, textarea }
or contenteditable
```

Disabled controls remain in the catalog when visible; `states.disabled = true`.

---

## DOMSnapshot / layout strategy

Call `DOMSnapshot.captureSnapshot` with the smallest useful config:

```text
computedStyles: ['display', 'visibility', 'opacity']   // visibility only
includePaintOrder: false
includeDOMRects: true
includeBlendedBackgroundColors: false
includeTextColorOpacities: false
```

Do not add broad CSS collection. Do not collect all computed styles. DOMSnapshot is **not** a DevTools DOM inspector.

DOMSnapshot is used for:

- structural identity
- backend node identity
- tag/attribute context
- text/document ordering where useful
- layout/bounds where available
- joining to accessibility information

Join AX ↔ snapshot on `backendDOMNodeId` when available. AX nodes without a reliable DOM join may still be emitted for semantics but must not receive a `targetId`.

Viewport + scroll from `Page.getLayoutMetrics`, preferring CSS-pixel fields when available:

```text
cssLayoutViewport
cssVisualViewport
cssContentSize
```

Use these for viewport size, scroll/page offsets, and in-viewport determination. Convert snapshot rects into **CSS viewport coordinates** consistent with the screenshot (origin = visible viewport top-left). Document the coordinate space in a code comment on `bounds`.

`inViewport` if the bounds intersect the viewport with a positive area.

`visible` if not AX-hidden, not `display:none` / `visibility:hidden`, opacity not 0, and width/height > 0. Off-screen nodes can be `visible: true, inViewport: false`.

---

## Cross-origin iframes

Do not assume the top-level DOM contains everything the user sees.

V1 behavior:

| Frame | Observation |
|-------|-------------|
| Main frame | Full AX + snapshot join, pruned |
| Same-origin iframe | Include inner nodes; every node has `frameId` |
| Cross-origin / OOPIF | Emit bounded frame/placeholder context: role `iframe` (or AX equivalent), bounds, `name` if any, `attributes.src` if present. Do **not** claim interior observation. Full cross-origin iframe support is **not** a V1 completion gate |

`stats.frameCount` / `stats.crossOriginFrameCount` make the limitation explicit.

Do not flatten frames into a single anonymous list without `frameId`.

Do not inject into child frames. Do not weaken site isolation.

---

## Shadow DOM

Not a V1 blocker.

- Open shadow: include whatever AX + DOMSnapshot already expose.
- Closed / user-agent shadow: omit interiors; the host node may still appear.

Do not pierce closed shadow with script. Preserve `backendNodeId` internally on host nodes so later work can improve this.

---

## Visibility and prioritization

Default observation is **not** the full page.

Include, in document order, after filtering ignored/invisible-uninteresting nodes:

1. Visible interactive elements in the viewport
2. Focused or editable controls
3. Headings (`h1`–`h3` / AX heading) in the viewport
4. Visible meaningful text in the viewport (skip whitespace-only)
5. Landmarks/navigation (`main`, `navigation`, `form`, `search`, `banner`) in the viewport — compact
6. Relevant near-viewport content (100px margin) if budget remains
7. Lower-priority structural context if budget remains

Secret/password **presence** (structure only, no value) is retained within the above tiers when visible.

Drop by default:

- `display:none` / AX ignored / zero-size
- huge repeating navigation dumps once over budget
- script/style/meta/head internals

Deterministic. No ML, no embeddings.

When over budget: keep higher-priority nodes, preserve relative document order of survivors, set `stats.truncated = true`.

---

## Token / size budgets

Configurable **code constants** in `src/observation/budgets.ts`. Not user settings. Not env spaghetti.

V1 defaults:

| Budget | Default | Notes |
|--------|---------|--------|
| `maxEmittedNodes` | 400 | Enough for a dense viewport, not a whole site |
| `maxTextCharsPerNode` | 200 | Truncate with no ellipsis requirement; just slice |
| `maxTotalTextChars` | 12_000 | Sum of name + value + text after per-node caps |
| `maxAttributesPerNode` | 4 | From the allowlist, first-N stable key order |
| `maxAttributeValueChars` | 200 | Truncate hrefs |
| `nearViewportMarginPx` | 100 | |
| `screenshotMaxLongestEdge` | 1280 | Downscale before encode |
| `screenshotJpegQuality` | 70 | Electron `NativeImage` quality 0–100 |
| `maxScreenshotBase64Chars` | 400_000 | If still over, downscale again once; then omit screenshot and keep structured nodes |

Attribute allowlist (only these keys, and only if present):

```text
type
href
placeholder
autocomplete
alt
```

`role`/`name` already live on the node. Do not copy `class`, `style`, `id`, `srcset`, `d`, `viewBox`.

If any budget cap causes useful data to be dropped, `stats.truncated = true`. Retain source/emitted counts in `stats`. Do not silently truncate.

---

## Sensitive data

V1 is local, but design the **future remote-model boundary now**.

Never collect:

- cookies
- localStorage / sessionStorage
- HTTP auth headers
- browser credential APIs
- password **values**

### Field policy (V1 local observation)

```text
structural presence may be observed
secret values must not
```

| Control | Emit structure | Emit value |
|---------|----------------|------------|
| `input[type=password]` | yes, `states.secret = true` | **never** |
| autocomplete `cc-*`, `cvv`, `new-password`, `current-password`, `ssn` | yes, `secret` | **never** |
| name/id/placeholder matching `/password\|card\|cvv\|ssn\|cvc/i` | yes, `secret` | **never** |
| `input[type=email\|tel]` | yes | truncated value, no `secret` flag in V1 |
| other inputs, textarea, select, contenteditable | yes | truncated value |
| visible text nodes | yes | truncated text |

Redaction happens in `redaction.ts` **before** nodes are emitted. Count replacements in `stats.redactedValueCount`.

Structured observation redaction does **not** guarantee screenshot redaction.

A viewport screenshot may contain password-like text, emails, personal data, account balances, private messages, or other visible sensitive content. V1 remains local and may capture what the user can visibly see. Do not OCR. Do not add a DLP compositor.

Future remote-model export must treat screenshots as raw potentially sensitive page content and pass through a separate model/export policy boundary. Do not build that export/DLP system in V1.

Implementation comment must state:

```text
local observation screenshot may contain on-screen secrets
future model export must be separately gated
```

---

## Screenshot strategy

Use `webContents.capturePage()` on the tab’s website `WebContents`.

| Decision | V1 choice |
|----------|-----------|
| Region | Visible viewport only (the `WebContentsView` compositor), not full-page stitch |
| Format | JPEG, quality 70, longest edge ≤ 1280 |
| Storage | In-memory only; never write to disk; no history |
| Inactive tabs | Allowed — V0 keeps inactive `WebContents` alive |
| Minimized/hidden window | Best-effort; if capture fails, omit screenshot and still return nodes (`truncated` if screenshot was requested) |
| OCR | No |
| Default `includeScreenshot` | `true` for local V1 `observePage` |

Convert `NativeImage` → JPEG buffer → base64 inside the observer. `NativeImage` must never cross the observation boundary. Shared types see only `ObservationScreenshot`.

Do not add `Page.captureScreenshot` to the CDP allowlist. Do not write screenshots to disk, store screenshot history, or send screenshots through `BrowserState`. Observation owns screenshot lifetime.

---

## Errors

Small closed set. Throw a typed error (`ObservationError`) with `code`. Do not leak Electron/CDP objects, stacks into UI (there is no observation UI), or page HTML.

```ts
type ObservationErrorCode =
  | 'TAB_NOT_FOUND'
  | 'PAGE_NOT_READY'
  | 'CDP_UNAVAILABLE'
  | 'PAGE_CHANGED_DURING_OBSERVATION'
  | 'OBSERVATION_IN_PROGRESS'
  | 'OBSERVATION_FAILED';
```

| Code | When |
|------|------|
| `TAB_NOT_FOUND` | Unknown/closed tab, disposed adapter |
| `PAGE_NOT_READY` | No frame tree / destroyed contents before observe |
| `CDP_UNAVAILABLE` | Debugger already attached, attach failed, detached mid-flight |
| `PAGE_CHANGED_DURING_OBSERVATION` | Revision changed during collection |
| `OBSERVATION_IN_PROGRESS` | Second concurrent observe for the same tab |
| `OBSERVATION_FAILED` | Command/capture/builder failure |

Unknown tab continues to use existing `TabNotFoundError` **or** maps to `TAB_NOT_FOUND`. Pick one mapping in the adapter and keep it consistent.

---

## Browser-agent safety

V1 adds **OBSERVE** only.

Observation must not click, type, submit, modify DOM, alter storage, navigate, handle dialogs, or grant permissions.

`Accessibility.enable` is internal instrumentation.

Do not use observation as a back door to INTERACT.

Preserve V0 website invariants:

```text
partition: persist:website
nodeIntegration: false
contextIsolation: true
sandbox: true
webSecurity: true
webviewTag: false
no preload
```

---

## Browser UI

No chrome redesign. No sidebar. No permanent “Observe” product control.

Verification should prefer:

- pure unit tests on builder / redaction / budgets / target registry
- local HTTP fixture pages
- a temporary main diagnostic only if manual Electron verification needs it, removed before plan completion

---

## Local deterministic fixtures

V0 smoke testing hit `ERR_NAME_NOT_RESOLVED` for public DNS. V1 must not depend on the public internet.

Add a **dev/test-only** Node `http` server on `127.0.0.1` serving `fixtures/observation/`.

V0 already allows `http://localhost` / `http://127.0.0.1` via `normalizeNavigationUrl`. Do not add `file:` or `data:`.

Fixture page content (single HTML file plus a same-origin iframe page):

- heading (`h1`)
- paragraph text
- link
- button
- text input
- password input (pre-filled in HTML to prove redaction)
- checkbox
- select
- textarea
- disabled control
- off-screen element (`position` far below viewport)
- same-origin iframe (`iframe.html` with a button)

Do not copy production websites. Do not add Express/Fastify.

The fixture is for observation tests and optional manual `navigate('http://127.0.0.1:<port>/')`. It is not a product new-tab page.

---

## Testing strategy

Keep existing:

```text
npm run typecheck
npm run test:url
npm run test:tabs
```

Add focused Node + `tsx` tests (no Jest/Vitest):

```text
npm run test:observation
```

covering pure functions only:

- pruning / priority / document order
- text and attribute truncation + `truncated: true`
- target registry replace-on-observe and revision mismatch
- password / cc-like value redaction
- serialization contains no `backendNodeId` / Electron types

Runtime/manual (Phase 5):

- load fixture over localhost
- headings, link, button, form controls present in `nodes`
- password node exists with `secret` and no value
- off-screen node not required in default viewport set
- screenshot present, JPEG, bounded size
- iframe placeholder or same-origin inner button, with `frameId`
- navigate during observe → `PAGE_CHANGED_DURING_OBSERVATION` if feasible
- DevTools open → `CDP_UNAVAILABLE` if feasible; otherwise code-inspect

Do not add Playwright. Do not weaken website security to make tests easier.

---

## Implementation phases

### Phase 1 — Types, identity, budgets, redaction (pure)

**Objective:** Serializable schema and pure helpers exist; no CDP yet.

**Work:**

- `src/shared/observation-types.ts`
- `src/observation/page-observer.ts` interface
- `src/observation/budgets.ts`
- `src/observation/redaction.ts`
- `src/observation/target-registry.ts`
- `src/observation/observation-builder.ts` accepting already-normalized candidate nodes
- `observePage` added to `BrowserAdapter` type; Electron adapter may `throw` “not implemented” only until Phase 2 — prefer not to ship a stub on `npm start` paths. If the method is on the interface, implement a clear `OBSERVATION_FAILED` until wired, **or** land Phase 1+2 together. Prefer landing the method as a real delegation that fails `CDP_UNAVAILABLE`/`OBSERVATION_FAILED` only when actually called.

**Verification:** `test:observation` for registry, redaction, budgets, builder. `typecheck`.

**Done when:** Types compile; pure tests pass; no Electron in `shared/`.

### Phase 2 — CDP transport + lifecycle

**Objective:** Allowlisted debugger attach/detach around one tab observe.

**Work:**

- `src/observation/cdp-client.ts`
- `src/observation/electron-page-observer.ts` attach, allowlisted commands, revision before/after, per-tab mutex
- `ElectronBrowserAdapter.observePage` delegates; still the only module that looks up `WebContents`
- Clear target registry on close/crash/dispose (hook crash recovery and `closeTab` / `dispose`)

**Verification:** typecheck; code inspection of allowlist; no generic send API.

**Done when:** Observer can attach, run allowlisted commands, detach, and fail closed on DevTools-attached / destroyed contents.

### Phase 3 — AX + DOMSnapshot normalization

**Objective:** Real `nodes[]` from AX + snapshot join.

**Work:**

- Parse `getFullAXTree` + `captureSnapshot` + `getLayoutMetrics` + `getFrameTree`
- Join on backend node id
- Frame attribution
- Same-origin iframe interiors; cross-origin placeholder
- Shadow: natural exposure only
- Feed candidates into the builder

**Verification:** fixture page unit-like snapshots of parsed fixtures if pure parsing can be tested with recorded JSON **or** manual localhost observe. Prefer a checked-in **small** synthetic AX/snapshot fixture JSON for parser tests rather than live Electron in unit tests.

**Done when:** Builder emits compact nodes with `targetId`, roles, bounds, `frameId`.

### Phase 4 — Screenshot + budgets applied end-to-end

**Objective:** `capturePage` JPEG + truncation stats.

**Work:**

- Viewport capture, downscale, JPEG, base64
- Apply budgets on live assembled candidates
- `includeScreenshot: false` skips capture
- Omit screenshot on capture failure without failing the whole observation

**Verification:** screenshot object shape; size cap; `NativeImage` does not escape the observer.

**Done when:** `PageObservation` can include a bounded JPEG and always includes structured nodes.

### Phase 5 — Fixtures, hardening, acceptance

**Objective:** Deterministic localhost verification; leftovers removed; V0 invariants intact.

**Work:**

- Fixture server + HTML
- Hook registry invalidation on crash replacement (same `tabId`, new revision)
- Remove temporary diagnostics
- Confirm no model/AI/IPC chrome
- Confirm website views still have no preload
- Manual Windows observe of fixture + `about:blank`

**Verification:** typecheck; `test:url`; `test:tabs`; `test:observation`; targeted `npm start` fixture navigation if DNS still fails for example.com.

**Done when:** Acceptance list below passes and this plan is marked `complete` by a later implementation prompt.

Do not add CI, installers, or E2E frameworks.

---

## Acceptance criteria

V1 observation is complete when all of the following are true on Windows:

1. `observePage(tabId)` returns a serializable `PageObservation` with no Electron/CDP objects.
2. Nodes include roles, names, interactive flags, and bounds for fixture controls.
3. Password values are absent; password node is present with `secret`.
4. `targetId`s are opaque; a registry maps them internally.
5. Navigation/reload/crash invalidates prior targets/revision.
6. Revision change during collection fails `PAGE_CHANGED_DURING_OBSERVATION`.
7. Screenshot is viewport JPEG in memory, optional, not in `BrowserState`.
8. Cross-origin iframe interiors are not silently claimed; frame ids exist.
9. Budgets set `truncated` when hit.
10. No website preload, no `executeJavaScript` tool, no generic CDP API, no model calls.
11. V0 tab/navigation behavior is unchanged.
12. Existing URL and tab tests still pass.

---

## Verification

```yaml
verification:
  mode: targeted
```

Required for implementation completion (later prompt):

- TypeScript typecheck
- Existing `test:url` and `test:tabs`
- New `test:observation` pure tests
- Development launch + localhost fixture observe (acceptance list)

Do not run by default: Docker, E2E, CI, installers, cross-platform matrix, npm audit campaigns, Electron major upgrades.

Network/DNS limitation: public `example.com` failure is not an observation failure. Use the local fixture.

---

## Chapters / phases

| Phase | Scope | Verification | Notes |
|-------|-------|--------------|-------|
| 1 | Types, registry, redaction, budgets | `test:observation`, typecheck | No CDP |
| 2 | Allowlisted CDP lifecycle | typecheck, inspect allowlist | Attach per observe |
| 3 | AX + DOMSnapshot join | parser tests / fixture | Frame ids |
| 4 | Screenshot + live budgets | typecheck, size checks | JPEG, in-memory |
| 5 | Fixtures + hardening | typecheck, all targeted tests, manual | No AI |

---

## Intentionally deferred

- Agent loop, tool schemas, model export, remote redaction policy enforcement
- `click` / `type` / `select` / `scroll` (use target registry in V2+)
- Separate `captureScreenshot` adapter method
- App-ui IPC for observation
- Long-lived CDP sessions
- SPA mutation-level revision
- Closed-shadow piercing
- Full cross-origin iframe interiors
- Full-page screenshots, PNG product default, screenshot history
- Pixel computer-use
- DLP / sensitive-page classifier
- Continuous observe
- Playwright as a dependency
- Electron > 44

---

## Consistency

- **ADR-001:** Electron + `WebContentsView` unchanged; adapter still the control surface.
- **ADR-002:** CDP hybrid observation, allowlist, per-observe attach, opaque targets.
- **Architecture §4.2 / V0:** website isolation unchanged; no website IPC.
- **Architecture §7:** `observePage` belongs on `BrowserAdapter`; implementation lives beside it, not in React.
- **Architecture §10:** AX-first catalog + screenshot; exact schema now this plan.
- **browser-agent-safety.mdc:** OBSERVE only; do not collapse into INTERACT/EXECUTE.
- **AGENTS.md / execution.mdc:** Composer, no subagents, targeted verification, no implicit git/CI/deploy permissions on implementation of this plan.
- **No AI in this V1 observation milestone.**
