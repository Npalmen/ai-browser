# AI Browser — Phase 0 Architecture

**Status:** accepted for the first implementation phase  
**Date:** 2026-09-17  
**Scope:** architecture and technical decisions only. No product implementation is authorized by this document.

This document establishes the architecture for V0/V1 implementation. It is the working architecture unless a later ADR supersedes it.

---

## 1. Architecture decision

**Start with Electron as the desktop shell and Chromium runtime, TypeScript as the application language, and `WebContentsView` for remote website tabs.**

The V1 product is a local desktop browser with a separate application UI, a privileged main process, a small `BrowserAdapter` over Electron, a separate agent runtime, and an explicit action/permission/approval engine.

```text
Electron
+ Chromium provided by Electron
+ TypeScript
+ WebContentsView for untrusted website tabs
+ separate application-UI WebContents
+ privileged main process
+ strict IPC for renderer ↔ main only
+ BrowserAdapter as the only browser-control surface
+ agent runtime that never holds Electron objects
+ action / permission / approval engine that grants authority
```

This is a **starting architecture**, not a claim that Electron is the long-term browser engine. Agent policy, approval, and observation must remain independent of Electron so deeper Chromium integration can replace the adapter later without rewriting those systems.

**Do not give the AI unrestricted browser primitives.** Authority is determined by semantic effect, not by whether the low-level call is `click`, `type`, or `navigate`.

---

## 2. Alternatives considered

### 2.1 Electron + `WebContentsView` — selected

Electron already ships a maintained Chromium, a desktop windowing model, Windows and macOS packaging, and process isolation that can host:

- one privileged main process
- one trusted application-UI renderer
- one sandboxed renderer per website tab

`WebContentsView` is the current Electron composition primitive for in-window tabs. `BrowserView` is deprecated. The `<webview>` tag is rejected: it is a weaker isolation model and is the wrong tab host for this product.

**Fit for this product:** fastest path to a real desktop browser that can open arbitrary sites, own tabs, capture page state, and mediate AI actions — while remaining a TypeScript codebase a small team can ship.

### 2.2 Chromium fork — rejected for V1

A Chromium fork (or a `//chrome` / `//content` embedder maintained as a fork) gives the most control: compositor-level screenshots, custom accessibility, process model changes, and browser-native AI integration.

It is the wrong V1:

- months of work before a usable window with tabs
- ongoing Chromium update burden (moving toward a two-week milestone cadence)
- C++/build-system expertise the current team should not take on to reach V1
- almost none of that control is required to prove observe → navigate → interact → approval → execute

**Revisit later** if Electron cannot provide reliable targeting, observation, or site compatibility that the product needs. See §13 and ADR-001.

### 2.3 CEF (Chromium Embedded Framework) — rejected for V1

CEF embeds Chromium in a native host without Node.js. That is attractive for security and for a future native shell. It is a poor V1 for this team:

- C++ host and tooling cost
- slower path to application UI, packaging, and agent integration
- more control than Electron, but still not a full browser fork
- the extra control does not unlock the V1 AI architecture

CEF remains a plausible **later adapter** (`ChromiumBrowserAdapter`) if Electron’s embedding model becomes the limiter and a full fork is still too expensive.

### 2.4 Chrome/Chromium extension — rejected as the product

A Manifest V3 extension (with or without native messaging) can observe and automate the user’s existing Chrome. It cannot be this product:

- Chrome owns tabs, sessions, profile, and permissions
- MV3 limits background lifetime and privileged APIs
- the app cannot present a first-class approval shell or trust boundary
- website compatibility is Chrome’s, but product control is not

A later `RemoteBrowserAdapter` may talk to an installed Chrome via CDP for debugging or a companion mode. That is not the desktop browser.

### 2.5 Other architectures considered

