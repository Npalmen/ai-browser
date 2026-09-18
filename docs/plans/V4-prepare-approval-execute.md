# Plan: V4 — PREPARE_ACTION, APPROVAL, and EXECUTE

**Status:** complete  
**Explicit reference:** Implementation tasks must cite `docs/plans/V4-prepare-approval-execute.md` to treat this file as authoritative.

Authoritative architecture:

```text
docs/architecture/ADR-005-approval-execute-authority.md
docs/architecture/ADR-004-interaction-authority.md
docs/architecture/browser-architecture.md
docs/architecture/ADR-001-browser-runtime.md
docs/architecture/ADR-002-page-observation.md
docs/architecture/ADR-003-model-runtime-routing.md
docs/plans/V3-interact-foundation.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
```

V0 (shell), V1 (observation), V2 (read-only agent), and V3 (permissioned INTERACT) are **complete**. V2 and V3 remain the default safe paths and must not be regressed.

This plan implements ADR-005. It does not start V5 agent loops.

---

## Objective

Deliver **one prepared consequential click, one deliberate approval, and at most one EXECUTE attempt**:

```text
interact-mode proposal (existing click schema)
→ local bind
→ policy DEFER_EXECUTE
→ PreparedAction (no browser mutation)
→ trusted app approval UI
→ ApprovalDecision (approve | reject)
→ single-use ExecuteGrant
→ ExecuteExecutor → existing BrowserAdapter.click
→ mandatory fresh observation
```

Safe V3 `ALLOW_INTERACT` / `ALLOW_NAVIGATE` paths stay on `InteractionExecutor`.

```text
DEFER_EXECUTE ≠ EXECUTE permission
user approval ≠ generic permission to act
```

Approval authorizes exactly one prepared action.

## Out of scope

Do not implement in V4:

```text
autonomous observe→act loops
multi-step form filling as one task
persistent workflows / task state
recursive planning
approval queues
always-approve policy
approval persistence across restart
password / card / OTP / credential filling
native select EXECUTE
type EXECUTE
downloads / uploads as EXECUTE
BrowserAdapter.buy/send/delete
model tool-calling
website approval IPC
fuzzy retargeting
automatic EXECUTE retry
PREPARE_ACTION that mutates the page
V5 agent loop
```

V3 sensitive-field denials remain denials. Approval cannot upgrade them.

## Model policy

```yaml
model:
  default: composer-2.5
  escalation_allowed: true
  escalation_reason: >
    Use Grok 4.6 only for approval/execute authority changes involving
    idempotency, race conditions, TOCTOU, destructive-action semantics,
    or a required architecture revision.
```

No automatic escalation for ordinary implementation, tests, or UI.

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

Per phase: targeted tests for that phase only.

At milestone closure (Phase 6):

```text
npm run typecheck
npm run test:ai
npx tsx --test src/interaction/*.test.ts
npm run test:observation
npm run test:fixture
npm run test:v2-acceptance
npm run test:v3-acceptance
npm run test:v4-acceptance   # added by this plan; localhost only
```

No live catalog test. No Gateway smoke. No network. No paid model calls.

## Permissions

Grant only what a later implementation prompt authorizes. This locked plan does **not** by itself grant git or live permissions to a future implementation task.

