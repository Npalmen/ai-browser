# ADR-005: Approval and EXECUTE authority

**Status:** Accepted  
**Date:** 2026-09-18  
**Supersedes:** none (extends ADR-004; does not reopen V0–V3)  
**See also:** `docs/architecture/ADR-004-interaction-authority.md`; `docs/architecture/browser-architecture.md`; `docs/plans/V3-interact-foundation.md`; `docs/plans/V4-prepare-approval-execute.md`; `.cursor/rules/browser-agent-safety.mdc`

## Context

V0–V3 are complete. The implemented authority chain is:

```text
model structured intent
→ strict validator
→ trusted local bind
→ deterministic policy
→ InteractionGrant (INTERACT | NAVIGATE)
→ InteractionExecutor
→ bounded BrowserAdapter primitive
→ mandatory fresh observation
```

V3 policy already classifies consequential clicks as `DEFER_EXECUTE` with `errorCode = DEFERRED_TO_EXECUTE`. Product behavior today maps that to renderer `interaction-denied`. That is a reservation, not EXECUTE permission.

```text
DEFER_EXECUTE ≠ EXECUTE permission
user approval ≠ generic permission to act
```

ADR-004 §15 forbids PREPARE_ACTION, APPROVAL UI, and EXECUTE grants in V3. This ADR specifies those layers for V4 without adding an autonomous agent loop.

The critical invariant from `browser-agent-safety.mdc` remains: semantic effect determines authority, not the low-level primitive. Clicking "Expand details" is INTERACT. Clicking "Confirm purchase" is EXECUTE. Same `BrowserAdapter.click`, different authority.

V3 already owns the mechanical click path (TargetRegistry, document revision, live box preflight, bounded `Input.dispatchMouseEvent`, debugger lifecycle, post-action observation). V4 must reuse that path. It must not create a second page-driving mechanism.

## Decision

V4 adds three separable authority objects in trusted main:

```text
PreparedAction → ApprovalDecision → ExecuteGrant
```

and keeps the existing V3 chain for safe actions:

```text
model proposal
→ local bind
→ policy

safe:
  ALLOW_INTERACT / ALLOW_NAVIGATE
  → existing InteractionGrant / InteractionExecutor

consequential:
  DEFER_EXECUTE
  → PREPARE_ACTION record
  → trusted app approval UI
  → explicit user decision
  → one exact ExecuteGrant
  → ExecuteExecutor
  → existing bounded BrowserAdapter.click
  → fresh observation
```

V4 product scope is exactly:

```text
one prepared consequential click
→ one deliberate approval decision
→ at most one execution attempt
```

per approval. No observe→act loops, multi-step workflows, recursive planning, or persistent agent tasks. Those are V5+.

**V4 EXECUTE surface (locked):** approved consequential **click** only.

Not in V4 EXECUTE: type, native select, scroll, downloads, uploads, credential filling, payment data entry, OTP, passwords, shell/external protocols.

### Why click-only

V3 already maps Send / Submit / Buy now / Confirm order / Delete / Publish / Place order / Book / Reserve / Save changes onto the click primitive plus `DEFER_EXECUTE`. Widening EXECUTE to `type` or `select` would reopen sensitive-field and native-select authority. There is no compelling V4 reason to do that.

Sensitive-field typing remains `TARGET_SENSITIVE` / `DENY`. Approval cannot override it.

---

## Authority flow

```text
InteractiveAgent (unchanged model schema)
        │ fresh PageObservation → model context
        │ structured output (answer OR ModelInteractionProposal)
        ▼
Proposal validator          ← no authority IDs from the model
        ▼
Trusted local binder        ← tabId / observationId / documentRevision
                            ← exported-target allowlist
        ▼
Interaction policy          ← semantic classification (trusted metadata)
        │
        ├─ ALLOW_INTERACT / ALLOW_NAVIGATE
        │     → InteractionGrant → InteractionExecutor → BrowserAdapter
        │
        ├─ DENY / TARGET_SENSITIVE / UNSUPPORTED_* / TARGET_STALE / …
        │     → interaction-denied (no PreparedAction)
        │
        └─ DEFER_EXECUTE and kind === 'click' and supported V4 surface
              → PrepareActionService.prepare(...)
              → PreparedAction (pending)
              → approval-required event (renderer-safe view)
              → user Approve | Reject via trusted IPC
              → ApprovalDecision
              → claimExecuteGrant (atomic; consumes the approval)
              → ExecuteGrant (single-use, authority=EXECUTE)
              → ExecuteExecutor exact validation
                    ├─ identity/revision invalid → executing → stale (adapter 0)
                    ├─ non-stale mechanical block → executing → failed (adapter 0)
                    └─ valid → BrowserAdapter.click
                         → observePage exactly once
                         → executed | execution-attempted-state-unknown
```