| Option | Verdict |
|--------|---------|
| Playwright / Puppeteer driving installed Chrome | Excellent automation library; not a browser. No owned chrome, weak product identity, session UX belongs to Chrome. May inform observation/targeting design. Not the runtime. |
| Tauri + OS webview (WebView2 / WKWebView) | Fast native shell, inconsistent engines across OS, weaker automation/observation control, macOS engine divergence. Rejected for an AI browser that must behave like Chromium everywhere it ships. |
| Windows WebView2-only native app | Windows-only; delays macOS; does not reduce AI-architecture work. Rejected as the primary runtime. |
| Qt WebEngine | Chromium-based but C++/Qt-centric; no advantage over Electron for this team. |

No materially better V1 architecture was identified. The realistic choice is Electron now, with an adapter boundary that keeps a Chromium-native future possible.

---

## 3. Rationale

Optimize for a small team shipping a capable V1, while preserving a route to a much more sophisticated AI browser.

| Criterion | Electron + WebContentsView | Chromium fork | CEF | Extension |
|-----------|----------------------------|---------------|-----|-----------|
| Implementation complexity | Low–medium | Extreme | High | Low, but product-wrong |
| Speed to first usable browser | Fast | Very slow | Slow | Fast (not a browser) |
| Control over Chromium | Limited | Maximum | Medium | None |
| Arbitrary website compatibility | High (Electron Chromium, some lag) | Highest | High | Highest (host Chrome) |
| Tab/session control | Sufficient | Maximum | Sufficient | Insufficient |
| DOM / AX / screenshots | Sufficient via CDP + Electron APIs | Best | Strong | Partial, MV3-limited |
| Automation / AI actions | Sufficient if CDP-based | Best | Strong | Partial |
| Isolation of untrusted content | Strong if configured correctly | Strong | Strong | Chrome’s model |
| Security model | Powerful and easy to get wrong | Harder, more control | No Node in renderers | Extension + Chrome |
| Permissions / approval UX | First-class in our shell | First-class | First-class | Constrained |
| Maintainability for small team | High | Low | Medium–low | High |
| Update burden | Electron releases | Chromium cadence | CEF cadence | Chrome |
| Windows | Strong | Strong, costly | Strong | Strong |
| Eventual macOS | Strong | Strong, costly | Strong | Strong |
| Packaging | Known | Heavy | Heavy | N/A (store/extension) |
| Later deeper Chromium control | Via adapter replacement | Already there | Via adapter | Dead end |
| V1 technical debt | Acceptable if Electron types stay out of agent/policy | Time-to-market debt | Language/tooling debt | Product-architecture dead end |

Electron wins on time-to-V1 and team fit. The debt is acceptable **only if** Electron objects, `executeJavaScript`, and renderer IPC never become the agent’s API.

---

## 4. Trust boundaries

Treat every website as untrusted. Treat remote model providers as untrusted data recipients. Treat the application UI as less trusted than main, but far more trusted than web content.

```text
┌─────────────────────────────────────────────────────────────┐
│ Main process (trusted computing base)                       │
│  window/tab lifetime, BrowserAdapter impl, policy,          │
│  approval decisions, agent orchestration, credentials       │
└─────────────┬───────────────────────────────┬───────────────┘
              │ typed IPC, sender-checked     │ in-process
              │                               │ adapter calls
              ▼                               ▼
┌──────────────────────────┐    ┌─────────────────────────────┐
│ Application UI renderer  │    │ Agent runtime               │
│  chrome, tab strip,      │    │  no Electron objects        │
│  URL bar, approval UI    │    │  structured proposals only  │
│  no Node, no web session │    └──────────────┬──────────────┘
└──────────────────────────┘                   │ redacted
                                               │ observations
                                               ▼
                                    ┌─────────────────────┐
                                    │ Model provider      │
                                    │  replaceable,       │
                                    │  untrusted with data│
                                    └─────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Website tab renderers (untrusted)                           │
│  one WebContentsView / renderer per tab                     │
│  sandbox, contextIsolation, nodeIntegration off             │
│  no agent IPC, no Node, no filesystem, no credentials API   │
└─────────────────────────────────────────────────────────────┘
```

