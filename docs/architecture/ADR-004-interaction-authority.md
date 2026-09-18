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

The remote model chooses **action intent**, not execution identity. `InteractiveAgent` binds every validated proposal to the exact local `PageObservation` used to build that inference.

```text
User intent
        │
        ▼
Interactive agent (main)
        │ fresh PageObservation → model context
        │ structured model output (answer OR ModelInteractionProposal)
        ▼
Proposal validator          ← schema + bounds only (no authority IDs)
        │
        ▼
Trusted local binder        ← tabId / observationId / documentRevision
                            ← exported-target allowlist
        │ BoundInteractionProposal
        ▼
Interaction policy          ← semantic classification (trusted observation metadata)
        │
        ▼
Interaction grant           ← explicit authority record (INTERACT or NAVIGATE)
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
| Model / `ModelRuntime` | Reason; emit structured JSON matching the model proposal schema | Choose `tabId` / `observationId` / `documentRevision`; invoke adapter; hold grants |
| Proposal validator | Parse model schema; reject unknown fields and out-of-bounds payloads | Treat model fields as execution identity; classify semantic effect; execute |
| Trusted local binder | Attach identity from the local `PageObservation` used for that inference; enforce exported-target allowlist | Trust model-echoed IDs; invent a different observation |
| Interaction policy | Classify bound proposal against trusted observation metadata; deny/defer consequential actions | Execute; trust agent-declared intent |
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
  | { kind: 'interaction'; proposal: ModelInteractionProposal }
```

The interactive agent path:

```text
schema-validate ModelInteractionProposal
→ bind local BoundInteractionIdentity
→ policy
→ grant
→ execute
```

A model returning a proposal does **not** execute it. The model must not be able to supply execution identity.

Provider tool types remain inside `ModelRuntime` implementation files. No `tools: [{ name: 'click', ... }]` in agent code.

### 3. Agent structure

**Decision: add `InteractiveAgent`; leave `ReadOnlyAgent` unchanged.**

| Agent | Authority | V3 role |
|-------|-----------|---------|
| `ReadOnlyAgent` | OBSERVE only | Unchanged; remains default safe path |
| `InteractiveAgent` | OBSERVE + one bounded INTERACT or NAVIGATE step per request | New; binds model proposals to the local observation; composes `ModelRuntime`, `context-builder`, `export-policy`, `ConversationStore`, observation source |

`InteractiveAgent` does not subclass `ReadOnlyAgent`. It reuses shared helpers and may delegate read-only failure paths. `AiRequestController` (or a sibling controller) selects the path based on an explicit mode flag introduced in V3 — never implicit escalation from Q&A to interaction.

V3 product boundary: **one model-proposed safe action per user request** → validate model proposal → bind local identity → policy → execute → fresh observation → return. No autonomous multi-step observe→act loop.

### 4. Proposal model

Strongly typed proposals live in `src/shared/interaction-types.ts` (names illustrative).

The remote model is **not** responsible for choosing or faithfully echoing authority-binding identifiers. `InteractiveAgent` already knows which local `PageObservation` built the model context.

```ts
type ModelInteractionProposal =
  | ModelClickProposal
  | ModelTypeProposal
  | ModelSelectProposal
  | ModelScrollProposal;

interface ModelClickProposal {
  kind: 'click';
  targetId: TargetId;
}

interface ModelTypeProposal {
  kind: 'type';
  targetId: TargetId;
  text: string;                 // bounded length; replace semantics (see §6)
}

interface ModelSelectProposal {
  kind: 'select';
  targetId: TargetId;           // native <select>
  optionTargetId: TargetId;     // option from that select's bounded catalog
}

interface ModelScrollProposal {
  kind: 'scroll';
  mode: 'viewport';
  direction: 'up' | 'down' | 'left' | 'right';
  amountPx: number;             // bounded
  // OR mode: 'into-view' + targetId — still NAVIGATE authority
}
```

