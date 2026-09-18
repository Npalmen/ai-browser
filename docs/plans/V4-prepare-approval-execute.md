# Plan: V4 — PREPARE_ACTION, APPROVAL, and EXECUTE

**Status:** locked  
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
8. `ExecuteGrant` is single-use; one adapter click max; no automatic retry.
9. TTL = 2 minutes; injectable clock.
10. Max one pending PreparedAction per tab; a new prepare invalidates the previous.
11. In-memory only; restart clears pending approvals.
12. Post-dispatch observation failure → `execution-attempted-state-unknown`, not retry.
13. Final purchase/sign-in click may be prepared after the user manually filled secrets; secrets stay unexported.
14. Cancel of the original AI request must not execute. Pending approval is independent after prepare, but a new same-tab AI request invalidates it.
15. Tab close, dispose, navigation/reload → invalid/stale.

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

Add project-owned types (likely `src/shared/approval-types.ts` or adjacent) and `PreparedActionStore` / `ApprovalManager` with:

```text
prepare
decide
claimExecuteGrant
invalidateTab
expire(now)
```

Prove:

- illegal transitions throw or return explicit terminal errors
- duplicate decide cannot issue two grants
- approve/reject race: one winner
- expire-before-approve: no grant
- injectable clock

No BrowserAdapter. No UI.

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

Consume `ExecuteGrant`:

```text
registry current observation
documentRevision
exact target
V3 live click preflight
Input.dispatchMouseEvent path only
observePage once
consume grant even on failure
```

Map:

- pre-dispatch failure → `failed` / `stale`, adapter 0
- post-dispatch observation failure → `execution-attempted-state-unknown`, adapter 1, no retry

Reuse `ElectronBrowserAdapter.click`. No new CDP methods.

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
[ ] model cannot self-approve
[ ] website cannot approve
[ ] renderer cannot specify target/proposal
[ ] only DEFER_EXECUTE-supported actions prepare
[ ] DENY cannot be approved
[ ] sensitive typing cannot be approved
[ ] approval exact-target binding survives no rebind
[ ] stale page prevents execution
[ ] expired approval prevents execution
[ ] duplicate approval produces <=1 execute attempt
[ ] approve/reject race produces one terminal decision
[ ] ExecuteGrant single-use
[ ] one BrowserAdapter primitive max
[ ] no automatic EXECUTE retry
[ ] post-dispatch observation failure represented as unknown/failed safely
[ ] approval UI contains no execution handles
[ ] audit contains no sensitive values
[ ] V2 acceptance green
[ ] V3 acceptance green
[ ] V4 acceptance green
```

Do not mark this plan complete until Phase 6 is green. Closure evidence (commit SHAs, command output) is filled then — not now.

### Closure evidence

```text
(filled at Phase 6 closure)
```

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