### 4.1 Untrusted website content must not receive

Remote website content must never receive direct access to:

- Node.js
- Electron primitives
- filesystem or shell APIs
- process APIs
- arbitrary IPC
- `BrowserAdapter`
- Agent Runtime
- permission engine
- credentials
- cookie stores
- application internals
- the ability to invoke `APPROVAL` or `EXECUTE`

Website content may only render the page. Observation and interaction are performed **to** it from the main process, not **by** it on behalf of the agent. Remote content cannot conceptually bypass the policy/approval architecture.

### 4.2 Non-negotiable security invariants

These are **mandatory implementation requirements**, not optional recommendations. Any implementation phase that renders arbitrary remote websites must satisfy them. Violating an invariant is a security defect, not a style choice.

#### Website tab `WebContents` (required)

For every `WebContents` that renders arbitrary remote website content:

```text
nodeIntegration = false
contextIsolation = true
sandbox = true
```

`webSecurity` must remain enabled. Do not disable Chromium `webSecurity` to work around site or embedding issues.

Website tabs and application UI are **separate trust domains**. They use separate Sessions/partitions. They do not share cookies, storage, or preload scripts. Remote website content must not be loaded inside the privileged application UI context.

#### Website preload (if ever introduced)

Website tab preloads are discouraged. If a preload is introduced, it must expose only the smallest explicitly reviewed capability surface. It must not expose:

- raw `ipcRenderer`
- generic `send` / `invoke` bridges
- arbitrary channel names
- or any equivalent unrestricted IPC bridge

Website preloads must not expose agent, policy, `BrowserAdapter`, or application APIs.

#### Website IPC (forbidden)

Website `WebContents` have **no IPC channels** to the agent, permission engine, or `BrowserAdapter`.

#### Application IPC (required)

Application UI talks to main through a typed IPC contract. Main must validate IPC senders: `webContents` identity, origin/session, and channel allowlist. Untrusted senders must be rejected.

#### Session permissions and browser capabilities (deny by default)

Electron session permission requests (camera, microphone, geolocation, notifications, clipboard, and similar) must be handled explicitly in main. Default to **deny** until deliberately supported with a reviewed policy.

#### Navigation, windows, protocols, downloads (controlled)

- New windows and popups (`window.open`, `target=_blank`) are mediated in main. Default: open as a new tab in the website session or deny. Never grant a page an uncontrolled native window.
- External protocols other than `http`/`https` default to deny unless explicitly reviewed.
- Downloads are handled in main, never auto-opened, never auto-executed, and not an agent-invocable execute path in V1.
- Do not attach a debugger or inject script because a page requested it.

#### Composition primitive (required)

Use `WebContentsView` for embedded website tabs. Do not use deprecated `BrowserView`. Do not use `<webview>` as the primary application architecture (`webviewTag: false`).

#### Credentials and session state (local, not model-exposed)

Browser-side credentials, cookies, and session state remain local. They are never automatically exposed to the AI or model layer. The application-UI renderer does not read website cookie stores.

### 4.3 Agent and model trust

- The model never receives `WebContents`, Electron types, cookies, credentials, or raw password-field values.
- The agent never calls Electron APIs directly.
- Page content sent to a model is an explicit data-exfiltration event and is policy-gated.

---

## 5. Process / runtime model

| Process | Role | Trust |
|---------|------|--------|
| Main | Shell, tab lifetime, sessions, adapter implementation, policy, approval records, agent loop host (V1) | TCB |
| Application UI renderer | Browser chrome and approval UX | Trusted UI, unprivileged runtime |
| Website renderer(s) | Arbitrary web content | Untrusted |
| GPU / utility (Electron) | Chromium internals | Not used as an app layer in V1 |
| Remote model HTTP | Inference | Untrusted third party |

**V1 agent placement:** the agent runtime is a **module hosted in main**, not a website renderer and not a second UI. It talks to the browser only through `BrowserAdapter`. In-process is acceptable for V1 because the security-critical isolation is *API isolation*, not yet process isolation.

