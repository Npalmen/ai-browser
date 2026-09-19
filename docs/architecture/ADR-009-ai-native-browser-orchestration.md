# ADR-009 — AI-native browser intent and context orchestration

**Status:** Accepted  
**Date:** 2026-09-19  
**Supersedes:** none  
**Clarifies:** informal ADR-008 Consequences remark that “V8 remains the home for AI-native browser expansion (connectors, multi-agent, cloud, OS control).” Those items remain **deferred past V8**. V8 is the AI-native **browser interaction model**, not Jarvis / OS automation / deeper Chromium.  
**Does not reopen:** V0 shell, V1 observation, V2 read-only agent, V3 INTERACT, V4 PREPARE / APPROVAL / EXECUTE, V5 AgentRun, V6 AutonomousTask, V7 persistent workflows  
**See also:** `docs/architecture/browser-architecture.md`; ADR-001 through ADR-008; `docs/plans/V8-ai-native-browser.md`; `.cursor/rules/browser-agent-safety.mdc`

## Context

V0–V7 are complete, closed, and frozen. HEAD at architecture lock:

```text
31ea93a782c1ea3c9af7b927912d9edc570d800f
Make V7 Electron closure single-attempt
```

The product already has strong AI capabilities, invoked as **separate features**:

```text
Address bar          → trusted navigate only (no search)
AI assistant panel   → Ask | Act | Delegate (explicit chips)
Workflows panel      → trusted V7 CRUD / run-now / review
```

That is an **AI-enabled browser**. V8 makes it an **AI-native browser**: the primary command surface understands where the user wants to go, what they want to know, which open pages they want as context, whether they want a bounded action, a delegated task, or a workflow draft — **without collapsing the existing authority model**.

### Audit of the shipped stack this ADR must respect

#### Current browser input / UI

- Trusted app-ui chrome: tab strip, back/forward/reload, address form, AI toggle, Workflows toggle, right panel.
- Address bar (`App.tsx` `handleAddressSubmit`) calls `window.browserShell.navigate(activeTab.id, addressDraft)`.
- `normalizeNavigationUrl` accepts `http`/`https`/`about:blank` and bare hostnames; **rejects search-like text** (`cats`, strings with spaces) and `file:` / `javascript:` / `data:` / `blob:` / `chrome:`.
- There is **no Search intent**, **no search provider**, **no omnibox**, **no Ctrl/Cmd+L** handler.
- New tab is `about:blank` with an empty address field (`placeholder="Enter address"`).
- Right panel is exactly one of `assistant` | `workflows`. Approval-required events already force the Assistant surface open.

#### Current AI surfaces

- `AiPanelMode = 'read' | 'interact' | 'delegate'` (Ask / Act / Delegate chips in `AiSidePanel`).
- Ask and Act share `ai:ask-current-page` with `{ tabId, question, mode }`. Guards require **the active existing tab**.
- Delegate is `autonomous-task:start` with `{ objective }` on the current trusted tab.
- Conversation is `ConversationStore`: **per-tab**, **document-revision-bound**, max 4 turns, **in-memory**.
- Approvals render only in Assistant (`ApprovalCard`). Free-text is not an approval path.

#### Current context limitations

- Ask/Act observe **one tab**.
- No context picker, no selected-tab set, no `BrowserContextBundle`.
- Background tabs are not a user-selected AI context.
- `tabId` / `targetId` / `observationId` remain correlation / observation-scoped; they are not capabilities.

#### Reusable V2–V7 seams (do not replace)

| Seam | Reuse as |
|------|----------|
| `normalizeNavigationUrl` / `isAllowedWebsiteNavigation` | Navigate + post-construction search URL policy |
| `BrowserAdapter.navigate` / `observePage` | Search navigation; per-tab observation |
| `ReadOnlyAgent` + `context-builder` + `export-policy` + `wrapUntrustedPageContent` | Single-tab Ask; per-page export inside multi-tab Ask |
| `ModelRuntime` / `ModelRouter` / `ModelRequestLog` | Ask and WorkflowDraft reasoning only |
| `AgentRunController` / `askCurrentPage` mode `interact` | Act |
| `startAutonomousTask` | Delegate |
| V4 `PreparedAction` → trusted approval UI → `ExecuteGrant` | Consequential Act / Delegate / workflow execution |
| `workflows.create` + existing IPC guards | Persist a reviewed draft |
| `WorkflowProductTrigger` union | Only allowed schedule kinds in a draft |
| Preload namespaces `browserShell` / `aiAssistant` / `workflows` | Keep; add a narrow fourth namespace rather than a generic command bus |
| Approval auto-open Assistant | Attention dominance |