The model still proposes:

```text
{ kind: 'interaction', proposal: { kind: 'click', targetId } }
```

No model schema expansion is required for basic V4. The model must not output `authority`, `approved`, `prepare`, `approvalRequired`, `preparedActionId`, `approvalId`, or `ExecuteGrant` fields.

Policy remains the only classifier. Page strings and model prose never authorize.

---

## PreparedAction

PREPARE_ACTION does **not** mutate the page or the external world.

It means:

```text
freeze the exact locally-bound consequential click
+ construct a reviewable safe description
+ wait for explicit approval
```

No `BrowserAdapter` primitive runs at preparation time.

Only a policy outcome of `DEFER_EXECUTE` may become a `PreparedAction`. Do **not** convert:

```text
DENY
TARGET_SENSITIVE
UNSUPPORTED_TARGET
TARGET_STALE
TARGET_NOT_EXPORTED
TARGET_NOT_FOUND
TARGET_DISABLED
TARGET_NOT_INTERACTIVE
INTERACTION_DENIED
```

into approval prompts. Approval cannot override a safety denial.

Conceptual record (names may differ in implementation):

```ts
interface PreparedAction {
  readonly preparedActionId: string;
  readonly kind: 'click';
  readonly tabId: TabId;
  readonly observationId: ObservationId;
  readonly documentRevision: DocumentRevision;
  readonly targetId: TargetId;
  readonly category: ConsequentialActionCategory;
  readonly summary: PreparedActionSummary;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: PreparedActionState;
}

type PreparedActionState =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'stale'
  | 'executing'
  | 'executed'
  | 'failed'
  | 'execution-attempted-state-unknown';
```

The model never creates `preparedActionId`, expiry, state, or grants. Those are local-only, generated in main.

Identity is copied from the exact inference `BoundInteractionProposal`. After preparation the action does not rebind. If `TargetRegistry` no longer has that `observationId` as current, or `documentRevision` no longer matches, the action is stale. Approval cannot resurrect it. The user must cause a new observation and a new prepare.

Internal executor resolution may still use `backendNodeId` via existing V3 `TargetRecord` lookup. That handle is not stored as externally reusable authority on the renderer DTO or ExecuteGrant public surface.

---

## ApprovalDecision

Approval is a separate authority boundary. A renderer click on **Approve** does not call `BrowserAdapter`.

```ts
interface ApprovalDecision {
  readonly approvalId: string;
  readonly preparedActionId: string;
  readonly decision: 'approve' | 'reject';
  readonly decidedAt: number;
}
```

IDs are generated locally. The trusted app UI supplies only:

```text
approvalId
decision: approve | reject
```

It must never supply `targetId`, proposal, `tabId`, `documentRevision`, primitive, or authority as part of the decision.

`approvalId` is an opaque UI correlation token. Knowledge of it alone does not authorize browser execution.

Main must verify all of:

```text
approval exists
prepared action state is pending
not expired (clock checked atomically with the transition)
belongs to the current trusted app session
decision is explicit approve | reject
prepared action still valid (observation/revision/tab)
not already consumed
sender is the exact trusted app main-frame
```

Only then may main record `ApprovalDecision` and, on approve, later issue `ExecuteGrant`.

---

## ExecuteGrant

```ts
interface ExecuteGrant {
  readonly executionId: string;
  readonly preparedActionId: string;
  readonly approvalId: string;
  readonly authority: 'EXECUTE';
  readonly kind: 'click';
  readonly tabId: TabId;
  readonly observationId: ObservationId;
  readonly documentRevision: DocumentRevision;
  readonly targetId: TargetId;
  readonly issuedAt: number;
}
```