**Deferred:** moving the agent to an Electron utility process. That is desirable later; it must not be required to start.

**Control path is not renderer IPC.** Renderer IPC exists so the chrome UI can ask main to change tabs or record an approval. The agent does not drive the browser by sending messages through a page.

---

## 6. Main layers

The proposed nine-box diagram is directionally right and too heavy as V1 runtime topology. Keep the **conceptual** separations that encode safety. Combine boxes that would only be directories-for-diagrams.

### 6.1 Keep separate

| Layer | Why it cannot collapse |
|-------|------------------------|
| Application UI | Must not share a WebContents or session with websites |
| Browser runtime + adapter | Owns tabs, navigation, website sessions, and `WebContentsView`; the only module that may touch website `WebContents` |
| Agent runtime | Proposes actions; must not own unrestricted primitives |
| Action / permission engine | Classifies semantic effect and grants or denies authority |
| Approval | Deliberate human (or policy) decision before EXECUTE |
| Model provider | Replaceable; untrusted with data |

### 6.2 Combine for V1

| Combined as | Instead of |
|-------------|------------|
| Desktop shell = main windowing + app-ui chrome | A separate “shell framework” |
| Browser control layer = `BrowserAdapter` | A second facade over the adapter |
| Page observation module inside `browser/` | A standalone “Page Intelligence” service |
| Model provider as a thin interface inside `agent/` | A platform-level model mesh |
| Approval records/logic inside `actions/`; approval UX inside app-ui | A standalone approval product |

### 6.3 Effective V1 layering

```text
Desktop shell (main + app-ui)
│
├── Browser runtime (Electron-specific)
│     windows, tabs, navigation, sessions
│     observation (AX / compact snapshot / screenshot)
│     implements BrowserAdapter
│
├── Agent runtime
│     reasoning loop
│     structured tool schemas
│     model provider interface
│
└── Action / permission / approval
      classify OBSERVE … EXECUTE
      validate proposals
      require approval
      audit hook
```

Page intelligence is real work, not a separate process. It produces `PageObservation` and an element map used by click/type targeting. It lives next to the adapter because it is derived from the live page.

---

## 7. BrowserAdapter boundary

The agent, policy engine, and application UI must not import website `WebContents` or other Electron browser-control types. Application UI talks to main through typed IPC. Main may use Electron for windows, sessions, and IPC. Only the Electron adapter may drive website `WebContents`. All agent-facing browser control goes through a small adapter.

```text
BrowserAdapter
  ElectronBrowserAdapter      ← V1
  ChromiumBrowserAdapter      ← possible later
  RemoteBrowserAdapter        ← possible later (installed Chrome / CDP)
```

Do not design a generic cross-engine browser framework. The interface exists to keep Electron out of the agent and to make a later runtime swap possible.

### 7.1 V1 surface

Tab and navigation:

- `createTab`
- `closeTab`
- `activateTab`
- `navigate`
- `back`
- `forward`
- `reload`

Observation:

- `getPageState` — URL, title, loading, canGoBack/Forward, focused tab
- `observePage` — assembled observation (see §10), including element targets
- `captureScreenshot` — explicit, on demand; not automatically attached to every turn

Interaction primitives (no authority implied):

- `click`
- `type`
- `select`
- `scroll`

That is the whole V1 adapter. Every method takes stable IDs (`tabId`, `elementId`), never Electron objects.

### 7.2 Not on the adapter

Semantic business operations do not belong on the adapter:

- `purchase()`, `sendEmail()`, `book()`, `publish()`, `deleteAccount()`, or similar

Unrestricted script execution is not an agent-facing capability:

- `executeJavaScript`, `evaluate`, `runScript`, or equivalent general-purpose script tools

Also not on the adapter:

- cookie/credential dump (`getSessionState` in raw form)
- network interception, request modification, extension APIs
- downloads as an agent-invocable execute path in V1
- file-system or native OS automation

