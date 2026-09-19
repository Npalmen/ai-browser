# Plan: V8 — AI-native browser

**Status:** V8 COMPLETE / CLOSED  
**Implementation:** complete  
**Explicit reference:** Implementation tasks must cite `docs/plans/V8-ai-native-browser.md` to treat this file as authoritative.

Authoritative architecture:

```text
docs/architecture/ADR-009-ai-native-browser-orchestration.md
docs/architecture/ADR-008-persistent-workflow-orchestration.md
docs/architecture/ADR-007-autonomous-task-orchestration.md
docs/architecture/ADR-006-agent-loop-orchestration.md
docs/architecture/ADR-005-approval-execute-authority.md
docs/architecture/ADR-004-interaction-authority.md
docs/architecture/ADR-003-model-runtime-routing.md
docs/architecture/ADR-002-page-observation.md
docs/architecture/browser-architecture.md
docs/plans/V7-persistent-workflows.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
```

```text
V8 COMPLETE / CLOSED / FROZEN
V7 remains COMPLETE / CLOSED / FROZEN
```

Phases 1–7 are complete. The locked architecture in this document and ADR-009 is unchanged.

V0 (shell), V1 (observation), V2 (read-only agent), V3 (INTERACT), V4 (PREPARE / APPROVAL / EXECUTE), V5 (agent loop), V6 (autonomous tasks), and V7 (persistent workflows) are **complete and frozen**. V8 must not reopen already-green V0–V7 authority.

This plan implements ADR-009. The architecture-lock task that created this file did not start production code. Implementation phases 1–7 later completed that work. Evidence: `docs/acceptance/V8-acceptance.md`.

---

## Objective

Make the product an **AI-native browser** without collapsing the authority model:

```text
trusted omnibox (Navigate / Search / Ask / Act / Delegate / Automate)
+ explicit current-tab or selected-tab context
+ read-only multi-tab Ask
+ WorkflowDraft → trusted confirmation → existing V7 create
+ read-only activity / attention projection
```

```text
Intent routing is not authority.
Context selection is not authority.
AI-generated drafts are not authority.
Activity is not authority.
```

V8 may discover, compose, and invoke existing V2–V7 paths. It must not create a path around V3, V4, V5, V6, or V7.

## Out of scope

Do not implement in V8:

```text
Chromium fork / CEF / custom engine / extension platform
OS automation, terminal, filesystem agent, desktop control
mobile remote control, voice, connectors, MCP, cloud browser
webhooks, multi-agent, parallel workflow execution
semantic long-term memory, history embeddings, sync
password manager, ad blocker, network interception
full bookmark/history/download-manager product
V4 EXECUTE expansion (forms, checkout, sensitive typing)
AI rewrite of existing durable workflows
model workflow CRUD tools
omnibox approval
generic executeCommand IPC
website preload
auto-read of every open tab
Act mutation of non-active tabs
V6 auto-owning extra context tabs
proactive suggestion execution
```

Historical architecture-lock constraint: that first task was not allowed to mark implementation complete. All implementation phases in this file are now complete.

## Model policy

```yaml
model:
  default: composer-2.5
  escalation_allowed: true
  escalation_model: grok-4.6
  escalation_reason: |
    Use Grok 4.6 only for:
    - authority architecture
    - context provenance / prompt-injection boundaries
    - cross-tab race / staleness
    - workflow draft authority
    - approval interaction
    - security-critical concurrency
    - major ADR corrections
    Do not escalate because a test failed, a command failed, or more
    confidence would be convenient.
```

Composer 2.5 is the default implementation model for every phase (normal implementation, UI, tests).

## Subagents

```yaml
subagents:
  allowed: false
```

## Verification

```yaml
verification:
  mode: targeted
```

**Architecture-lock task (this document’s creation):** docs/static consistency only. Do not run full test suites.

Per implementation phase: **targeted tests only**.

Full V0–V8 / V2–V8 acceptance matrix was required in Phase 7 and final V8 closure. That matrix is now green. Evidence: `docs/acceptance/V8-acceptance.md`.

No live or paid model calls in acceptance. Recording / fake model runtimes only. No external network. Do not run `test:v2-catalog-live` or `smoke:v2-gateway`.

## Permissions

Architecture-lock task (already granted by the current prompt):