This is a distinct type from V3 `InteractionGrant` (`INTERACT` | `NAVIGATE`). Do not add `approved: true` to `InteractionGrant`. Do not make `InteractionExecutor.execute()` accept an approval flag.

The grant must not contain `WebContents`, CDP objects, reusable `backendNodeId` as external authority, page text, or model reasoning.

`claimExecuteGrant()` and browser dispatch are **not** the same event.

```text
claimExecuteGrant()
= this approval has been consumed
  and no other caller can claim it
≠ the external side effect has been attempted
```

The irreversible uncertainty boundary is:

```text
immediately before BrowserAdapter.click invocation
```

that is, the executor stage that marks `adapterPrimitiveInvoked = true`.

`ExecuteGrant` is **single-use**. After `claimExecuteGrant()` succeeds, the grant and approval are consumed, regardless of:

```text
pre-dispatch stale
pre-dispatch mechanical failure
successful click
post-action observation failure
navigation
```

Do not issue another `ExecuteGrant` from the same approval. Do not transition back to `pending` or `approved`. Never automatically retry EXECUTE. After dispatch, the external side effect may already have happened.

---

## State machine

`ApprovalManager` / `PreparedActionStore` in trusted main owns all transitions. Invalid transitions are rejected explicitly. No component in renderer, `InteractiveAgent`, or `BrowserAdapter` mutates these states.

Future `ExecuteExecutor` reports an execution-stage outcome back to the manager through explicit methods (names may differ in Phase 1):

```ts
markStaleBeforeDispatch(executionId)
markFailedBeforeDispatch(executionId)
markExecuted(executionId)
markExecutionStateUnknown(executionId)
```

```text
pending
  ├─ reject → rejected
  ├─ expire → expired
  ├─ stale  → stale
  └─ approve → approved
                 │
                 ├─ stale  (pre-claim; no ExecuteGrant)
                 ├─ expire (pre-claim; no ExecuteGrant)
                 │
                 ▼
          claimExecuteGrant
                 │
                 ▼
             executing
          ┌──────┼───────────────┬──────────────┐
          │      │               │              │
       stale   failed         executed      execution-attempted-
          │      │                              state-unknown
          │      │
          └ pre-dispatch only
            adapterPrimitiveInvoked = false
```

`executing → stale` and `executing → failed` are allowed **only when no BrowserAdapter mutation/input primitive has yet been invoked**.

Once `adapterPrimitiveInvoked = true`, the action must never transition to `stale`, `failed`, `rejected`, or `expired`. After dispatch, outcomes are limited to:

```text
executed
execution-attempted-state-unknown
```

There is no generic post-dispatch `failed`. Uncertainty about side effect after dispatch is always `execution-attempted-state-unknown`.

No transition back to `pending` or `approved`. No transition from `rejected` / `expired` / `stale` / `failed` / `executed` / `execution-attempted-state-unknown` to `executing`.

Terminal states: `rejected`, `expired`, `stale`, `failed`, `executed`, `execution-attempted-state-unknown`.

### Pre-claim vs post-claim stale

Both may exist. Neither is retryable.

**Pre-claim stale:** exact validity is known broken before grant claim.

```text
approved → stale
ExecuteGrant not issued
adapterPrimitiveInvoked = false
```

**Post-claim / pre-dispatch stale:** validity breaks or is discovered after the single-use grant was atomically claimed but before browser input.

```text
executing → stale
ExecuteGrant consumed
adapterPrimitiveInvoked = false
```

Both mean the external consequential click was not dispatched. They differ in whether an `ExecuteGrant` had already been consumed internally. Audit must preserve that distinction via stage facts.

### `failed` vs `stale`

Do not collapse all pre-dispatch failures into `stale`.

```text
failed
= execution could not reach browser mutation dispatch
  for a non-staleness mechanical/runtime reason
adapterPrimitiveInvoked = false
```

Examples:

```text
TargetRegistry / observationId / documentRevision / target identity mismatch
→ stale

unsupported, destroyed, or other mechanical browser condition
that is not identity staleness
→ failed
```

Exact later mapping may use existing V3 error codes (`TARGET_STALE`, `PAGE_CHANGED`, `TAB_NOT_FOUND`, `UNSUPPORTED_FRAME`, `INTERACTION_FAILED`, …). `failed` after a claimed grant remains single-use: the grant cannot be reclaimed.

---

## Single-use and idempotency

`ApprovalManager` must expose operations that make invalid transitions impossible:

```ts
prepare(...)
decide(approvalId, decision)
claimExecuteGrant(approvalId)
markStaleBeforeDispatch(executionId)
markFailedBeforeDispatch(executionId)
markExecuted(executionId)
markExecutionStateUnknown(executionId)
invalidateTab(tabId)
invalidateObservation(tabId, observationId)
expire(now)
```

**Duplicate Approve / duplicate IPC / late renderer retry:** only one caller may transition `pending → approved → executing`. Use an atomic in-memory compare-and-set. The loser receives a terminal already-decided (or already-executing / already-consumed) response. Adapter click count for that approval is `<= 1`.

**Claimed then stale/failed before dispatch:** `claimExecuteGrant` has already consumed the grant. `executing → stale` or `executing → failed` is terminal. A second `claimExecuteGrant` for the same approval must fail. The user must prepare and approve a new action.

**Approve vs Reject race:** exactly one decision wins. The other receives already-decided. A winning rejection never produces `ExecuteGrant` or adapter invocation.

**Expiry race:** the state transition checks the injectable clock atomically. If `now >= expiresAt` before the approve transition commits, the state becomes `expired` and no `ExecuteGrant` is issued. The same clock check applies at claim: elapsed TTL after approve but before a successful `claimExecuteGrant` is `approved → expired`, with no grant. After the grant is claimed, TTL does not create `expired`; pre-dispatch identity failure is `stale`, and post-dispatch uncertainty is `execution-attempted-state-unknown`.

**Crash / restart:** V4 stores pending approvals and audit in memory only. Process restart invalidates every pending approval. There is no re-execution after restart. If the process crashes after adapter dispatch but before the result is observed, the system may not know whether the external side effect occurred; V4 represents that honestly and does not retry.

---

## TTL

Pending approvals expire after a fixed **2 minutes** (`120_000` ms) from `createdAt`.

Rationale: long enough to read a short summary and decide; short enough that silent page drift is likely if the user walks away. V4 does not keep approvals indefinitely valid.

Tests must inject a clock. After expiry, the user must prepare again from a fresh observation.

---

## Tab / document / observation binding

Prepared actions bind to the exact V3 identity:

```text
tabId
observationId
documentRevision
targetId
kind = 'click'
```

`TargetRegistry` current-observation semantics are **not** weakened. Any superseding observation for that tab makes the prepared action stale. That includes:

```text
a new read request
a new interact request
navigation / reload
manual page change that changes documentRevision
TargetRegistry.replaceObservation
```

Do not keep old targets alive to serve approvals.

**Page changes while approval UI is open:** the prepared action becomes stale. If the user then presses Approve, there is **no** `BrowserAdapter` execution. The UI receives a stale/expired/invalid outcome. Do not silently prepare a replacement.

**Visually identical replacement target:** fail closed. No name, text, CSS, coordinate, or nearest-target recovery.

**Max one pending PreparedAction per tab.** Preparing a new one invalidates/cancels the previous pending approval for that tab. No approval queue. Different tabs may hold independent pending approvals.

---

## Execution-time validation

Defense in depth:

| Stage | Checks | On failure |
|-------|--------|------------|
| Prepare | Bound identity, `DEFER_EXECUTE`, click-only, target resolved in inference observation, category/summary | No `PreparedAction`; remain denied |
| Decide | pending, TTL, single-use, trusted sender, not already decided | Terminal already-decided / expired / stale; no grant |
| Claim grant | still `approved`, not already claimed, TTL remaining, identity still current if already known broken | No `ExecuteGrant`. Identity already invalid → `approved → stale` (**pre-claim stale**). TTL elapsed → `approved → expired`. |
| Immediately before click | `TargetRegistry` exact current `observationId`, `documentRevision`, exact `targetId`, V3 live box/frame/revision preflight | Grant already claimed: `executing → stale` (identity) or `executing → failed` (non-stale mechanical). `adapterPrimitiveInvoked = false`. Grant remains consumed. |