#### Deferred (not V8)

Chromium fork / CEF, OS automation, voice, connectors, MCP, cloud browser, webhooks, multi-agent, parallel workflows, semantic long-term memory, history embeddings, sync, password manager, extensions, ad blocker, network interception, full bookmark/history platform, download-as-AI-execute, expanding V4 EXECUTE beyond click.

This ADR does **not** start implementation. V8 implementation later completed and is frozen; evidence: `docs/acceptance/V8-acceptance.md`.

---

## Decision

V8 adds three product capabilities on top of frozen V0–V7:

```text
A. AI-native omnibox / command surface
B. Explicit browser context (current tab or user-selected open tabs)
C. Natural-language WorkflowDraft → trusted review → existing V7 create
```

### Fundamental invariant

```text
Intent routing is not authority.
Context selection is not authority.
AI-generated drafts are not authority.
```

```text
V8 may make existing capabilities easier to discover, compose, and invoke.
V8 must not create a new path around V3, V4, V5, V6, or V7.
```

Authority remains:

```text
OBSERVE → NAVIGATE → INTERACT → PREPARE_ACTION → APPROVAL → EXECUTE
Delegate → V6
Persistent workflow execution → V7 → fresh V6
```

Hidden escalation is forbidden:

```text
Ask ↛ Act
Act ↛ Delegate
Delegate ↛ Workflow
```

A lower-authority path may **suggest** a higher one. Only an explicit user capability choice starts it.

---

## 1. What makes V8 AI-native

V8 is AI-native when the **browser-primary input** can represent explicit user intent and the **user can see which capability will run** before submission.

It is **not** AI-native if:

- the address bar only navigates URLs and AI lives solely in a side panel
- a model silently classifies “book me a hotel” as Delegate and starts V6
- selected tabs become mutable because they were attached as context
- a model persists or enables a V7 workflow

### Primary command surface

The existing address bar becomes the **omnibox** in trusted `app-ui`.

### What remains in Assistant

Detailed Ask answers, Act progress, Delegate task controls, **all V4 approval chrome**.

### What remains in Workflows

Durable workflow list/detail, trusted create/edit/enable/run-now/review/stop/delete. V8 Automate opens a **draft confirmation** on this surface; it does not add a second persistence API.

Omnibox is **invocation**. Right panel is **result and control**. Do not duplicate Approve / Run Now / Enable in the omnibox.

---

## 2. Intent model

### 2.1 Types (product routing, not authority)

```ts
type BrowserIntent =
  | { kind: 'navigate'; text: string }
  | { kind: 'search'; query: string }
  | { kind: 'ask'; question: string; context: BrowserContextScope }
  | { kind: 'act'; instruction: string }
  | { kind: 'delegate'; objective: string }
  | { kind: 'draft-workflow'; instruction: string; context: BrowserContextScope };
```

Exact exported names may differ; the six kinds are locked.

### 2.2 Capability selection (visible, not classifier-owned)

Omnibox text **plus** explicit chips / keyboard selection:

```text
Search | Ask | Act | Delegate | Automate
```

Navigate is not a chip. It is the deterministic URL outcome of browser-default or Search-mode URL detection.

**Do not** depend solely on invisible model classification.

If a model later infers Ask / Act / Delegate / Automate from ambiguous text, that result is **suggested intent** only. The UI must show the capability that will actually run. The user confirms by selecting the chip (or accepting a visible suggestion) **before** the route executes.

Example: `"book me a hotel"` must not start V6 or V4 EXECUTE merely because a model labeled it Delegate.

### 2.3 Default Enter (no AI chip selected)

```text
normalizeNavigationUrl(input) succeeds
  → Navigate

otherwise
  → Search
```

**Never** default to Ask, Act, Delegate, or Automate.