```yaml
permissions:
  commit: true
  push: true
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

Implementation phases inherit **no** Git/CI/deploy permissions from this file. Each implementation task must grant permissions explicitly. Absent fields are `false`.

This plan does **not** authorize production V8 code, dependency installation, IPC/UI implementation, or Electron harness work in the architecture-lock task.

---

## Phase overview

Seven implementation phases. The architecture-lock task did not implement them. All seven are now complete.

| Phase | Deliverable | Verification | Status |
|-------|-------------|--------------|--------|
| 1 | Intent contracts + deterministic routing + typed IPC shapes; no observation, no UI chrome rewrite | targeted router/guard tests | complete |
| 2 | Multi-tab read-only context builder + MultiTabReadOnlyAgent; no mutation | targeted context/provenance tests | complete |
| 3 | Omnibox + Search/Navigate + context picker UI | targeted UI + search URL tests | complete |
| 4 | Omnibox Ask/Act/Delegate wired to existing V2/V3/V6 APIs | targeted orchestration tests | complete |
| 5 | WorkflowDraft agent + validator + confirmation UI + existing V7 create | targeted draft/save tests | complete |
| 6 | Activity/attention projection + approval dominance + product polish | targeted activity/attention tests | complete |
| 7 | V8 acceptance + real Electron closure + V2–V8 matrix | full acceptance matrix | complete |

Each phase must remain independently reviewable. Do not collapse later phases into earlier ones.

---

## Phase 1 — Intent contracts + deterministic routing

Establish **only**:

```text
BrowserIntent / BrowserIntentRoute types
BrowserContextScope types
deterministic URL vs Search routing
explicit capability selection contract
strict IPC contracts (no generic command bus)
safe route results (no authority)
```

Include:

- Shared types in `src/shared/` (new file; do not mutate frozen V7 workflow schema types except to *reuse* `WorkflowProductTrigger`)
- Pure `BrowserIntentRouter`: chip + text → route; no adapter calls
- Default Enter: valid URL → navigate; else search
- Explicit Ask/Act/Delegate/Automate chips override default
- Search chip + valid URL → navigate
- Main-side revalidation stubs/guards for navigate/search inputs
- Narrow `browserShell.search` (or equivalent) contract: query in, provider URL built in main
- `window.aiNative` typed surface declared; handlers may be stubs that fail closed if invoked early
- **No** multi-tab observation, **no** omnibox React rewrite required beyond what is needed to land types if a phase prompt includes a tiny UI hook — prefer types + tests only

Do **not** call models to classify URLs. Do **not** persist. Do **not** change V2 `askCurrentPage` active-tab semantics.

**Targeted verification:** URL never routed to a model; spaces/search text become Search; `javascript:`/`file:`/`data:` rejected; router never returns Delegate as default.

---

## Phase 2 — Multi-tab read-only context

Establish:

```text
user-selected tab IDs
bounded BrowserContextBundle
read-only MultiTabReadOnlyAgent
per-page provenance envelopes
existing redaction/export policy per page
fail-closed staleness / closed tab / blank tab
```

Include:

- `MAX_CONTEXT_TABS = 5`
- Per-tab and total structured budgets from ADR-009
- Independent `observePage` per selected tab; no merged target maps
- `wrapUntrustedPageContent` per page; `USER_INSTRUCTION` separate
- No screenshots in multi-tab Ask
- Ephemeral in-memory conversation keyed by request; do not write into an arbitrary tab `ConversationStore`
- Fail entire request on closed/changed/`about:blank` selected tab
- **No** mutation methods on the bundle
- **No** Act/Delegate/workflow persist in this phase

**Targeted verification:** hostile page text cannot change intent; target IDs from tab B cannot bind actions on tab A (there are no actions); budget overflow fails closed; missing tab fails closed.

---

## Phase 3 — AI-native omnibox + search/navigation

Make the omnibox the browser-primary input.

Implement:

```text
URL Navigate (existing policy)
Search via BrowserSearchProvider + adapter.navigate
context picker (current tab / selected tabs)
intent chips (Search Ask Act Delegate Automate)
Ctrl/Cmd+L focus; Enter; Escape
New Tab: omnibox focused; Ask/Act disabled on about:blank
```

Do **not** change browser authority. Do **not** wire Ask/Act/Delegate execution beyond Navigate/Search if Phase 4 is separate — chips may be visible but AI submit can no-op until Phase 4 **only if** the phase prompt says so. Prefer: Navigate/Search fully work; AI chips visible and blocked with clear “not yet” only if split landing requires it. **Authoritative intent:** Phase 3 lands Navigate/Search/picker/chips; Phase 4 lands AI execution.

Search provider: DuckDuckGo HTTPS HTML as locked in ADR-009. Construct URL in main. Existing navigation allowlist after construction.

**Targeted verification:** `cats` searches; `https://github.com` navigates; constructed search URL is `https:` only; remote page cannot submit omnibox.