The TypeScript sketch above is illustrative. Implementation uses a strict schema: **additional properties are rejected**. The model must not supply `tabId`, `observationId`, `documentRevision`, `frameId`, or `backendNodeId`. If those fields appear, validation fails.

Optional `agentRationale: string` may be included for UI/audit explanation. It is **untrusted** and never used for authorization.

#### 4.1 Model-visible vs trusted-local identity

| Field | Model proposal | Bound proposal | Purpose |
|-------|----------------|----------------|---------|
| `kind` + primitive payload | yes | yes | Action intent |
| `targetId` / `optionTargetId` | yes, if target-bound | yes | Opaque handle from **exported** context |
| `tabId` | **no** | yes, from local observation | Prevents cross-tab execution |
| `observationId` | **no** | yes, from local observation | Binds to the observation used for inference |
| `documentRevision` | **no** | yes, from local `document.revision` | Binds to document identity (`mainFrameId:loaderId` per ADR-002) |

V2 `ModelPageContext` already includes `document.revision` for read-only context. V3 **does not** treat a model-echoed revision as authority, and **does not** add `tabId` or `observationId` to `ModelPageContext` merely for action correlation.

```ts
interface BoundInteractionIdentity {
  tabId: TabId;
  observationId: ObservationId;
  documentRevision: DocumentRevision;
}

type BoundInteractionProposal = ModelInteractionProposal & BoundInteractionIdentity;
```

Binding sequence:

```text
fresh PageObservation
↓
build model context  (records exportedTargetIds locally)
↓
model returns ModelInteractionProposal
↓
schema-validate (reject extra identity fields)
↓
InteractiveAgent binds local:
    tabId
    observationId
    documentRevision
↓
exported-target allowlist check
↓
BoundInteractionProposal
↓
policy / grant / executor
```

Binding values come only from trusted local state for **that** inference. A later observation is a different request.

#### 4.2 Exported-target allowlist

For every target-bound proposal, each `targetId` (and `optionTargetId`) must be in the exact `exportedTargetIds` set produced when building the model context for that request.

A model must not invent a target, and must not reference a target that existed locally on `PageObservation` but was omitted from the exported context (budget truncation, off-screen drop, secret stripping, etc.).

Failure → `TARGET_NOT_EXPORTED` (fail closed). Do not resolve against the full local node list as a fallback.

Viewport-only scroll has no `targetId` and skips this check.

#### 4.3 Internal-only identity

Never in model context, model proposals, proposals returned to UI, or audit payloads as executable handles:

```text
backendNodeId
axNodeId
frameId (as execution handle — frame is validated internally after resolve)
WebContents / CDP session ids
```

`tabId` and `observationId` are local binder/audit metadata. They are not sent to the remote provider solely for action correlation.

After grant, the executor resolves `targetId` → `TargetRecord` (`frameId`, `backendNodeId`, stored `documentRevision`).

#### 4.4 Stale protection is defense in depth

```text
trusted local binding
+
exported-target allowlist
+
TargetRegistry current observation
+
TargetRecord documentRevision
+
live document identity preflight
```

Executor still:

1. Calls `TargetRegistry.resolve(tabId, observationId, targetId)` — requires `observationId` === current for the tab.
2. Compares resolved `TargetRecord.documentRevision` with the bound `documentRevision`.
3. Compares live document identity (`Page.getFrameTree` via interaction CDP client) before the adapter call.

Mismatch at any step → `TARGET_STALE` or `PAGE_CHANGED` (fail closed).

#### 4.5 Stale and cross-context rules