Do **not** re-observe before execute in a way that issues a new `observationId` and rebinds authority:

```text
approve → observe → find target again → execute     FORBIDDEN
```

Use the frozen identity and bounded live mechanical preflight (same as V3 click). After the approved execution attempt, `observePage()` runs exactly once, as in V3. Old target IDs die afterward.

---

## Post-execution observation and result semantics

After a mechanically successful approved click, `observePage()` must run exactly once before returning `executed`.

If the adapter click was attempted and then observation fails:

```text
do not retry click
result = execution-attempted-state-unknown
```

Do not tell the UI it is safe to retry automatically.

Once the executor marks `adapterPrimitiveInvoked = true`, never report `rejected`, `expired`, `stale`, or `failed` for that execution.

| Outcome | Grant claimed? | Adapter invoked? | Meaning |
|---------|----------------|------------------|---------|
| `rejected` | no | no | user rejected |
| `expired` | no | no | TTL expired before winning approval/claim |
| `stale` | maybe | no | exact prepared identity invalid before browser dispatch |
| `failed` | maybe | no | non-stale failure prevented browser dispatch |
| `executed` | yes | yes | click dispatched and fresh observation succeeded |
| `execution-attempted-state-unknown` | yes | yes | browser dispatch attempted; final state not safely confirmed |

A `stale` or `failed` result after a claimed grant remains single-use. No retry.

### Execution stage facts

Main-process / audit facts only; not renderer-visible; no executable browser handles:

```text
grantIssued          — ApprovalDecision recorded as approve
grantClaimed         — claimExecuteGrant succeeded
adapterPrimitiveInvoked — BrowserAdapter.click / input dispatch started
postObservationSucceeded — mandatory fresh observePage returned
```

These distinguish:

```text
stale before claim
stale after claim but before dispatch
mechanical failure before dispatch
browser dispatch attempted
fully confirmed execution
```

This continues V3 Phase 3 audit semantics: policy/grant vs adapter invocation vs post-observation are separate facts.

---

## Module boundary

Do not overload `InteractionExecutor`.

| Module | Owns |
|--------|------|
| `InteractionExecutor` | V3 safe `ALLOW_INTERACT` / `ALLOW_NAVIGATE` only |
| `PrepareActionService` | `DEFER_EXECUTE` → `PreparedAction` + safe summary/category |
| `PreparedActionStore` / `ApprovalManager` | sole owner of PreparedAction state: decide, claim, pre-dispatch stale/failed, executed/unknown, invalidate, expire |
| `ExecuteExecutor` | consumes `ExecuteGrant`; reports stage outcomes to the manager; reuses V3 click primitive + fresh observation; never mutates store state directly |
| `AiRequestController` | trusted-app events; must not become the grant issuer |
| `InteractiveAgent` | propose/bind; must not import `BrowserAdapter` or issue `ExecuteGrant` |
| `BrowserAdapter` | mechanical `click` only; no `buy` / `send` / `delete` methods |

Preferred wiring: existing executor (or a thin orchestrator in front of it) still runs policy. When the outcome is `DEFER_EXECUTE` for a supported consequential click, `PrepareActionService` runs instead of treating that as a terminal product denial. `InteractionExecutor.execute()` must not grow an `approved` flag.

`BrowserAdapter` must not gain purchase/send/delete methods. EXECUTE reuses `click` after an EXECUTE grant. Semantic authority stays outside the adapter.

Mechanical reuse from V3 click:

```text
TargetRegistry.resolve
documentRevision
frame checks
live box / geometry drift
bounded Input.dispatchMouseEvent
fresh observation
debugger attach/detach lifecycle
```

Still forbidden: `executeJavaScript`, page-world `element.click()`, `Runtime.*`, `DOM.resolveNode`, `Target.*` session attachment.