### 2.4 Explicit chip + Enter

| Chip | Enter does |
|------|------------|
| Search | If input is a valid navigation URL → Navigate; else Search |
| Ask | Read-only Ask over selected context |
| Act | V5 Act on the **current active tab** |
| Delegate | V6 `startAutonomousTask` as today |
| Automate | Produce `WorkflowDraft` only (no persist) |

Mode selection itself grants no extra low-level browser authority beyond invoking that existing product path.

### 2.5 Deterministic routing before any model

Do **not** send obvious URLs to an LLM to decide they are URLs.

Order:

```text
1. explicit chip (Ask / Act / Delegate / Automate) if selected
2. deterministic URL detection (existing normalizeNavigationUrl)
3. Search
```

`BrowserIntentRouter` is a pure trusted function:

```text
parse explicit UI selection
validate shape
return BrowserIntentRoute
```

It must **not** click, approve, mint grants, observe pages, or persist workflows.

### 2.6 Route result (still not authority)

```ts
type BrowserIntentRoute =
  | { kind: 'navigate'; url: string }
  | { kind: 'search'; query: string }
  | { kind: 'ask'; question: string; context: BrowserContextScope }
  | { kind: 'act'; instruction: string; tabId: TabId }
  | { kind: 'delegate'; objective: string }
  | { kind: 'draft-workflow'; instruction: string; context: BrowserContextScope };
```

Renderer-produced routes are **untrusted suggestions**. Main re-validates every field at request time.

### 2.7 about:blank / New Tab

| Intent | `about:blank` current tab |
|--------|---------------------------|
| Navigate / Search | Allowed |
| Ask current-tab | **Disabled** — no meaningful page |
| Ask selected-tabs | Allowed only if every selected tab is a real http(s) document; a selected blank tab **fails the request** |
| Act | **Disabled** — no meaningful interaction page |
| Delegate | Allowed (same V6 start-on-trusted-tab semantics as today) |
| Automate | Allowed; entry URL still required before Save (current URL cannot satisfy this while blank) |

Recommended new-tab state: omnibox focused; optional read-only activity strip. **No** recommendation feed, history database, or bookmark manager in V8.

---

## 3. Search

Search is **trusted navigation**, not an AgentRun and not model search.

```text
user query
→ BrowserSearchProvider.buildSearchUrl(query)
→ isAllowedWebsiteNavigation
→ BrowserAdapter.navigate
```

Do **not** call a model to synthesize search results. After the page loads, the user may Ask about it under existing observation/export rules.

### 3.1 Provider

```ts
interface BrowserSearchProvider {
  readonly id: string;
  buildSearchUrl(query: string): string;
}
```

**Initial V8 provider (locked):** DuckDuckGo HTTPS HTML search.

```text
id: duckduckgo-html
url: https://duckduckgo.com/?q=<encodeURIComponent(query)>
```

Rationale: no API key, no server-side search dependency, constructed URL is ordinary `https:`. A later local configuration may swap the provider implementation. V8 does **not** add a settings product or external search API keys.

### 3.2 Query safety

- Trim; reject empty query.
- Bound length (implementation: match existing question-scale caps; recommended **512** characters).
- `encodeURIComponent` the query as **data**, never splice raw query into a scheme.
- Provider templates must be `https:` (or `http:` only if a future provider is explicitly reviewed). **Forbidden** template schemes: `javascript:`, `file:`, `data:`, `blob:`, `chrome:`, `about:` other than navigation’s existing `about:blank` (search must not produce `about:`).
- After construction, `isAllowedWebsiteNavigation` must succeed. Failure → Search fails closed. No fallback to Delegate.

### 3.3 Provenance

Typed omnibox query is **user intent**. The loaded search page is **untrusted page data**. Do not concatenate them as one instruction.

---

## 4. Ask / Act / Delegate from the omnibox

### 4.1 Ask

Ask remains **read-only**.

- **Current tab only** (no extra selected tabs): existing `askCurrentPage` / `ReadOnlyAgent` / per-tab `ConversationStore`.
- **Selected tabs** (including more than the current tab, or a single non-active tab): new `MultiTabReadOnlyAgent` (name may differ) over `BrowserContextBuilder`. No mutation tools. No V3/V4/V5/V6.