| Event | Result |
|-------|--------|
| Fresh `observePage` supersedes observation | Prior `observationId` and all its `targetId`s invalid |
| Main-frame navigation / reload | `documentRevision` changes; all prior targets invalid |
| Target removed from DOM | Resolution or preflight fails → `TARGET_NOT_FOUND` |
| Target in another tab | Bound `tabId` vs registry → `TARGET_STALE` / denied |
| Target omitted from exported context | Binding fails; never reaches adapter |
| Model supplies `tabId` / `observationId` / `documentRevision` | Schema reject |
| Same-document SPA update without loader change | Revision may be unchanged; backend node must still resolve — if not, `TARGET_STALE` |
| Proposal arrives after user manually changed page | Fail closed on revision/observation mismatch |

**No fuzzy retargeting in V3.** No fallback by text, role, coordinates, selector, or “closest” element.

#### 4.6 Navigation caused by a granted click

A policy-approved `click` may still change the document. Classify the **intended semantic effect** before execution (see §5 and §7). After execution, regardless of INTERACT vs NAVIGATE grant:

1. Executor detects document revision change (or loading state).
2. Prior targets are dead.
3. Fresh `observePage` runs before returning `InteractionResult`.
4. Returned observation carries new `observationId` and `document.revision`.

Downstream code must not reuse pre-click `targetId`s.

### 5. Authority classification of primitives

Authority is determined by **semantic effect**, not by the mechanical primitive.

#### 5.1 Click may be INTERACT or NAVIGATE

The adapter method is still `click`. Policy may grant:

```text
ALLOW_INTERACT   — local page UI mutation
ALLOW_NAVIGATE   — safe in-browser navigation
DENY / DEFER_EXECUTE
```

Examples:

```text
click "Expand details" / accordion / benign toggle
  → ALLOW_INTERACT

click a safe article / in-app link whose effect is navigation
  → ALLOW_NAVIGATE

click "Buy now" / checkout / payment / delete / send
  → DENY / DEFER_EXECUTE
```

Do **not** treat every link as safe. Potential navigation still passes policy. Consequential or suspicious destinations (`href`, name, role, form association) remain denied or deferred.

Unexpected navigation after an INTERACT-classified click is still handled by post-action observation and target invalidation (§4.6). That runtime document change does not retroactively convert the grant into EXECUTE.

#### 5.2 Scroll is NAVIGATE

`browser-agent-safety.mdc` lists scroll under NAVIGATE. `browser-architecture.md` lists `scroll` on the adapter as a mechanical primitive without implying INTERACT authority.

V3 rules:

- Bound `ScrollProposal` is granted under **NAVIGATE** authority.
- Scroll skips INTERACT consequential-control policy (scrolling is not “Buy now”).
- Identity still comes from trusted local binding (`tabId`, `observationId`, `documentRevision`); bounded `amountPx`; no arbitrary coordinates.
- Viewport scroll does not require `targetId`. `scroll-into-view` requires an exported target and uses the same target resolution rules.

#### 5.3 Type and select

`type` and native `select` are INTERACT when allowed. They are never a shortcut around EXECUTE. Sensitive typing is denied (§8). Consequential selects (if recognizable) are denied/deferred.

### 6. Target resolution and execution

#### 6.1 Resolution pipeline

```text
bound proposal.targetId
  → already checked against exportedTargetIds
  → TargetRegistry.resolve(bound.tabId, bound.observationId, targetId)
  → TargetRecord { frameId, backendNodeId, documentRevision, ... }
  → ObservationNode lookup in the bound observation (preflight metadata)
  → live document identity check
  → frame support check (see §6.6)
  → InteractionCdpClient bounded preflight (box model / visible / enabled)
  → BrowserAdapter primitive
```

The model never receives `backendNodeId`. The adapter methods accept **executor-internal** requests with `frameId` + `backendNodeId`, not agent-facing `targetId`.

#### 6.2 Click

