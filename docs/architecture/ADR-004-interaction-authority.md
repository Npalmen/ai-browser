# ADR-004: Interaction authority

**Status:** Accepted  
**Date:** 2026-09-17  
**Supersedes:** none (clarifies `browser-architecture.md` §13 numbering; does not rename completed milestones)  
**See also:** `docs/architecture/browser-architecture.md` §7, §10, §11; `docs/architecture/ADR-001-browser-runtime.md`; `docs/architecture/ADR-002-page-observation.md`; `docs/architecture/ADR-003-model-runtime-routing.md`; `docs/plans/V3-interact-foundation.md`; `.cursor/rules/browser-agent-safety.mdc`

## Context

V0 delivers a desktop browser shell. V1 delivers local `PageObservation` with opaque `targetId`s bound to `tabId`, `observationId`, `documentRevision`, `frameId`, and internal `backendNodeId`. V2 delivers read-only model Q&A over exported observation — no page mutation.

V3 introduces **permissioned INTERACT** primitives (`click`, `type`, `select`) and **NAVIGATE-level scroll**, without PREPARE_ACTION, APPROVAL, or EXECUTE authority.

The critical invariant from `browser-agent-safety.mdc` remains:

```text
semantic effect determines authority
not the low-level primitive
```

The model must never directly own browser authority. Page content is untrusted data that may influence reasoning but cannot grant authority.

**Milestone numbering.** `browser-architecture.md` §13 used an older capability sequence. Repository milestones are:

```text
V0 shell → V1 observation → V2 read-only agent → V3 INTERACT foundation → later PREPARE/APPROVAL/EXECUTE
```

This ADR does not reopen ADR-001–003 except where V3 extends the `BrowserAdapter` surface and CDP allowlist for bounded interaction.

## Decision

Introduce a **main-process interaction authority pipeline** between model proposals and `BrowserAdapter` primitives.

```text
User intent
        │
        ▼
Interactive agent (main)
        │ structured model output (answer OR proposal)
        ▼
Proposal validator          ← schema + identity + bounds
        │
        ▼
Interaction policy          ← semantic classification (trusted observation metadata)
        │
        ▼
Interaction grant           ← explicit authority record (INTERACT or NAVIGATE for scroll)
        │
        ▼
Interaction executor        ← target resolution + preflight + adapter call
        │
        ▼
BrowserAdapter                click / type / select / scroll (privileged only)
        │
        ▼
Fresh PageObservation         mandatory after successful mutation
        │
        ▼
InteractionResult             returned to agent / UI
```

No website renderer, model provider SDK, or agent module may call `BrowserAdapter.click|type|select|scroll` directly.

### 1. Authority boundary

| Layer | Responsibility | Must not |
|-------|----------------|----------|
| Model / `ModelRuntime` | Reason; emit structured JSON matching project schema | Invoke adapter; hold grants; resolve `backendNodeId` |
| Proposal validator | Parse schema; verify required identity fields; reject malformed proposals | Classify semantic effect; execute |
| Interaction policy | Classify proposal against trusted observation metadata; deny/defer consequential actions | Execute; trust agent-declared intent |
| Grant issuer | Record allowed primitive + authority level + correlation ids | Bypass policy |
| Interaction executor | Resolve `TargetRegistry`; preflight live target; call adapter; re-observe | Reclassify policy; retarget fuzzy |
| `BrowserAdapter` | Perform granted mechanical primitive | Decide authority; expose CDP/JS |

**User vs agent authority.** Normal user navigation (address bar, back/forward, manual clicks in the page) stays outside this pipeline. V3 controls **agent-requested** interactions only. The policy engine is not interposed on human browser use.

**IPC.** Interaction primitives are not exposed on `window.aiAssistant` or website preload. Trusted app UI may display progress/results and cancel in-flight agent work via existing main-owned AI IPC; it does not receive raw `click`/`type` handles.

### 2. Proposal mechanism

**Decision: keep V2 structured-output; do not add AI SDK tool-calling for V3.**

| Approach | Assessment |
|----------|------------|
| **A. Structured output** (chosen) | Preserves project-owned `ModelRuntime` boundary; provider types stay in adapter code; proposals are validated deterministically before any side effect; matches V2 `ReadOnlyAgent` pattern. |
| **B. AI SDK tool-calling** (rejected for V3) | Implies model-initiated tool execution; leaks provider tool abstractions; encourages collapsing proposal and execution; harder to enforce fail-closed validation uniformly. |

V3 extends the model response schema to a tagged union:

```text
AgentModelOutput =
  | { kind: 'answer'; text; referencedTargets? }
  | { kind: 'interaction'; proposal: InteractionProposal }
```

The interactive agent path validates output, runs policy, and only then executes. A model returning a proposal does **not** execute it.

Provider tool types remain inside `ModelRuntime` implementation files. No `tools: [{ name: 'click', ... }]` in agent code.

### 3. Agent structure

**Decision: add `InteractiveAgent`; leave `ReadOnlyAgent` unchanged.**

| Agent | Authority | V3 role |
|-------|-----------|---------|
| `ReadOnlyAgent` | OBSERVE only | Unchanged; remains default safe path |
| `InteractiveAgent` | OBSERVE + one bounded INTERACT/NAVIGATE-scroll step per request | New; composes `ModelRuntime`, `context-builder`, `export-policy`, `ConversationStore`, observation source |

`InteractiveAgent` does not subclass `ReadOnlyAgent`. It reuses shared helpers and may delegate read-only failure paths. `AiRequestController` (or a sibling controller) selects the path based on an explicit mode flag introduced in V3 — never implicit escalation from Q&A to interaction.

V3 product boundary: **one model-proposed safe action per user request** → validate → policy → execute → fresh observation → return. No autonomous multi-step observe→act loop.

### 4. Proposal model

Strongly typed proposals live in `src/shared/interaction-types.ts` (names illustrative).

```ts
type InteractionProposal =
  | ClickProposal
  | TypeProposal
  | SelectProposal
  | ScrollProposal;

interface ProposalIdentity {
  tabId: TabId;
  observationId: ObservationId;
  documentRevision: DocumentRevision;
  targetId: TargetId;           // omitted for viewport scroll-only
}

interface ClickProposal extends ProposalIdentity {
  kind: 'click';
}

interface TypeProposal extends ProposalIdentity {
  kind: 'type';
  text: string;                 // bounded length; replace semantics (see §6)
}

interface SelectProposal extends ProposalIdentity {
  kind: 'select';
  optionValue: string;          // native <select> option value
}

interface ScrollProposal {
  kind: 'scroll';
  tabId: TabId;
  observationId: ObservationId;
  documentRevision: DocumentRevision;
  mode: 'viewport';
  direction: 'up' | 'down' | 'left' | 'right';
  amountPx: number;             // bounded
  // OR mode: 'into-view' + targetId — still NAVIGATE authority
}
```

Optional `agentRationale: string` may be included for UI/audit explanation. It is **untrusted** and never used for authorization.

#### 4.1 Model-visible identity

| Field | In proposal | Purpose |
|-------|-------------|---------|
| `tabId` | required | Prevents cross-tab execution |
| `observationId` | required | Binds to the observation the model saw |
| `documentRevision` | required | Binds to document identity (`mainFrameId:loaderId` per ADR-002) |
| `targetId` | required for target-bound primitives | Opaque handle from `PageObservation` |

#### 4.2 Internal-only identity

Never in model context, proposals returned to UI, or audit payloads as executable handles:

```text
backendNodeId
axNodeId
frameId (as execution handle — frame is validated internally after resolve)
WebContents / CDP session ids
```

After grant, the executor resolves `targetId` → `TargetRecord` (`frameId`, `backendNodeId`, stored `documentRevision`).

#### 4.3 `documentRevision`: proposal field and registry validation

**Both.**

1. Proposal must carry `documentRevision` copied from the `PageObservation` used for reasoning.
2. Validator checks proposal `documentRevision` equals the observation snapshot’s `document.revision`.
3. `TargetRegistry.resolve(tabId, observationId, targetId)` requires `observationId` === current for tab.
4. Executor compares resolved `TargetRecord.documentRevision` and live document identity (lightweight `Page.getFrameTree` via interaction CDP client) before adapter call.

Mismatch at any step → `TARGET_STALE` or `PAGE_CHANGED` (fail closed).

#### 4.4 Stale and cross-context rules

| Event | Result |
|-------|--------|
| Fresh `observePage` supersedes observation | Prior `observationId` and all its `targetId`s invalid |
| Main-frame navigation / reload | `documentRevision` changes; all prior targets invalid |
| Target removed from DOM | Resolution or preflight fails → `TARGET_NOT_FOUND` |
| Target in another tab | `tabId` mismatch → `TARGET_STALE` / denied |
| Same-document SPA update without loader change | Revision may be unchanged; backend node must still resolve — if not, `TARGET_STALE` |
| Proposal arrives after user manually changed page | Fail closed on revision/observation mismatch |