```yaml
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

---

## Authority reminder

Preserve the V3 chain. Extend it; do not replace it.

```text
model
→ structured intent
→ strict validator
→ local identity binding
→ deterministic policy
→ grant
→ executor
→ BrowserAdapter
```

Preferred V4 modules (names may differ if a smaller layout is cleaner):

| Module | Responsibility |
|--------|----------------|
| Shared types | `PreparedAction`, `ApprovalDecision`, `ExecuteGrant`, categories, view DTO, result states |
| `PrepareActionService` | `DEFER_EXECUTE` + click → freeze identity, category, summary |
| `PreparedActionStore` / `ApprovalManager` | state machine, TTL, idempotency, invalidate |
| `ExecuteExecutor` | consume `ExecuteGrant`; V3 click primitive; one post-observation |
| `InteractionExecutor` | **unchanged role:** safe INTERACT/NAVIGATE only |
| Controller / IPC / UI | `approval:decide` / `approval:event`; trusted sender; no handles |

Do not teach `InteractionExecutor.execute()` an `approved` flag.

Do not expand the model output schema for basic V4.

---

## Locked product rules

Copied from ADR-005; implementation must not weaken them.

1. **EXECUTE = approved consequential click** only.
2. Only `DEFER_EXECUTE` may prepare. `DENY` / `TARGET_SENSITIVE` / unsupported / stale never become approvals.
3. PreparedAction binds exact `tabId` / `observationId` / `documentRevision` / `targetId` / `kind='click'`.
4. No rebind. No name/text/CSS/coordinate/nearest recovery.
5. Any superseding observation for the tab makes the prepared action stale.
6. Renderer decide payload is only `{ approvalId, decision }`.
7. `approvalId` alone does not authorize execution.
8. `ExecuteGrant` is single-use. `claimExecuteGrant` consumes the approval even if later `executing → stale` or `executing → failed` before dispatch. One adapter click max; no automatic retry; no second grant from the same approval.
9. TTL = 2 minutes; injectable clock.
10. Max one pending PreparedAction per tab; a new prepare invalidates the previous.
11. In-memory only; restart clears pending approvals.
12. Post-dispatch observation failure → `execution-attempted-state-unknown`, not retry. After `adapterPrimitiveInvoked = true`, never `stale`, `failed`, `rejected`, or `expired`.
13. Grant claim ≠ `BrowserAdapter.click` entry ≠ first `Input.dispatchMouseEvent`. `adapterPrimitiveInvoked` is true only at the input-dispatch boundary. `executing → stale` / `executing → failed` are legal only while that fact is false.
14. Final purchase/sign-in click may be prepared after the user manually filled secrets; secrets stay unexported.
15. Cancel of the original AI request must not execute. Pending approval is independent after prepare, but a new same-tab AI request invalidates it.
16. Tab close, dispose, navigation/reload → invalid/stale.

---

## Chapters / phases

| Phase | Scope | Verification | Notes |
|-------|-------|--------------|-------|
| 1 | Shared types + state machine + TTL + idempotency | targeted unit tests, no UI/browser | No adapter calls |
| 2 | PrepareActionService + category/summary + audit | targeted | DEFER_EXECUTE → prepared; still no click |
| 3 | ApprovalManager + trusted IPC decide/events | targeted | approve/reject/expire/stale; no execution |
| 4 | ExecuteExecutor + single-use grant + V3 click + observation | targeted + fixture | unknown-after-dispatch |
| 5 | Controller/UI wiring + approval panel + races | targeted | renderer-safe events |
| 6 | Localhost Electron acceptance + security gates + closure | V2+V3+V4 acceptance | no live models |

### Phase 1 — types and state machine

Add project-owned types (likely `src/shared/approval-types.ts` or adjacent) and `PreparedActionStore` / `ApprovalManager` with the full in-memory transition model. Conceptual operations (names may differ):

```text
prepare
decide
claimExecuteGrant
markStaleBeforeDispatch
markFailedBeforeDispatch
markExecuted
markExecutionStateUnknown
invalidateTab
expire(now)
```

Internal stage facts (not renderer-visible; no browser handles):

```text
grantIssued
grantClaimed
adapterPrimitiveInvoked
postObservationSucceeded
```

Phase 1 must implement and unit-test:

```text
pending → approved
approved → executing
approved → stale
executing → stale before dispatch
executing → failed before dispatch
executing → executed
executing → execution-attempted-state-unknown
```

Also prove:

- illegal transitions throw or return explicit terminal errors
- no return to `pending` or `approved`
- duplicate decide cannot issue two grants
- approve/reject race: one winner
- expire-before-approve: no grant
- injectable clock
- claimed grant then stale before dispatch → state `stale`; grant cannot be reclaimed
- claimed grant then failed before dispatch → state `failed`; grant cannot be reclaimed
- adapter-dispatch boundary represented distinctly from grant claim (`adapterPrimitiveInvoked` vs `grantClaimed`)
- after `adapterPrimitiveInvoked = true`, `stale` / `failed` / `rejected` / `expired` are illegal

No BrowserAdapter. No UI. Phase 1 does not dispatch browser input; it records the dispatch-boundary fact so later phases cannot collapse claim and click.

### Phase 2 — prepare from DEFER_EXECUTE

`PrepareActionService` consumes a bound click proposal whose policy outcome is `DEFER_EXECUTE`.

- Build bounded category + plain-text summary from already-redacted observation metadata
- Cap/truncate summary
- One pending per tab (invalidate previous)
- Audit: `prepared`, `approval-presented`
- Non-`DEFER_EXECUTE` outcomes must not prepare

InteractiveAgent/controller may still return denied until Phase 5 wires `approval-required`.

### Phase 3 — approval IPC without execution

Trusted-app channels:

```text
approval:decide
approval:event
```

`assertTrustedAppSender` exact rule. Preload expose is decide-only: `approvalId` + `approve|reject`.

Prove website/preload cannot create or decide approvals. Prove renderer cannot send `targetId`.

`claimExecuteGrant` may exist but Phase 3 tests must not call the adapter.

### Phase 4 — ExecuteExecutor

Consume `ExecuteGrant` after Phase 3 approval. Do not call `claimExecuteGrant` from ApprovalController. Phase 4 owns grant claim + execution.

Conceptual sequence:

```text
approval approved
→ claimExecuteGrant()
→ state = executing
→ grant consumed