Raw DOM dump is not a required V1 method. If a compact DOM fragment is needed, it is a field inside `observePage`, not a separate privileged API.

### 7.3 Semantics vs primitives

```text
click("expand details")     → adapter.click(elementId) after INTERACT grant
click("confirm purchase")   → same adapter.click(elementId) after EXECUTE + APPROVAL
```

The adapter does not decide which click is allowed. It only performs a granted command.

Internal page instrumentation (deferred): if script execution is ever required for observation or targeting, it is an **internal browser implementation mechanism** behind reviewed adapter operations (for example, inside `observePage` or `click`). It is not an unrestricted agent tool. Prefer CDP/debugger-style input and snapshots from main over page-world injection.

---

## 8. Agent / action flow

```text
User intent
    → Agent Runtime
    → structured action proposal
    → Policy / Permission Engine
    → optional Approval
    → Browser Control Layer (BrowserAdapter)
    → Browser Runtime
    → resulting Observation
    → next reasoning step
```

The model must not call Electron or `WebContents` directly. It never receives unrestricted Electron objects or arbitrary JS execution privileges.

### 8.1 Where structured tool schemas belong

Tool schemas live at the **agent ↔ permission** boundary, not inside `BrowserAdapter`.

The model sees a small catalog of tools such as observe, navigate, click, type, select, scroll, and (later) prepare_action. It does not see Electron, CDP, or business verbs.

The permission engine may hide, rewrite, or delay tools. Example: a click proposal can be accepted as INTERACT, or held as EXECUTE pending approval. The schema the model used does not grant authority.

### 8.2 Where validation belongs

Two cheap layers, both in `actions/`:

1. **Schema validation** — types, tabId, elementId, URL shape, string length.
2. **Policy classification** — map the proposal plus page/target metadata to `OBSERVE | NAVIGATE | INTERACT | PREPARE_ACTION | APPROVAL | EXECUTE`.

Unknown element IDs, stale observations, cross-tab IDs, and commands against disposed tabs fail closed.

### 8.3 How results return

Adapter commands return structured results to the agent: success/failure, new `PageState`, optional observation, error code. Screenshots return by reference/handle, not as unconstrained blobs in the prompt, unless policy includes them.

The agent does not scrape Electron events. Main may emit tab/navigation events into the agent loop as structured facts.

### 8.4 Audit / event logging

A single audit sink interface, owned by the action/permission layer:

- proposals
- classification decisions
- approval outcomes
- granted adapter commands
- observation exports to a model provider (data-exfiltration events)

V1 may log locally. Storage format, retention, and UI are deferred. Do not skip the hook.

---

## 9. Permission / approval integration

Action levels are those in `.cursor/rules/browser-agent-safety.mdc`. Identifiers use underscores:

| Level | Meaning | Typical grant |
|-------|---------|----------------|
| `OBSERVE` | Read page state, AX/DOM snapshot, screenshot, non-sensitive browser state | Default on for the active task tab |
| `NAVIGATE` | Open URL, back/forward/reload, switch tab, scroll | Policy; may allow same-site and prompt for off-site |
| `INTERACT` | Local UI mutation without external side effect | Policy; allowed for non-consequential controls |
| `PREPARE_ACTION` | Assemble a consequential action without executing it | Allowed more often than EXECUTE; produces a reviewable draft |
| `APPROVAL` | Explicit decision boundary | User (V1) or a recorded policy exception (later) |
| `EXECUTE` | External side effect: submit, buy, publish, send, delete, account change | Never implicit from `click`/`type` |

The low-level primitive does not determine the level. Classification uses:

- primitive (`click`, `type`, `navigate`, …)
- target metadata (role, name, href, input type, button type, form action)
- destination (URL, download, protocol)
- page sensitivity (later)
- user policy
- agent-declared intent (**untrusted**; may inform UX, must not authorize)

V1 will not have a perfect classifier. Fail closed: if a control looks like submit/checkout/pay/send/delete/auth, treat as `EXECUTE` (or `PREPARE_ACTION` then `APPROVAL`). False positives are acceptable; false negatives are the defect to avoid.