- **Mechanism:** center-point `Input.dispatchMouseEvent` (`mousePressed` + `mouseReleased`) at bounds from observation, revalidated with `DOM.getBoxModel` when possible.
- **No** `Runtime.evaluate`, element `.click()` JS, or synthetic event injection in page world.
- **Preflight:** `interactive`, not `disabled`, `visible`, `inViewport` (from observation + live box model); positive width/height; frame still exists.
- **Drift:** if bounds moved beyond tolerance between observation and execution → `TARGET_STALE`.
- **Frames:** see §6.6. No coordinate-only fallback if the target cannot be resolved in the attached session.

#### 6.3 Type

**Decision: V3 `type` means replace field contents (deterministic), not unconstrained keystroke streaming.**

Sequence:

1. Focus via center click (same as click preflight).
2. Select-all + delete via bounded `Input.dispatchKeyEvent` (Ctrl+A, Backspace) **or** triple-click + backspace — allowlisted key events only, no arbitrary chords.
3. `Input.insertText` with bounded `text` (max length constant, e.g. 2_000 chars).

**Not in V3:** password/credential filling, payment fields, OTP, partial incremental typing simulation, contenteditable rich text.

**Allowed targets (conservative):** `input` (non-secret text types), `textarea`, roles `textbox` / `searchbox` with `editable` and not `secret`.

#### 6.4 Select

**Native `<select>` only.** Custom combobox / ARIA-only listbox without native select semantics → `UNSUPPORTED_TARGET` in V3 (future multi-step: click → observe → click option).

V1 observation does **not** export arbitrary HTML `value` attributes. The attribute allowlist is `type`, `href`, `placeholder`, `autocomplete`, `alt`. Do not assume `<option value>` is present. Do not add `value` to the generic attribute allowlist. Do not query the live DOM with `Runtime.evaluate` to discover options.

**Decision: Approach A — bounded select-specific option catalog for authorization, plus live backend-identity preflight for execution.**

V3 may add a **select-only** optional catalog on native `<select>` nodes, derived from the existing AX + DOM snapshot already in the observation pipeline (no page-world JS):

```ts
nativeOptions?: ReadonlyArray<{
  targetId: TargetId;
  name: string;
  selected?: true;
}>
```

Authorization rules (unchanged):

- Emit `nativeOptions` only on `tag === 'select'` (or equivalent native select role).
- Include an option only when it has a reliable `targetId` (backend DOM join) and a usable accessible `name`.
- Compact export may include `nativeOptions` on `ModelPageNode` so the model can choose `optionTargetId`. This is not a generic observation dump and does not add `tabId` / `observationId` to V2 `ModelPageContext`.
- Model proposal identifies the option by `optionTargetId` from that catalog. Both `targetId` and `optionTargetId` must be in `exportedTargetIds`.
- If the catalog cannot be built, is empty, truncated such that the requested option is absent, or the option cannot be associated with that select → `UNSUPPORTED_TARGET`.
- Policy authorizes that exact `optionTargetId`. It does not authorize “whatever option occupies catalog index N”.

**Why option box-model click is not the V3 mechanism:** Chromium native option popups are often not reliably clickable via `DOM.getBoxModel(option backendNodeId)` + mouse events on the attached session. V3 therefore uses bounded keyboard navigation after focusing/opening the select.

**Why filtered `nativeOptions` indexes are not mechanical authority:** the model-visible catalog may omit options (empty/redacted names, `maxEmittedNodes`, `maxNativeSelectOptionsPerSelect`, interactive context budgeting). Catalog-array position is therefore not a trustworthy keyboard position. Using it can grant option C and mechanically select B.

**Locked execution invariant:**

```text
optionTargetId
→ exact trusted TargetRecord/backendNodeId
→ live read-only select preflight (AX + DOM snapshot)
→ verify that backend option still belongs to that exact select
→ derive the current uniquely selected option from live state
→ derive keyboard steps from the complete live option sequence
→ bounded ArrowUp/ArrowDown + Enter
```

The model still supplies only `targetId` and `optionTargetId`. The model must never supply option index, keyboard delta, selected index, `backendNodeId`, `frameId`, or DOM position.