→ resolve exact TargetRegistry record
   tabId / observationId / targetId / documentRevision
   currentObservationId(tabId) == grant.observationId
   resolve(tabId, observationId, targetId)
   record.documentRevision == grant.documentRevision

→ if registry identity invalid:
     markStaleBeforeDispatch
     return stale

→ build AdapterClickRequest from trusted TargetRecord
   frameId / backendNodeId / documentRevision
   no coordinates on ExecuteGrant / PreparedAction
   observedBounds may be omitted

→ BrowserAdapter.click({
     target,
     onBeforeInputDispatch: () => {
       ApprovalManager.markAdapterPrimitiveInvoked(executionId)
     }
   })

BrowserAdapter internal flow:
   session / debugger setup
   document revision preflight
   frame preflight
   live box/geometry preflight

   if any of these fail:
     callback has not fired
     adapterPrimitiveInvoked = false

   callback fires exactly once
   Input.dispatchMouseEvent...

→ if click resolves:
     observePage(tabId) exactly once
     success → markExecuted → executed
     failure → markExecutionStateUnknown

→ if click rejects:
     inspect manager facts
     adapterPrimitiveInvoked = false:
       TARGET_STALE / TARGET_NOT_FOUND / PAGE_CHANGED / TAB_NOT_FOUND
         or executor-detected registry mismatch → markStaleBeforeDispatch
       other InteractionError (UNSUPPORTED_FRAME, session/debugger,
         INTERACTION_IN_PROGRESS, INTERACTION_FAILED, …) → markFailedBeforeDispatch
     adapterPrimitiveInvoked = true:
       markExecutionStateUnknown
```

No automatic retry. No second grant. No new CDP methods. No full PageObservation stored on PreparedAction. No re-observe-and-rebind. V3 click requests omit the hook.

Required Phase 4 tests:

```text
registry stale before adapter call
→ stale / adapterPrimitiveInvoked false

document revision failure inside click preflight
→ stale / adapterPrimitiveInvoked false

target box unavailable inside click preflight
→ stale / adapterPrimitiveInvoked false

debugger/session preflight failure
→ failed / adapterPrimitiveInvoked false

hook fires then dispatch rejects
→ execution-attempted-state-unknown / adapterPrimitiveInvoked true

click resolves then observe fails
→ execution-attempted-state-unknown / adapterPrimitiveInvoked true

click resolves + observe succeeds
→ executed / adapterPrimitiveInvoked true