---

## Controller / event evolution

Today:

```text
DEFER_EXECUTE → InteractionResult denied → interaction-denied
```

V4, in `interact` mode, for a **supported** prepare surface:

```text
DEFER_EXECUTE → PreparedAction → approval-required
```

Unsupported or unsafe cases remain `interaction-denied` (including `TARGET_SENSITIVE`, `UNSUPPORTED_TARGET`, and non-click deferred kinds if any appear).

Policy stays UI-unaware. `classifyInteraction` continues to return `DEFER_EXECUTE`. Preparation and event shaping live in PrepareActionService / controller, not in the classifier.

Read mode is unchanged. Safe V3 click/type/select/scroll are unchanged.

---

## Approval UI payload

Renderer-safe view (conceptual):

```ts
interface PendingApprovalView {
  approvalId: string;
  tabId: TabId;
  category: ConsequentialActionCategory;
  title: string;
  description?: string;
  origin?: string;
  expiresAt: number;
}
```

Do not expose:

```text
targetId
optionTargetId
observationId
documentRevision
backendNodeId
frameId
grant
BoundInteractionProposal
PageObservation
preparedActionId (optional to omit from UI; approvalId is the only UI token)
ExecuteGrant
```

`tabId` may appear on events for panel routing, as existing AI events already do. The decide IPC still accepts only `approvalId` + decision.

### Human-readable summary

Category is for UX, audit, and explanation — **not** authority.

```text
submit
send
purchase
delete
publish
book
reserve
account-change
other-consequential
```

Unknown consequential clicks use `other-consequential` with conservative copy.

The summary may use bounded, already-redacted target metadata (button label, origin/domain). Page text is descriptive, not authority. Strings such as `"System approved"` or `"Safe action"` must not change classification.

If reliable extra detail (visible amount, recipient-like label) is already present in redacted observation metadata, it may be shown in bounded form. Do not add a new DOM scraping path. Do not store or display passwords, OTP, card numbers, cookies, hidden fields, or raw form bodies. If detail is unavailable, show a generic summary rather than guessing.

Summary text is untrusted display text: plain text only, truncated, no HTML, no `dangerouslySetInnerHTML`. Prompt-injection strings cannot affect approval logic.

---

## IPC and UI trust boundary

New trusted-app channels only (names may be AI-namespaced equivalents):

```text
approval:decide    input: { approvalId, decision: 'approve' | 'reject' }
approval:event     renderer-safe approval/execution events
```

Do **not** create `executeClick`, `executeProposal`, `runGrant`, or `approveTarget`.

Renderer cannot request “create approval for target X”. Only main creates pending approvals. UI receives them as events/state and may only decide an already-existing approval.

Every channel uses the existing exact trusted-app sender rule:

```text
assertTrustedAppSender
sender === mainWebContents && senderFrame === mainFrame
```

Website `WebContentsView` has no approval preload, no approval IPC, and cannot see `approvalId`s.

Renderer-safe events (conceptual):

```text
approval-required
approval-resolved
execution-started
execution-completed
execution-failed
approval-stale
approval-expired
```

No `targetId`, proposal, grant, `observationId`, `documentRevision`, or `backendNodeId` in those events.

### UX requirements

Trusted app chrome owns approval. The website must not visually masquerade as the approval UI.

Visible separation of:

```text
action summary
Approve
Reject
```

No default approve. No approval via page click, implicit Enter, timeout default, or model statement.

---

## Sensitive data

V4 approval must not override V3 sensitive typing policy. Still denied, including via approval:

```text
password / current-password / new-password
one-time-code
cc-number / cc-csc / cc-exp
private keys / API tokens
```

There is no V4 “Approve AI filling my password”. Credential managers are a later architecture.

**Manually populated payment/credential fields:** the user may type those values themselves. The model must not receive the secrets (existing redaction). V4 **may** prepare the final consequential click (for example Confirm purchase / Sign in) without exposing payment or password values in the approval summary. That click is still `DEFER_EXECUTE` → prepare → explicit approve → one `ExecuteGrant` → one `click`.

---

## Cancellation, tab, and navigation lifecycle