**No fuzzy retargeting in V3.** No fallback by text, role, coordinates, selector, or “closest” element.

#### 4.5 Navigation caused by INTERACT

A policy-approved `click` may still navigate (e.g. article link). That is allowed when classified as safe INTERACT. After execution:

1. Executor detects document revision change (or loading state).
2. Prior targets are dead.
3. Fresh `observePage` runs before returning `InteractionResult`.
4. Returned observation carries new `observationId` and `document.revision`.

Downstream code must not reuse pre-click `targetId`s.

### 5. Scroll classification

**Decision: scroll is NAVIGATE-level authority, not INTERACT.**

`browser-agent-safety.mdc` lists scroll under NAVIGATE. `browser-architecture.md` lists `scroll` on the adapter as a mechanical primitive without implying INTERACT authority.

V3 rules:

- `ScrollProposal` is validated and granted under **NAVIGATE** authority.
- Scroll skips INTERACT consequential-control policy (scrolling is not “Buy now”).
- Scroll still requires valid `tabId`, `observationId`, `documentRevision`; bounded `amountPx`; no arbitrary coordinates.
- Viewport scroll does not require `targetId`. `scroll-into-view` requires a target and uses the same target resolution rules.

### 6. Target resolution and execution

#### 6.1 Resolution pipeline

```text
proposal.targetId
  → TargetRegistry.resolve(tabId, observationId, targetId)
  → TargetRecord { frameId, backendNodeId, documentRevision, ... }
  → ObservationNode lookup in cached observation (preflight metadata)
  → live document identity check
  → InteractionCdpClient bounded preflight (box model / visible / enabled)
  → BrowserAdapter primitive
```

The model never receives `backendNodeId`. The adapter methods accept **executor-internal** requests with `frameId` + `backendNodeId`, not agent-facing `targetId`.

#### 6.2 Click

- **Mechanism:** center-point `Input.dispatchMouseEvent` (`mousePressed` + `mouseReleased`) at bounds from observation, revalidated with `DOM.getBoxModel` when possible.
- **No** `Runtime.evaluate`, element `.click()` JS, or synthetic event injection in page world.
- **Preflight:** `interactive`, not `disabled`, `visible`, `inViewport` (from observation + live box model); positive width/height; frame still exists.
- **Drift:** if bounds moved beyond tolerance between observation and execution → `TARGET_STALE`.
- **Frames:** use `frameId` from `TargetRecord`; CDP targets the correct frame session internally.

#### 6.3 Type

**Decision: V3 `type` means replace field contents (deterministic), not unconstrained keystroke streaming.**

Sequence:

1. Focus via center click (same as click preflight).
2. Select-all + delete via bounded `Input.dispatchKeyEvent` (Ctrl+A, Backspace) **or** triple-click + backspace — allowlisted key events only, no arbitrary chords.
3. `Input.insertText` with bounded `text` (max length constant, e.g. 2_000 chars).

**Not in V3:** password/credential filling, payment fields, OTP, partial incremental typing simulation, contenteditable rich text.

**Allowed targets (conservative):** `input` (non-secret text types), `textarea`, roles `textbox` / `searchbox` with `editable` and not `secret`.

#### 6.4 Select

**Native `<select>` only.**

- Proposal carries `optionValue` matching an `<option value="...">` present in observation metadata (select `attributes` or child option nodes in the emitted tree).
- Executor: click select to focus/open; locate option node from the **same observation** by value; click option center.
- Custom combobox / ARIA-only listbox without native select semantics → `UNSUPPORTED_TARGET` in V3 (future multi-step: click → observe → click option).

#### 6.5 Scroll

- Viewport: `Input.dispatchMouseEvent` with `mouseWheel` **or** synthesize key PageDown/PageUp with bounded repeat — prefer mouse wheel with capped delta.
- Into-view: resolve target bounds; scroll viewport by computed delta capped to max per action.
- Max scroll per action enforced in validator (e.g. ≤ 1 viewport height).

### 7. Semantic policy engine

The proposal schema does **not** grant authority. Policy runs on:

**Trusted inputs**

```text
proposal.kind
observation node for targetId: role, name, tag, value, text, attributes, states
input type / button type / href (from attributes allowlist)
interactive, disabled, visible, inViewport, secret
form association if present in observation
document url/title (weak signal only)
```

**Untrusted inputs (never authorizing)**

```text
agentRationale
page text urging action (“ignore restrictions”, “click Buy now”)
model chain-of-thought
```