Live preflight uses backend identity only. No option-name matching, HTML `value` matching, CSS selectors, coordinates, or nearest-option recovery.

Supported V3 baseline: simple enabled single-select whose options are direct children of the `<select>`. Fail closed (`UNSUPPORTED_TARGET`, `TARGET_NOT_FOUND`, or `TARGET_STALE` as appropriate) for:

- `<select multiple>`
- no uniquely selected starting option (never default start index to 0)
- optgroup / nested option structures
- disabled options (Arrow key skipping is not assumed)
- target option removed or reassociated to another select
- required keyboard traversal beyond `MAX_NATIVE_SELECT_KEY_STEPS` (50)

Policy remains semantic. Live preflight answers only: “Can I still mechanically select the exact already-authorized option?”

#### 6.5 Scroll

- Viewport: `Input.dispatchMouseEvent` with `mouseWheel` **or** synthesize key PageDown/PageUp with bounded repeat — prefer mouse wheel with capped delta.
- Into-view: resolve target bounds; scroll viewport by computed delta capped to max per action.
- Max scroll per action enforced in validator (e.g. ≤ 1 viewport height).

#### 6.6 Frames and OOPIF

V3 does **not** add `Target.*` session management (`Target.setAutoAttach`, `Target.attachToTarget`, generic child-session machinery).

```text
- interaction uses the currently attached website debugger/session
- main-frame targets are the supported baseline
- same-process child-frame targets are supported only when the existing
  bounded CDP path (DOM.getBoxModel + Input.* on the attached session)
  can resolve and preflight them using backendNodeId
- if the target requires an unavailable separate OOPIF / cross-process
  session, fail closed
```

Error: `UNSUPPORTED_FRAME`.

No fuzzy fallback. No coordinate-only click when target resolution fails. No `executeJavaScript` fallback. Do not silently broaden the privileged CDP surface to make cross-origin iframe interaction work. If OOPIF interaction later becomes product-critical, that is a new ADR with an explicit `Target.*` allowlist — not V3.
### 7. Semantic policy engine

The proposal schema does **not** grant authority. Policy runs on:

**Trusted inputs**

```text
proposal.kind
observation node for targetId: role, name, tag, value, text, attributes, states
nativeOptions catalog when the target is a native select
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
ALLOW_INTERACT     — local UI mutation (expand, type, native select, …)
ALLOW_NAVIGATE     — scroll, or a click whose semantic effect is safe navigation
DENY               → INTERACTION_DENIED
DEFER_EXECUTE      → INTERACTION_DENIED in V3 (reserved for V4+ PREPARE/APPROVAL/EXECUTE)
```

The primitive does not determine the outcome:

```text
click primitive → INTERACT or NAVIGATE or DENY, depending on semantic effect
scroll primitive → NAVIGATE (still policy-bounded)
type / select   → INTERACT or DENY
```

V3 rule: **uncertain → deny/defer.** False positives acceptable; false negatives are security defects.

#### 7.2 Conservative deny patterns (non-exhaustive)

Deny/defer when target metadata suggests consequential external effect:

```text
submit, buy, purchase, checkout, pay, send, publish, post, delete, remove,
confirm order, book, reserve, transfer, sign in, log in, register, save password,
account settings, security, payment, place order
```

Signals: `role=button` + name/tag match; `type=submit`; `href` pointing to checkout/payment/auth paths; form submit association; link text that is purchase/send/delete.

Same primitive, different effect:

```text
click "Expand details"     → ALLOW_INTERACT
click safe article link    → ALLOW_NAVIGATE
click "Buy now"            → DENY / DEFER_EXECUTE
click checkout href        → DENY / DEFER_EXECUTE
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
| Schema / bounds | yes (model proposal) | — | — |
| Extra identity fields from model | reject | — | — |
| Local bind + exported-target allowlist | binder | — | — |
| Semantic classification | yes (bound proposal) | — | — |
| `observationId` / revision | binder + registry | yes | — |
| Target resolve | — | yes | — |
| interactive / disabled / secret | policy | yes | yes |
| bounds / box model | — | yes | yes |
| tab exists | — | yes | yes |

Adapter errors map to `AdapterInteractionErrorCode`; executor maps to product `InteractionErrorCode`. Raw CDP/Electron errors do not leak to model/UI.

### 12. CDP strategy

**Separate `InteractionCdpClient`** (or equivalent) from `ObservationCdpClient`. Observation allowlist (ADR-002) stays read-only. Interaction attaches debugger per action if not already attached by observation, then detaches if it attached.

**V3 interaction allowlist (closed):**

```text
Page.getFrameTree                 — document identity preflight
DOM.getBoxModel                   — bounds validation via backendNodeId
Accessibility.getFullAXTree       — read-only native-select live preflight
DOMSnapshot.captureSnapshot       — read-only native-select live preflight
Input.dispatchMouseEvent          — click, wheel scroll
Input.dispatchKeyEvent            — bounded editing keys and native-select arrows/Enter
Input.insertText                  — replace typing
```

`Accessibility.getFullAXTree` and `DOMSnapshot.captureSnapshot` are the same read-only observation commands already used by the trusted observation pipeline. They were added to the interaction client only for exact native-select live preflight, not as a generic CDP expansion.

`DOM.getBoxModel` accepts `backendNodeId`. V3 does not need a page-world `objectId`, so **`DOM.resolveNode` is not on the allowlist.** Do not add it “in case”.

**Not on the V3 allowlist:**

```text
DOM.resolveNode
Target.setAutoAttach / Target.attachToTarget / Target.* session management
Runtime.evaluate
Runtime.callFunctionOn
Page.navigate
DOM.setOuterHTML
Network.*
executeJavaScript (Electron API)
generic sendCommand(method: string)
```

`DOM.focus` is not exposed. Focus is achieved via click at validated center.

If a future primitive appears to require `Runtime.*` or `Target.*`, stop and write a new ADR — do not smuggle it into V3.

### 13. Audit boundary

Minimal in-memory audit sink (testable); persistence deferred.

Record per attempt:

```text
actionId, timestamp
proposal kind + targetId (and optionTargetId if select)
bound tabId + observationId + documentRevision  (local, not model-supplied)
policy outcome + denial reason code
grant issued (bool) + authority level (INTERACT or NAVIGATE)
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
TARGET_NOT_EXPORTED          — present locally but omitted from that inference’s model context
TARGET_STALE
TARGET_NOT_INTERACTIVE
TARGET_DISABLED
TARGET_SENSITIVE
UNSUPPORTED_TARGET
UNSUPPORTED_FRAME
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
| Model cannot choose execution identity | Model proposal has no `tabId` / `observationId` / `documentRevision` |
| `tabId` / `observationId` / revision are local | Binder copies them from the inference `PageObservation` |
| Unexported target cannot execute | Binding checks `exportedTargetIds` |
| `targetId` alone insufficient | Bound identity + registry + live revision still required |
| Click authority is semantic | Same `click` primitive may be INTERACT or NAVIGATE |
| No fuzzy retargeting | Explicit fail-closed stale errors |
| Unsupported / OOPIF frames fail closed | `UNSUPPORTED_FRAME`; no Target.* in V3 |
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

- Native `<select>` exact-option identity cannot be proven from live AX + DOM snapshot on the attached session — requires a new ADR, not `Runtime.evaluate`, page-world JS, or fuzzy option matching.
- Center-click typing is insufficient for required accessible controls — reassess with user-testing, not arbitrary JS.
- Product requires multi-step combobox interaction within V3 — would violate one-action boundary; defer or amend milestone.
- Cross-origin / OOPIF interaction becomes product-critical — new ADR with an explicit `Target.*` allowlist; not implied by V3.