**PREPARE_ACTION** is how the system fills a checkout form, composes a mail, or stages a booking **without** pressing the consequential control. The staged result is shown in approval UI. `EXECUTE` is a separate granted command.

Application UI never self-authorizes. It can only display a pending approval and send the user’s decision to main over IPC. Website content cannot approve anything.

---

## 10. Page observation strategy

Do not send the full raw DOM to an LLM on every turn.

The V1 observation mechanism, schema, CDP allowlist, targeting IDs, and security constraints are specified in `docs/architecture/ADR-002-page-observation.md` and implemented under `docs/plans/V1-page-observation.md`. This section remains the architectural intent those documents refine.

### 10.1 V1 observation payload

Assemble one `PageObservation`:

- URL, title, navigation/loading state
- viewport size and scroll position
- visible text (truncated)
- accessibility tree, compacted (primary targeting source)
- element catalog: `elementId`, role, name, value-kind, bounds, disabled/checked/focused, form association
- optional compact DOM excerpt for nodes the AX tree misses
- optional screenshot, policy-gated and not default-on for every step

### 10.2 Targeting

Main (observation module) assigns **session-stable `elementId`s** for the current document. The agent may only target those IDs. The map is not sent to the model in raw form beyond the catalog. IDs die on navigation or document change.

This is the V1 targeting strategy: **accessibility-first catalog + ID map**, with screenshot as visual confirmation when policy allows it. Pixel-only computer-use is deferred.

### 10.3 Token discipline

Prefer AX + catalog over HTML. Cap tree depth and string lengths. Omit hidden nodes by default. Let the agent request a screenshot or a subtree explicitly rather than always attaching both.

### 10.4 What is not V1 observation

- Full HTML to the model
- Cookie jars, localStorage dumps, network HAR
- Password field values
- Unredacted screenshots of declared-sensitive pages (policy later; architecture must allow withholding)

---

## 11. Local / cloud boundary

No cloud infrastructure is built in this phase. The boundary is:

| Component | Location | Notes |
|-----------|----------|--------|
| Desktop shell, tabs, sessions, cookies | Local | User’s machine is source of truth |
| Credentials | Local | OS secret store when implemented; never to model |
| BrowserAdapter / observation | Local | |
| Agent runtime and policy | Local | |
| Approval | Local | |
| Model inference | Local **or remote** | Remote is allowed in V1 |

Remote model calls are an explicit trust crossing:

- May send: redacted observation, user prompt, task context
- Must not send: cookies, credentials, `Cookie` headers, password values, raw payment data
- May send screenshots only when policy allows
- Form values follow field sensitivity, not a blanket “include the DOM”
- Sensitive-page withholding is a policy feature the architecture must allow; the page classifier itself is deferred

The browser does not execute in the cloud. The agent does not require a server. API keys for model providers are local configuration (implementation deferred).

---

## 12. Initial repository structure

Do **not** create these directories until an implementation phase needs them. Phase 0 adds documentation only.

Avoid extra packages. One TypeScript application is enough.

```text
docs/
  architecture/          ← this document, ADRs
  engineering/           ← existing operating system
  plans/

src/                     ← create in implementation phase, not now
  main/                  Electron main: windows, IPC host, session setup
  app-ui/                Application chrome renderer (not website content)
  browser/               BrowserAdapter, Electron adapter, tabs, observation
  agent/                 Agent loop, tool schemas, model provider interface
  actions/               Classification, policy, approval records, audit hook
  shared/                Action levels, IDs, IPC and tool types
```

`app-ui/` is used instead of a generic `renderer/` so website renderers are not implied to be application code. Website documents are not a source tree; they are remote content hosted in `WebContentsView`.

Shared types (`OBSERVE`…`EXECUTE`, `tabId`, `elementId`, IPC channel names) belong in `shared/` so main, app-ui, agent, and actions do not invent parallel enums.

No monorepo packages, no `packages/browser-core`, no plugin host.