Ask must not gain mutation authority because it was invoked from the omnibox.

### 4.2 Act

Initial V8 Act:

```text
action tab = current active tab
optional extra selected tabs = not used for mutation
```

Phase 1–4 must **not** let Act target arbitrary tabs. Supplemental read-only context tabs for Act are **deferred** (not required to ship V8). If later allowed, they remain observation-only; interaction still uses the existing exact `tab` + `observation` + `target` + `grant` chain on the action tab.

Consequential clicks still:

```text
DEFER_EXECUTE → V4 trusted approval UI → ExecuteGrant
```

Omnibox Act cannot classify arbitrary natural language as Act unless the **Act chip is selected**.

### 4.3 Delegate

```text
Delegate starts exactly as V6 does today on the current trusted tab.
```

Selected extra tabs are **not** auto-owned by V6. Planner seeding from extra tabs is **deferred** unless a later phase can keep ownership as clear as ADR-007. V8 must not add a parallel agent loop or new task authority.

---

## 5. Multi-tab context

### 5.1 Scope

```ts
type BrowserContextScope =
  | { kind: 'current-tab'; tabId: TabId }
  | { kind: 'selected-tabs'; tabIds: readonly TabId[] };
```

Do not expose Electron objects. Tab IDs are **correlation only**.

User must choose current tab **or** selected tabs. **Never** auto-read every open tab.

### 5.2 Context ≠ interaction

Selecting a tab as AI context allows **observation export** of that tab. It does **not** allow mutation of that tab.

A model that receives observations from tabs A, B, and C does **not** receive three mutable tab capabilities. Target IDs remain observation-scoped, tab-scoped, and document-scoped (ADR-002 / ADR-004). No cross-tab target aliasing.

### 5.3 Bundle (read-only data)

```ts
interface BrowserContextPage {
  readonly tabId: TabId;
  readonly observation: PageObservation; // local; export separately
}

interface BrowserContextBundle {
  readonly contextId: string; // request correlation only
  readonly pages: readonly BrowserContextPage[];
}
```

`contextId` is **not** a capability token. Presenting it later must not authorize click/type/navigate/approve/persist.

No `contextBundle.click` / `type` / any mutation.

Lifetime: **one request**. Destroy after Ask or draft completion. Do **not** persist page snapshots, embeddings, or bundle bytes.

### 5.4 Independent observations

For each selected tab:

```text
observe tab → revision-bound PageObservation
```

Do **not** merge DOM/AX node authority across tabs. Model input is labeled page boundaries:

```text
USER_INSTRUCTION
  <user question>

PAGE_CONTEXT tab <id> title <title> url <url>
  <UNTRUSTED_PAGE_CONTENT> … </UNTRUSTED_PAGE_CONTENT>

PAGE_CONTEXT tab <id> …
```

Reuse `wrapUntrustedPageContent`. Do not concatenate page text indistinguishably with the user instruction.

### 5.5 Limits

```text
MAX_CONTEXT_TABS = 5
maxPerTabStructuredChars = 8_000
maxTotalStructuredChars = 24_000   // same order as MODEL_CONTEXT_BUDGETS.maxStructuredChars
maxUserQuestionChars = 4_000       // existing
```

- Screenshots: **not attached by default** for multi-tab Ask. Prefer AX/catalog/text. V8 multi-tab Ask does **not** enable multi-tab screenshot export.
- Exceeding tab count or total budget **fails the request**. Do not silently drop tabs.
- Existing redaction / secret withholding / screenshot restrictions apply **per page**. One sensitive tab cannot weaken export policy for others; that tab’s secrets stay redacted. If structured export is disallowed for a selected tab, the **whole** multi-tab Ask fails (deterministic context).

### 5.6 Races

Main revalidates tab IDs at request time against live browser state. Stale renderer metadata is not trusted.

| Event during context build | Result |
|----------------------------|--------|
| Selected tab closed | **Fail the whole request** |
| Selected page document/revision changes during its observation | **Fail the whole request** |
| Selected tab not found | **Fail the whole request** |
| Selected tab is `about:blank` | **Fail the whole request** |

Do not substitute another tab by URL/title. Do not answer using a different set than the user selected.