---

## Phase 4 — Ask / Act / Delegate from omnibox

Wire explicit chips:

```text
Ask current-tab     → existing askCurrentPage / ReadOnlyAgent
Ask selected-tabs   → Phase 2 MultiTabReadOnlyAgent
Act                 → existing askCurrentPage mode interact / AgentRun on current tab
Delegate            → existing startAutonomousTask
```

No new agent loop. No hidden escalation. Act stays one actionable tab (current). Extra selected tabs ignored for Act (or rejected if the UI implies they would be mutated — fail closed rather than mutate). Delegate extra tabs not auto-owned.

Approval still only in Assistant. Omnibox has no approve control.

**Targeted verification:** unselected text never starts Act/Delegate; explicit Ask cannot click; Act DEFER still V4; Delegate still V6.

---

## Phase 5 — WorkflowDraft generation + trusted confirmation

Implement:

```text
DraftWorkflowAgent (structured output only)
strict WorkflowDraft validator (unknown fields reject)
trusted confirmation UI on Workflows surface
Save → existing workflow:create
Enable default unchecked
no auto run-now
no model workflow tools
```

Reuse V7 field limits and `WorkflowProductTrigger`. Timezone visible/editable. Page context cannot set schedule authority. No navigation during draft generation. No `enabled` / ids / grants on model output.

Do **not** add natural-language edit of existing workflows.

**Targeted verification:** invalid URL/schedule fails with no persist; Save without Enable creates disabled workflow; Save does not call run-now; extra authority fields rejected.

---

## Phase 6 — Activity / attention + product polish

Implement:

```text
main ActivitySummary projection
attention priority from ADR-009
deep-link to Assistant / Workflows
approval surface still wins and auto-opens
omnibox/new-tab polish
```

No new authority controls. No proactive suggestion execution (keep deferred unless a later explicit prompt adds zero-authority chips only).

**Targeted verification:** pending approval focuses Assistant, not Workflows; activity cannot approve; renderer does not scrape private V6/V7 maps.

---

## Phase 7 — V8 acceptance + real Electron closure

Acceptance must prove at minimum:

```text
URL never sent to a model for routing unnecessarily
plain unselected text defaults Search
explicit Ask is read-only
selected multi-tab Ask cannot mutate
hostile page context cannot change intent
Act still V3/V4
Delegate still V6
workflow draft cannot persist until trusted Save
page content cannot create schedule authority
workflow draft cannot auto-enable/run without explicit user action
free-text cannot approve
approval surface still wins
context IDs are not capabilities
remote pages have no ai-native preload
V0–V7 acceptance remains green
```

Real Electron tests for:

```text
omnibox Navigate
omnibox Search
multi-tab Ask
Act consequential approval
Delegate start
WorkflowDraft review/save
remote page isolation
```

No live model calls. Recording/fake runtimes only.

Also run the frozen V2–V7 matrix. Do not run live catalog/gateway.

V8 Electron runner must be **single-attempt** (same invariant as corrected V7: one `npm run test:v8-acceptance` → exactly one Electron harness execution). Do not copy historical V2–V6 retry loops.

---

## Completion criteria

V8 is **COMPLETE / CLOSED / FROZEN**. Phases 1–7 are complete. Acceptance evidence: `docs/acceptance/V8-acceptance.md`.

Final closure gates green:

```text
npm run typecheck
npm run test:v2-acceptance
npm run test:v3-acceptance
npm run test:v4-acceptance
npm run test:v5-acceptance
npm run test:v6-acceptance
npm run test:v7-acceptance
npm run test:v8-acceptance
```

Future work must not casually modify V8 authority semantics. Changes that alter routing authority, context authority, approval semantics, the WorkflowDraft persistence boundary, or Activity authority are new architecture work.

```text
V8 COMPLETE / CLOSED / FROZEN
V7 remains COMPLETE / CLOSED / FROZEN
```

---

## Consistency notes

This plan implements ADR-009. It does not reopen ADR-002–ADR-008.

```text
V8 COMPLETE / CLOSED / FROZEN
```