| Event | Effect on pending PreparedAction |
|-------|----------------------------------|
| Original AI request completes after prepare | Approval remains; it is an independent authority object |
| `cancelAsk` for the original request | Must not execute. Does not by itself approve. Pending approval remains until decide / expire / invalidate |
| New same-tab AI request (read or interact) | Invalidates pending approval (`stale`) |
| Main-frame navigation / reload | `stale`; renderer gets a safe invalidation event; no auto-reprepare |
| Tab close | Invalid; no execution after tab disposal |
| Browser runtime dispose | All pending approvals invalid |
| App restart | All pending approvals gone (in-memory only) |

Once emitted to approval UI, a PreparedAction is its own pending authority object. Cancelling the model request must never accidentally execute it.

---

## Audit

Extend the existing append-only in-memory audit concept. Persistence is out of V4.

Distinguish at least:

```text
prepared
approval-presented
approved
rejected
expired
stale                    — include whether grantClaimed is already true
execute-grant-issued     — grantIssued / grantClaimed
execution-attempted      — adapterPrimitiveInvoked
executed
execution-failed         — pre-dispatch mechanical failed only
post-observation-failed  — dispatch attempted; observation unconfirmed
```

Audit must be able to tell pre-claim stale from post-claim / pre-dispatch stale. Do not store executable browser handles in these facts.

Metadata only. Never store passwords, OTP, card numbers, typed secrets, full `PageObservation`, screenshots, `backendNodeId`, CDP params, or model chain-of-thought.

Opaque `targetId` / `tabId` / `observationId` / `documentRevision` may appear in **main-process** audit, consistent with V3. They must not appear in renderer events.

Correlate one action with:

```text
preparedActionId
approvalId
executionId
```

without exposing internal target handles to the renderer.

---

## TOCTOU limitations

Approval binds semantic/local identity at preparation time. Execution still performs live mechanical preflight immediately before dispatch.

The system cannot freeze arbitrary website JavaScript. V4 does **not** claim transactional browser execution.

Bounded guarantees:

```text
no rebind
exact document/target identity
live preflight
single dispatch
fresh post-observation
honest unknown-after-dispatch
```

Not guaranteed: that the page’s event handlers, network requests, or DOM did not change in ways invisible to identity + box-model preflight.

---

## Form preparation vs V4

V4 does **not** introduce multi-step form automation.

V3 INTERACT can still perform one safe field edit per explicit user request. When a consequential control is reached, V4 may prepare that single click.

Example:

```text
request 1: type non-sensitive message draft     → V3 INTERACT
request 2: propose click Send                   → V4 prepare
approval: Send                                  → one EXECUTE click
```

V5 may later orchestrate that as one multi-step task. V4 must not become the autonomous loop milestone.

---

## Supported V4 surface

Implementation may start with a subset of categories, but all supported V4 EXECUTE actions are consequential **click** semantics, including fixtures such as:

```text
Send message
Submit form
Buy / Confirm purchase
Delete
Publish
Book / Reserve
Save account change
```

Model/system prompt: prefer no change. The model already proposes consequential clicks; policy detects them. Optional later wording that consequential proposals may be staged for user approval is an implementation detail. Never expose approval IDs to the model.

---

## Explicit non-goals

```text
PREPARE_ACTION that mutates the page
multi-step autonomous observe→act loops
persistent workflows / task state
approval queues
always-approve policies
approval persistence across restart
password / card / OTP filling
native select EXECUTE
type EXECUTE
BrowserAdapter.buy/send/delete
model tool-calling EXECUTE
website-triggered approval
fuzzy retargeting after approval
automatic EXECUTE retry
V5 agent loop
```

---

## Security invariants