Model-returned tab IDs (`use tab XYZ`) are **not** trusted context. Selected IDs originate from trusted browser state + user selection.

### 5.7 Context picker UX (semantics, not styling)

```text
Current tab chip
+ Add context
  [ ] open tab A
  [ ] open tab B
  …
```

Picker is trusted `app-ui`. Remote pages cannot toggle it.

### 5.8 Prompt injection

Hostile content in any context tab is **untrusted page data**. It cannot:

- change intent or selected context
- create/enable/run a workflow
- approve
- mutate another tab
- escalate Ask → Act / Delegate

Acceptance must prove this.

### 5.9 Conversation for multi-tab Ask

Do **not** pretend a multi-tab answer belongs to one arbitrary tab’s `ConversationStore`.

Use an **ephemeral in-memory** conversation keyed by the trusted request/session (`contextId` / request id). Bounded; not written to disk; not written to `workflows-v1.json`. Single-tab current-tab Ask keeps the existing per-tab store.

---

## 6. WorkflowDraft

### 6.1 Non-authoritative schema

```ts
interface WorkflowDraft {
  readonly name: string;
  readonly objective: string;
  readonly entryPoint: { readonly kind: 'url'; readonly url: string };
  readonly trigger: WorkflowProductTrigger;
}
```

`WorkflowProductTrigger` is the **existing V7 union only**: `manual` | `one-time` | `daily`/`recurring-daily` | `weekly`/`recurring-weekly`. No cron, RRULE, webhook, or every-N-minutes.

**Forbidden on a draft** (unknown fields reject the whole draft):

```text
workflowId, occurrenceId, enabled, reviewRequired, triggerKey,
taskId, tabId, approval, grant, target IDs, cookies, passwords,
page text, screenshots, planner traces, extra JSON
```

A draft has **no workflow ID** until trusted Save succeeds.

### 6.2 Path

```text
user natural-language intent (Automate chip)
→ model structured output
→ strict validator
→ trusted editable confirmation UI (Workflows surface)
→ explicit user Save
→ existing workflow:create guards
```

The model **never** calls workflow persistence. V8 must **not** expose LLM tools:

```text
createWorkflow, editWorkflow, runWorkflowNow, acknowledgeReview,
enableWorkflow, deleteWorkflow
```

### 6.3 Validation

Unknown fields reject. Bound using existing V7 limits:

```text
MAX_WORKFLOW_NAME_CHARS = 200
MAX_WORKFLOW_OBJECTIVE_CHARS = 4000
MAX_WORKFLOW_ENTRY_URL_CHARS = 2048
MAX_WORKFLOW_TIMEZONE_CHARS = 128
```

Entry URL must pass `normalizeNavigationUrl` / `isAllowedWebsiteNavigation` (`http`/`https` only; not `about:blank` as a persisted entry point).

Unsupported schedule, unknown IANA timezone, oversized fields, or authority-shaped extras → draft validation **fails**. No partial persistence. User may edit manually in the confirmation UI.

### 6.4 Entry URL source

Allowed sources, in confirmation UI, visibly:

1. explicit user-typed URL
2. current tab URL if it is allowed `http`/`https`

If the model **suggests** a URL, it is still only draft data: validator + visible confirmation required. **No navigation** during draft generation.

Copying a URL into a draft does **not** make that tab workflow-owned. Later execution remains V7: **fresh background tab**, frozen entry URL.

### 6.5 Schedule and timezone

Natural-language time parsing (`every weekday at 8`) is **draft interpretation only**. Confirmation UI must show **days, time, timezone** before Save.

Default timezone: trusted app locale (`Intl.DateTimeFormat().resolvedOptions().timeZone` or `'UTC'`), **visible and editable**. A model guess does not silently become persistence authority.

Page text saying “schedule this every day” is **page data**, not user intent, and is not schedule authority.

### 6.6 Enablement and Run Now

Preferred initial behavior:

```text
AI draft → user reviews → Save workflow → explicit Enabled control
```

- Model draft has **no** `enabled` field.
- Confirmation **Enable** checkbox defaults **unchecked**.
- Save calls `workflow:create` with `enabled: false` unless the user explicitly checks Enable or chooses a distinct trusted **Save and enable** control.
- Save **must not** call `run-now`.
- Editing existing durable workflows by natural language is **out of V8**. New drafts only.