---

## 13. Migration path

Historical note: an earlier draft of this section numbered INTERACT as V2 and PREPARE/APPROVAL/EXECUTE as V3. That numbering is **superseded**. Repository milestones, matching completed plans and ADRs, are:

```text
V0  Browser Shell                         complete
    Electron window, app-ui chrome, WebContentsView tabs,
    navigate/back/forward, separate sessions. No agent.

V1  OBSERVE                               complete
    BrowserAdapter + PageObservation (ADR-002)
    local observation only; no model

V2  REASON / read-only                    complete
    ReadOnlyAgent over exported observation (ADR-003)
    no page mutation

V3  INTERACT                              complete
    one bounded safe NAVIGATE / INTERACT action (ADR-004)
    consequential clicks return DEFER_EXECUTE (denied in product UI)

V4  PREPARE_ACTION + APPROVAL + EXECUTE — COMPLETE
    one prepared consequential click
    → explicit trusted-app approval
    → one exact ExecuteGrant
    → existing bounded click primitive
    not an autonomous loop

V5  bounded agent loop — COMPLETE
    one explicit user task → bounded sequential observe/reason/action
    reusing V3 INTERACT and per-action V4 approval
    no persistence / background autonomy
    ADR-006

V6  autonomous tasks — COMPLETE
    explicit Delegate mode
    bounded planner → sequential child V5 AgentRuns
    task-owned session tabs; background continuation while the app remains open
    per-action V4 approval; Pause/Resume/Stop
    no persistence / schedules
    ADR-007

V7  persistent workflows                  (future)

V8  AI-native browser                     (future)

Later  Deeper Chromium integration if justified
    ChromiumBrowserAdapter or CEF adapter
    agent, actions, approval, model provider reused
```

ADR-004 specifies V3 INTERACT. ADR-005 specifies V4 PREPARE_ACTION, APPROVAL, and EXECUTE. ADR-006 specifies the V5 bounded agent loop: one explicit user task, sequential observe/reason/action steps, existing V3 INTERACT and per-action V4 approval, no persistence or background autonomy. ADR-007 specifies the V6 autonomous task: one explicit delegated objective, bounded planner subgoals, sequential child V5 runs, session-scoped multi-tab workspace, per-action V4 approval unchanged, no persistence or schedules. V4 PREPARE_ACTION freezes one already-bound consequential click; it does not fill forms or run multi-step checkout. V7–V8 remain future.

### 13.1 Must be correct now

- Non-negotiable website renderer invariants (§4.2): `nodeIntegration = false`, `contextIsolation = true`, `sandbox = true`, `webSecurity` enabled
- Action levels as the authority model
- Agent never holds Electron objects
- Website content never talks to the agent
- Application UI isolated from website sessions
- `BrowserAdapter` is small, runtime-oriented, and ID-based
- Policy sits between proposal and adapter
- Approval is not a click in the page
- Remote models are untrusted data recipients
- No unrestricted `executeJavaScript` / `evaluate` / `runScript` agent tool

These are cheap to encode in types and module boundaries and expensive to retrofit once the agent drives `webContents` directly.

### 13.2 Deliberately deferred

See §14. In particular: Chromium fork, agent utility process, tab discard policy, exact Electron version, packaging, model vendor, observation JSON schema, production-grade EXECUTE classifier.

### 13.3 Electron → deeper Chromium without rewriting agent/policy

Yes, if V1 obeys the adapter boundary.

Replaceable:

- `ElectronBrowserAdapter` internals (`WebContentsView`, debugger, `capturePage`)
- windowing details

Reusable:

- agent loop and tool schemas
- action levels and permission engine
- approval records and UX contract
- model provider interface
- observation *types* (the producer behind `observePage` may change)

Would force a rewrite — and is therefore forbidden:

- passing `WebContents` into agent tools
- using IPC from a website preload as the agent API
- putting policy checks only inside Electron event handlers
- snapshots that are “whatever innerHTML we sent last” with no ID map