successful click → hook exactly once
preflight error → hook zero times
input failure after hook → hook exactly once
```

Grant remains consumed for every post-claim outcome.

Reuse `ElectronBrowserAdapter.click`. Optional in-process `onBeforeInputDispatch` only. The hook must never appear in IPC, renderer DTOs, preload, UI, or model schema.

### Phase 5 — product wiring

In `interact` mode:

```text
supported DEFER_EXECUTE click → approval-required
other denials → interaction-denied (unchanged)
safe allows → existing interaction-completed path
```

Trusted approval chrome: summary, Approve, Reject. Plain text only.

Handle duplicate Approve, Approve+Reject, expiry, stale-while-open.

New same-tab ask invalidates pending approval.

### Phase 6 — acceptance and closure

Deterministic fixtures (localhost only), for example under `fixtures/approval/` or by extending `fixtures/interaction/`:

```text
Send message
Submit
Buy now / Confirm purchase
Delete
Publish
Book / Reserve
Save account change
```

Plus adversarial cases from ADR-005.

Add `src/v4-acceptance/` and `test:v4-acceptance`. Do not repurpose `test:v2-acceptance` or `test:v3-acceptance`.

Recording/fake model runtime only. `AI_GATEWAY_API_KEY` unset.

---

## Adversarial acceptance (required)

Each must fail safely or land in a precise terminal state:

```text
page changes after approval shown
target removed
target replaced by a visually identical control
new observation supersedes prepared action
duplicate Approve
Approve + Reject race
approval after TTL
tab closed
browser disposed
prompt-injection text says the action is already approved
malicious model output claims approval / authority=EXECUTE
website navigates while approval pending
post-click observation fails
claimed grant then stale before dispatch
claimed grant then mechanical fail before dispatch
sensitive password type proposal
unsupported combobox
stale consequential button
```

---

## Model / IPC / UI constraints

- No model schema expansion required
- No approval IDs in model context
- No `ai:click` / `ai:execute` / `ai:grant` / `ai:proposal` channels
- No preload `click()` / `execute()` / `runInteraction()`
- Ask input remains `tabId` + `question` + `mode`
- Decide input is only `approvalId` + `decision`
- `window.aiAssistant` may gain a decide method; it must not gain primitive execution methods

---

## Completion criteria

V4 is complete when ADR-005 is implemented and all gates below are green.

```text
[x] model cannot self-approve
[x] website cannot approve
[x] renderer cannot specify target/proposal
[x] only DEFER_EXECUTE-supported actions prepare
[x] DENY cannot be approved
[x] sensitive typing cannot be approved
[x] approval exact-target binding survives no rebind
[x] stale page prevents execution
[x] expired approval prevents execution
[x] duplicate approval produces <=1 execute attempt
[x] approve/reject race produces one terminal decision
[x] ExecuteGrant single-use
[x] one BrowserAdapter primitive max
[x] no automatic EXECUTE retry
[x] claimed grant then stale/failed before dispatch is terminal; grant cannot be reclaimed
[x] BrowserAdapter.click entry is not treated as input dispatch
[x] post-dispatch observation failure represented as execution-attempted-state-unknown, never stale/failed
[x] approval UI contains no execution handles
[x] audit contains no sensitive values
[x] V2 acceptance green
[x] V3 acceptance green
[x] V4 acceptance green
```

Phase 6 is green. Closure evidence is below.

### Closure evidence

```text
Architecture:
ef31d0f Lock V4 approval and execute authority architecture

Phase 1:
64a5ef9 Implement V4 approval authority state machine
18b043a Harden V4 approval authority atomicity
312947a Clarify V4 pre-dispatch execution states

Phase 2:
2e60586 Implement V4 consequential action preparation

Phase 3:
e7370a4 Implement V4 trusted approval decision boundary

Phase 4:
d74704b Implement V4 single-use approved execution
8bd9493 Clarify V4 approved click dispatch boundary
12782fb Isolate V4 execution authority from audit failures

Phase 5:
58ef735 Wire V4 approval workflow into product

Phase 6 acceptance:
2ba44e339f76c3f5d6abbc3ec56a0ba99d1eb75e Add V4 approval acceptance coverage
```

### Closure verification (2026-09-18)

Final candidate: `2ba44e339f76c3f5d6abbc3ec56a0ba99d1eb75e`

```text
npm run typecheck                          PASS
npm run test:ai                            PASS (208 tests)
npm run test:observation                   PASS (40 tests)
npm run test:fixture                       PASS (7 tests)
npm run test:v2-acceptance                 PASS (29 tests + [v2-electron-observation] PASS)
npm run test:v3-acceptance                 PASS (29 tests + [v3-electron-interaction] PASS)
npm run test:v4-acceptance                 PASS (46 tests + [v4-electron-approval] PASS)

npx tsx --test src/approval/*.test.ts      PASS (84 tests)
npx tsx --test src/main/approval*.test.ts  PASS (38 tests)
npx tsx --test src/app-ui/*.test.ts        PASS (24 tests)
npx tsx --test src/interaction/*.test.ts   PASS (87 tests)
npx tsx --test src/browser/tab-invalidation.test.ts
           src/browser/interaction-primitives.test.ts
                                           PASS (23 tests)
```

Live/paid model calls were not run (`test:v2-catalog-live` and `smoke:v2-gateway` were not invoked; `AI_GATEWAY_API_KEY` was unset).

See `docs/acceptance/V4-acceptance.md`.

---

## Future milestone (V5+) — explicit handoff

V5 owns:

```text
multi-step observe→act loops
orchestrating V3 INTERACT then V4 EXECUTE as one user task
richer prepare (non-click) only with a new ADR
audit persistence
```

V4 remaining denials that stay denied unless a later ADR says otherwise:

```text
type payment card / password / OTP
custom combobox EXECUTE
downloads / protocol handlers
always-approve
```