```text
[ ] Model cannot self-approve or emit approval/execute authority fields
[ ] Website cannot see, create, approve, reject, or execute
[ ] Renderer decide IPC is only approvalId + approve|reject
[ ] assertTrustedAppSender remains exact
[ ] Only DEFER_EXECUTE supported clicks prepare
[ ] DENY / TARGET_SENSITIVE / UNSUPPORTED cannot be approved
[ ] Approval cannot rebind identity
[ ] Superseding observation / navigation / tab close stale the action
[ ] Expired approval cannot execute
[ ] Duplicate approve → at most one adapter click
[ ] Approve/reject race → one terminal decision
[ ] ExecuteGrant is single-use; claimed then stale/failed cannot be reclaimed
[ ] executing → stale/failed only when adapterPrimitiveInvoked is false
[ ] After adapter dispatch, never stale, failed, rejected, or expired
[ ] No automatic EXECUTE retry
[ ] Post-dispatch observation failure is unknown, not a retry
[ ] Approval UI has no execution handles
[ ] Audit has no sensitive values
[ ] V2 read path and V3 safe interact remain unchanged
```

---

## Rejected alternatives

| Alternative | Why rejected |
|-------------|--------------|
| Model returns `approved=true` | Model is untrusted; would collapse APPROVAL into REASON |
| Model directly calls an EXECUTE tool | Reopens the V3 tool-calling rejection; proposal would execute |
| Approval boolean on `InteractionGrant` | Collapses INTERACT/NAVIGATE grants with EXECUTE; teaches `InteractionExecutor` to skip policy |
| Renderer sends `targetId` + approve | Renderer would choose the execution target; website XSS becomes execute |
| Website-triggered approval | Violates app/website session isolation |
| Re-resolve target by label after approval | Exact-target violation; attacker can swap a same-named control |
| Automatic retry after EXECUTE failure | Side effect may already have occurred |
| One approval covering multiple actions | V4 is one prepared click; multi-action is V5 |
| Permanent “always approve” in V4 | Removes the deliberate approval boundary |
| Persist approvals across restart | Cannot prove the page/target still matches; crash-window ambiguity |
| `BrowserAdapter.execute()` / `buy()` | Semantic authority would leak into the adapter |
| Re-observe and rebind before execute | New `observationId`/`targetId` would silently retarget |
| Upgrade `DENY` or `TARGET_SENSITIVE` via approval | Approval would override safety denials |
| Prepare from arbitrary failed interactions | Stale/unsupported/sensitive are not consequential-click deferrals |

---

## Acceptance obligations

Later V4 implementation/acceptance must prove, against deterministic localhost fixtures and real Electron where required:

```text
Send / Submit / Buy / Delete / Publish / Book / Save-account clicks prepare
page change after approval shown → no execution
target removed → no execution
visually identical replacement target → no execution
new observation supersedes prepared action
duplicate Approve → <=1 execute attempt
Approve + Reject race → one terminal decision
approval after TTL → no execution
tab closed / runtime disposed → no execution
prompt-injection “already approved” → no authority
malicious model output claiming approval → rejected by schema/policy
website navigation while pending → stale, no execution
claimed grant then stale before dispatch → stale, grant not reclaimable
claimed grant then mechanical fail before dispatch → failed, grant not reclaimable
post-click observation failure → unknown, no retry
DENY and TARGET_SENSITIVE never prepare
```

No live paid model calls required. V2 and V3 acceptance must remain green.

---

## Consequences

**Positive**

- `DEFER_EXECUTE` becomes a real PREPARE/APPROVAL/EXECUTE path without weakening V3
- Approval is an explicit, single-use, exact-target grant
- Mechanical click defenses stay in one place
- Fail-closed stale/expiry/idempotency rules are testable with an injectable clock

**Negative**

- Users must re-prepare after any new observation, including unrelated read questions on the same tab
- 2-minute TTL will feel strict
- V4 cannot automate forms or guarantee transactional website effects
- Crash after dispatch may leave side-effect status unknown

**Follow-through:** `docs/plans/V4-prepare-approval-execute.md` (locked). Implementation is not authorized by this ADR alone; the plan must be the explicit current task.

## Alternatives considered for V4 scope

| Alternative | Why not V4 |
|-------------|------------|
| Also EXECUTE type/select | Reopens sensitive fields and native-select identity |
| Multi-step prepare of whole checkout | That is V5 workflow |
| Keep DEFER_EXECUTE as permanent denial | Leaves ADR-004 reservation unimplemented |
| Policy-in-UI / model-in-the-loop approval | Untrusted strings would become authority |