#### 7.1 Classification outcomes

```text
ALLOW_INTERACT
ALLOW_NAVIGATE   (scroll)
DENY             → INTERACTION_DENIED
DEFER_EXECUTE    → INTERACTION_DENIED in V3 (reserved for V4+ PREPARE/APPROVAL/EXECUTE)
```

V3 rule: **uncertain → deny/defer.** False positives acceptable; false negatives are security defects.

#### 7.2 Conservative INTERACT deny patterns (non-exhaustive)

Deny/defer when target metadata suggests consequential external effect:

```text
submit, buy, purchase, checkout, pay, send, publish, post, delete, remove,
confirm order, book, reserve, transfer, sign in, log in, register, save password,
account settings, security, payment, place order
```

Signals: `role=button` + name/tag match; `type=submit`; `href` pointing to checkout/payment paths; form submit association.

Same primitive, different effect:

```text
click "Expand details"   → ALLOW_INTERACT
click "Buy now"          → DENY / DEFER_EXECUTE
```

#### 7.3 Prompt injection

Malicious page text may cause the model to **propose** a denied action. Policy must classify independently. Acceptance tests must include injection strings that do not bypass denial.

### 8. Sensitive fields

**Decision: V3 denies all model-driven typing into sensitive fields (fail closed).**

Deny `type` when any of:

```text
states.secret === true
input type password
autocomplete cc-number, cc-csc, cc-exp, one-time-code, current-password, new-password
role/password-like naming heuristics (conservative)
```

User manual typing in the browser is unaffected. V3 does not implement credential management or “user-originated only” AI paths.

Redacted values in observation remain unavailable to the model; audit must not log typed text for sensitive targets (and preferably no typed text at all in V3 — metadata only).

### 9. Interaction result contract

```ts
interface InteractionResult {
  actionId: string;
  status: 'succeeded' | 'failed' | 'denied';
  pageState: PageState;
  observation?: PageObservation;   // present after successful mutation + re-observe
  errorCode?: InteractionErrorCode;
  policyOutcome?: 'ALLOW_INTERACT' | 'ALLOW_NAVIGATE' | 'DENY' | 'DEFER_EXECUTE';
}
```

**Post-action observation rule:** after every **successful** `click`, `type`, or `select`, the executor must run `observePage` on the tab and return the new `PageObservation` in `InteractionResult`. After scroll, re-observe is also required (viewport changed).

Failed or denied actions return current `pageState`; observation refresh optional unless page may have changed.

### 10. Concurrency and one-action invariant

**Max one active agent interaction per tab.**

Reuse the tab-lock pattern from `ReadOnlyAgent`:

- Reject new interaction while one in flight → `INTERACTION_IN_PROGRESS`.
- Reject interaction while observation in flight on same tab.
- Reject interaction on loading tab if document identity unstable → `PAGE_NOT_READY`.
- User manual interaction concurrent with agent: agent preflight may fail stale; no merge.
- Tab close during action → `TAB_NOT_FOUND` / `REQUEST_CANCELLED`.
- Timeout: bounded (e.g. 10s) → `INTERACTION_TIMEOUT`; abort CDP sequence; detach interaction debugger if attached.
- Cancel via existing AI cancel clears in-flight work.

**One action per observation step:** the model must not batch multiple target-bound actions against one stale observation. V3 enforces a single executed proposal per request.

### 11. BrowserAdapter contract (V3 additions)

Public adapter remains runtime-oriented. New methods:

```ts
click(request: AdapterClickRequest): Promise<AdapterInteractionResult>;
type(request: AdapterTypeRequest): Promise<AdapterInteractionResult>;
select(request: AdapterSelectRequest): Promise<AdapterInteractionResult>;
scroll(request: AdapterScrollRequest): Promise<AdapterInteractionResult>;
```

Requests use `tabId`, `frameId`, `backendNodeId`, and primitive-specific bounded fields — **only callable from interaction executor inside main**, not exported to agent/shared model types.

| Check | Validator / policy | Executor preflight | Adapter (defensive) |
|-------|-------------------|--------------------|---------------------|
| Schema / bounds | yes | — | — |
| Semantic classification | yes | — | — |
| `observationId` / revision | yes | yes | — |
| Target resolve | — | yes | — |
| interactive / disabled / secret | policy | yes | yes |
| bounds / box model | — | yes | yes |
| tab exists | — | yes | yes |