Do not automatically enable because the model “assumed recurring.” Existing V7 manual Workflows create UI may keep its own defaults; that frozen surface is not the AI draft confirmation.

### 6.7 Provenance

Confirmation UI distinguishes **AI-generated draft** from **saved workflow**. User may edit name, objective, URL, trigger, and enabled choice before Save. The payload that hits `workflow:create` is the trusted UI payload, not the raw model JSON.

Draft conversation/page context is not stored in the V7 file. After Save, only V7 allowed fields persist.

---

## 7. Activity summary

Read-only main projection. Status aggregation only.

May show:

```text
active Ask / Act
active Delegate
pending approval
active workflow
queued workflow count
review-required workflow count
```

Must **not** add `activity.execute` / `activity.approve` / any new authority.

Controls remain Assistant / Workflows / existing approval UI. Activity may **deep-link / focus** those surfaces.

### Attention priority (product, not authority)

```text
V4 approval required
  > V6 awaiting user input
  > workflow review required
  > background task / workflow progress
```

If `approval-required` exists for the active task, **Assistant approval surface wins** over omnibox suggestions, Workflows, and activity. V8 must not bury V4.

**No omnibox approval.** Typing “approve” is free text. Only existing trusted approval controls may approve.

### Suggestions

If shown, suggestions are zero-authority (local heuristics or model suggestions). Page content cannot create trusted actions without normalization. **Initial V8 defers proactive suggestions.** No model-initiated tasks.

---

## 8. Persistence

| Persist | Do not persist |
|---------|----------------|
| Nothing new for context bundles, page text, screenshots, multi-tab conversations | PageObservation, page text, screenshots, context bundles, AI conversation, chain of thought |
| Workflow fields only after trusted V7 Save | Draft JSON as authority |
| Existing short `ConversationStore` (single-tab Ask) | Semantic memory / history embeddings / cross-site conversation |

V7 `workflows-v1.json` schema is **frozen**. Never write observations or AI transcripts into it.

No browser authority is persisted (same as ADR-008).

Audit metadata only, reusing existing local-log conventions (`ModelRequestLog` style — ids, aliases, success — not payloads):

```text
intent selected
context tab count
route chosen
draft created / saved / cancelled
```

Do **not** log full page text, screenshots, raw prompts, chain of thought, or credentials.

---

## 9. IPC / preload

Remote website content must not:

- submit omnibox commands
- change intent mode
- select tabs as context
- save a workflow draft

No website preload. Application IPC remains sender-checked.

### Namespaces

Keep:

```text
window.browserShell     browser primitives + Search navigation
window.aiAssistant      Ask / Act / Delegate / approval / V6 controls
window.workflows        trusted durable workflow CRUD
```

Add a **fourth** typed namespace:

```text
window.aiNative         context Ask, WorkflowDraft generation, activity projection
```

**Why a fourth namespace:** multi-tab Ask is not `askCurrentPage` (frozen to one **active** tab). Draft generation is not `workflows.create` (that is persistence after confirmation). Activity is a main projection, not renderer scraping of private maps. A generic `executeCommand(name, args)` / `invoke(channel)` bus is **forbidden**.

`browserShell` may gain a **narrow** typed `search(tabId, query)` (or equivalent) whose implementation builds the provider URL in **main**. Do not let the renderer supply a raw search URL unchecked.

`BrowserCommandApi` as a catch-all is rejected. Typed methods only.

### Ownership

| Concern | Owner |
|---------|--------|
| URL normalize, search URL build, navigate | main + `browserShell` |
| Single-tab Ask/Act | existing `aiAssistant` |
| Multi-tab Ask, draft generate, activity | `aiNative` → main |
| Persist workflow | existing `workflows.create` after UI confirmation |
| Approve | existing `aiAssistant.decideApproval` |

---

## 10. Keyboard (command semantics, not visual design)

```text
Ctrl/Cmd+L     focus omnibox (select contents)
Enter          current explicit intent (chip or default Navigate/Search)
Escape         close suggestions / context picker
```

---

## 11. Runtime boundary