---

## 14. Explicitly deferred decisions

Do not decide these in Phase 0 beyond “not now”:

- Specific Electron version or Chromium milestone
- Packaging/distribution tool
- Auto-update mechanism
- Linux as a first-class target (Windows first; macOS after the Windows shell works)
- Model vendor, SDK, or hosted proxy
- Local inference
- Agent in a utility process vs main module
- Multi-profile and container tabs
- Tab discard / LRU eviction of background `WebContentsView`s
- Full EXECUTE classifier / page-sensitivity taxonomy
- Password manager, cookie UI, extensions
- Network interception, ad blocking, custom request pipelines
- Pixel-level computer-use as the primary targeting mode
- Cloud sync, account, or remote-hosted browser
- Encryption of observations to model providers
- Persistence format for audit logs
- Exact `PageObservation` JSON schema — **now specified for the observation milestone** in ADR-002 / `docs/plans/V1-page-observation.md`. Remote-model export policy remains deferred.
- Playwright (or any automation library) as an implementation dependency

---

## 15. Known risks

1. **Electron misconfiguration.** One `nodeIntegration: true` or a leaked preload turns every site into a privileged attacker. Mitigate with defaults in main and a security review when implementation starts.

2. **Adapter leakage.** Convenience will push Electron types into agent code. Mitigate with a hard module boundary: Electron imports stay in `main/` (shell, IPC, sessions) and `browser/` (the Electron adapter). Agent, actions, and shared types stay Electron-free.

3. **`executeJavaScript` as a shortcut.** It will work and it will bypass targeting, policy, and isolation. Keep it off the tool surface.

4. **CDP debugger power.** Attaching the debugger from main is the right observation/input channel and is also a privileged control plane. Only main uses it; never expose CDP to the model or to pages.

5. **INTERACT vs EXECUTE classification.** Same primitive, different authority. Heuristics will be wrong sometimes. Fail closed; invest here in V2/V3, not by letting the agent click freely.

6. **Model data exfiltration.** Observations and screenshots are user data. Remote providers will see whatever we send. Policy and redaction are part of the architecture, not a later compliance add-on.

7. **Chromium version lag.** Sites may depend on newer Chromium than Electron ships. Acceptable for V1; a reason to revisit a fork/CEF if it becomes chronic.

8. **Memory.** One renderer per `WebContentsView`; background tabs stay expensive. Eviction is deferred; do not pretend V0 is Chrome’s tab process model.

9. **`WebContentsView` lifetime.** Electron does not always destroy `webContents` when the window closes. The runtime must close tabs explicitly.

10. **Update burden.** Electron security releases are still an operational load, far smaller than a Chromium fork, not zero.

11. **False sense of sandbox.** Isolation fails if application UI and websites share a session or if IPC is not sender-checked.

12. **Approval UX bypass.** If EXECUTE can be issued from a page click the agent triggered without going through the engine, the architecture has already collapsed. All adapter calls must be grant-checked.

---

## Consistency notes

This architecture implements `.cursor/rules/browser-agent-safety.mdc`: action levels are semantic, and OBSERVE, NAVIGATE, INTERACT, PREPARE_ACTION, APPROVAL, and EXECUTE remain separable.

It follows `AGENTS.md` and `.cursor/rules/execution.mdc`: smallest correct implementation, explicit permissions, and semantic action classification.

The runtime choice is locked in `docs/architecture/ADR-001-browser-runtime.md` (Status: Accepted). V3 INTERACT is locked in `docs/architecture/ADR-004-interaction-authority.md`. V4 PREPARE_ACTION / APPROVAL / EXECUTE is locked in `docs/architecture/ADR-005-approval-execute-authority.md`. V5 bounded agent-loop orchestration is locked in `docs/architecture/ADR-006-agent-loop-orchestration.md` (Status: Accepted; implementation complete). V6 autonomous task orchestration is locked in `docs/architecture/ADR-007-autonomous-task-orchestration.md` (Status: Accepted; implementation complete).