Adapter errors map to `AdapterInteractionErrorCode`; executor maps to product `InteractionErrorCode`. Raw CDP/Electron errors do not leak to model/UI.

### 12. CDP strategy

**Separate `InteractionCdpClient`** (or equivalent) from `ObservationCdpClient`. Observation allowlist (ADR-002) stays read-only. Interaction attaches debugger per action if not already attached by observation, then detaches if it attached.

**V3 interaction allowlist (closed):**

```text
Page.getFrameTree              — document identity preflight
DOM.resolveNode                — backendNodeId → objectId
DOM.getBoxModel                — bounds validation
Input.dispatchMouseEvent       — click, wheel scroll
Input.dispatchKeyEvent         — bounded editing keys only (modifiers + A, Backspace, Delete, Home, End, PageUp, PageDown)
Input.insertText               — replace typing
```

**Explicitly forbidden** in interaction client (same as observation):

```text
Runtime.evaluate
Runtime.callFunctionOn
Page.navigate
DOM.setOuterHTML
Network.*
executeJavaScript (Electron API)
generic sendCommand(method: string)
```

`DOM.focus` is not exposed. Focus is achieved via click at validated center.

If a future primitive appears to require `Runtime.*`, stop and write a new ADR — do not smuggle it into V3.

### 13. Audit boundary

Minimal in-memory audit sink (testable); persistence deferred.

Record per attempt:

```text
actionId, timestamp
proposal kind + targetId + tabId + observationId + documentRevision
policy outcome + denial reason code
grant issued (bool) + authority level
adapter primitive invoked
result status + InteractionErrorCode
documentRevision before / after
```

Do **not** log: secret values, full page text, screenshots, credentials, non-metadata typed text (V3: omit typed text entirely).

### 14. Error taxonomy (product-level)

```text
INTERACTION_DENIED
DEFERRED_TO_EXECUTE          — optional distinct code for V4 handoff; may map to DENIED in V3 UI
TARGET_NOT_FOUND
TARGET_STALE
TARGET_NOT_INTERACTIVE
TARGET_DISABLED
TARGET_SENSITIVE
UNSUPPORTED_TARGET
PAGE_CHANGED
PAGE_NOT_READY
TAB_NOT_FOUND
INTERACTION_IN_PROGRESS
INTERACTION_TIMEOUT
INTERACTION_FAILED
REQUEST_CANCELLED
```

Distinguish **policy denial**, **stale target**, and **runtime failure** — agents and UI react differently.

### 15. V4+ reservation

V3 must **not** implement:

```text
PREPARE_ACTION
APPROVAL UI
EXECUTE grants
purchase / send / submit consequential forms / publish / book / delete account / payment confirmation
autonomous multi-step loops
```

Examples deferred to next milestone:

```text
click "Confirm purchase"
click "Send message"
submit login that establishes session with external effect
type into payment field
```

V3 may return `DEFER_EXECUTE` internally; user-facing behavior is denial with stable messaging.

## Architecture review checklist

| Requirement | V3 design |
|-------------|-----------|
| Model cannot invoke `BrowserAdapter` directly | Enforced by module boundaries; only executor calls adapter |
| Model cannot access Electron/WebContents/CDP | Unchanged from V2 |
| Website cannot access action engine | No preload/IPC exposure |
| `targetId` alone insufficient | Requires `tabId`, `observationId`, `documentRevision` |
| No fuzzy retargeting | Explicit fail-closed stale errors |
| New observation invalidates prior targets | `TargetRegistry.replaceObservation` |
| Navigation invalidates prior targets | Revision change |
| Semantic policy before adapter | Policy → grant → executor |
| Same primitive, different classification | Policy on metadata |
| Sensitive fields fail closed | Deny `type` |
| Uncertain consequential → deny | Policy rule |
| No PREPARE/APPROVAL/EXECUTE | Out of scope |
| No unrestricted JS | Closed CDP allowlist |
| One action per step | Single proposal per request |
| Fresh observation after success | Mandatory re-observe |
| Audit has no secrets | Metadata-only |
| Read-only V2 path valid | `ReadOnlyAgent` unchanged |
| Provider boundary replaceable | Structured output, not tool-calling |

No unresolved conflicts with ADR-001–003.

## Revisit if

- Native `<select>` cannot be operated without `Runtime.evaluate` on supported platforms — requires new ADR and bounded alternative.
- Center-click typing is insufficient for required accessible controls — reassess with user-testing, not arbitrary JS.
- Product requires multi-step combobox interaction within V3 — would violate one-action boundary; defer or amend milestone.