Electron remains the runtime. `BrowserAdapter` / `ElectronBrowserAdapter` / `WebContentsView` remain the browser-control boundary. V8 is **not** a Chromium fork, CEF rewrite, extension platform, or OS agent.

Model routing stays ADR-003. Do not build a new provider stack. Model selection is not browser authority.

Sensitive typing remains **non-approvable**. V8 must not bypass that. If a command needs credentials, ask the user to interact manually or preserve existing policy.

V4 EXECUTE remains **click-only**. Multi-step checkout / typed sensitive submit are future authority work, not V8.

---

## 12. Security checklist

```text
[x] omnibox route is not browser authority
[x] model classifier cannot silently escalate capability
[x] explicit user mode selects Ask/Act/Delegate/Automate
[x] plain input defaults Navigate/Search, never autonomous execution
[x] multi-tab context is read-only
[x] context tab IDs are correlation only
[x] target IDs remain observation/tab/document scoped
[x] page text cannot change user intent
[x] page text cannot persist a workflow
[x] WorkflowDraft is non-authoritative
[x] Save passes through existing V7 trusted workflow API
[x] no AI workflow CRUD tools
[x] Save does not imply Run Now
[x] free-text cannot approve V4
[x] approval still uses existing trusted approval UI
[x] no browser authority persisted
[x] V7 workflow schema unchanged
[x] no arbitrary Electron/CDP/model tool exposure
[x] remote sites have no trusted preload
[x] existing V0–V7 authority remains frozen
```

---

## 13. Out of scope (deferred past V8)

```text
Chromium fork / CEF
OS automation / desktop control / terminal / filesystem agent
mobile remote control
voice assistant
email/calendar connectors
MCP ecosystem
cloud execution / cloud browser
public webhooks
multi-agent swarm
parallel workflow execution
semantic long-term browsing memory
browser-history embeddings
cross-device sync
password manager
extensions
ad blocker
network interception
full bookmark/history platform
download manager as an AI execute path
V4 EXECUTE expansion (forms, checkout sequences, sensitive typing)
AI rewrite of existing durable workflows
proactive suggestion execution
Act mutation of non-active tabs
V6 auto-owning extra context tabs
```

---

## 14. Explicit decision record

| Question | Decision |
|----------|----------|
| What makes V8 AI-native? | Omnibox is the primary intent surface; capability is visible before run; context is explicit; drafts are review-only |
| Primary command surface? | Trusted omnibox (upgraded address bar) |
| Assistant vs Workflows? | Assistant = Ask/Act/Delegate/approval; Workflows = durable CRUD + draft confirmation |
| Default Enter? | URL → Navigate; else Search. Never Delegate |
| Model classification? | Suggestion only; user-selected chip is authoritative for AI paths |
| Hidden escalation? | Forbidden |
| Search provider? | `BrowserSearchProvider`; initial DuckDuckGo HTTPS HTML; no API keys |
| Multi-tab max? | 5; fail closed on budget/staleness/close |
| Screenshots in multi-tab? | Off by default; not used in V8 multi-tab Ask |
| Bundle fail vs partial? | Fail the whole requested multi-tab Ask |
| Act target? | Current active tab only |
| Delegate extra tabs? | Not auto-owned; planner seeding deferred |
| Draft persist? | Only after trusted Save through `workflow:create` |
| Draft enabled default? | Unchecked; Save ≠ Run Now |
| Fourth preload namespace? | Yes: `window.aiNative` |
| Generic command IPC? | No |
| Persist page/context? | No |
| V7 schema? | Unchanged |
| Proactive suggestions? | Deferred |

No unanswered TODOs on routing, context, draft, or authority semantics.

---

## Consequences

- Implementation is specified in `docs/plans/V8-ai-native-browser.md`. Evidence: `docs/acceptance/V8-acceptance.md`.
- V0–V7 remain COMPLETE / CLOSED / FROZEN.
- ADR-008 durable-workflow decisions are unchanged. ADR-008’s connector/cloud/OS list is **not** V8 scope.

```text
ADR-009 Status: Accepted
V8 implementation: COMPLETE / CLOSED / FROZEN
V7 remains COMPLETE / CLOSED / FROZEN
```
