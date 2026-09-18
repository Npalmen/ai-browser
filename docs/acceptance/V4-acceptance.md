# V4 acceptance evidence

**Candidate:** `2ba44e339f76c3f5d6abbc3ec56a0ba99d1eb75e`  
**Base:** `58ef73592a1f7e0c525f921d461785b799db776e` (`Wire V4 approval workflow into product`)  
**Date:** 2026-09-18

## Commands run on the candidate

```text
npm run typecheck                          PASS
npm run test:ai                            PASS (208 tests)
npm run test:observation                   PASS (40 tests)
npm run test:fixture                       PASS (7 tests)
npm run test:v2-acceptance                 PASS (29 tests + [v2-electron-observation] PASS)
npm run test:v3-acceptance                 PASS (29 tests + [v3-electron-interaction] PASS)
npm run test:v4-acceptance                 PASS (46 tests + [v4-electron-approval] PASS)
```

Targeted suites on the same candidate (also green before the final matrix):

```text
npx tsx --test src/approval/*.test.ts                                    PASS (84 tests)
npx tsx --test src/main/approval*.test.ts                                PASS (38 tests)
npx tsx --test src/app-ui/*.test.ts                                      PASS (24 tests)
npx tsx --test src/interaction/*.test.ts                                 PASS (87 tests)
npx tsx --test src/browser/tab-invalidation.test.ts
           src/browser/interaction-primitives.test.ts                    PASS (23 tests)
```

Electron approved-click marker:

```text
[v4-electron-approval] PASS
```

## Fixtures

Localhost only, served by the existing observation fixture server:

```text
/approval/consequential.html         Send / Submit / Buy now / Confirm purchase / Delete / Publish / Book / Reserve / Save changes
/approval/prompt-injection.html      consequential Buy now label plus V4_APPROVAL_PROMPT_INJECTION_CANARY
/approval/replace-target.html        visually identical replacement Buy now
/approval/navigate-action.html       approved Buy now navigates to after-purchase.html
/approval/after-purchase.html        V4_PURCHASE_NAVIGATED
/approval/consequential-select.html  deferred Delete account select
```

Each consequential control mutates `window.__v4Markers` so the harness can prove no mutation before approval, no mutation after reject, and exactly one mutation after successful execute.

## Live Electron authority proof

Recording model runtime only. `AI_GATEWAY_API_KEY` unset.

```text
before approval:     buy marker = 0, no ExecuteGrant, adapterPrimitiveInvoked = false
after reject:        buy marker = 0, no grant, no adapter click
after approve:       buy marker = 1, one grant, adapter click = 1, postObservationSucceeded = true, state = executed
duplicate decide:    buy marker remains 1, click remains 1
```

The approved click used `ElectronBrowserAdapter.click` → `executeAdapterClick` → `onBeforeInputDispatch` → `Input.dispatchMouseEvent`. Fixture DOM was not mutated from test code.

## Adversarial gates exercised

```text
prompt-injection canary does not self-approve
malicious model authority fields rejected as MODEL_OUTPUT_INVALID
sensitive password type → TARGET_SENSITIVE, no PreparedAction
deferred consequential select remains denied, click-only EXECUTE
stale observation / removed target / visually identical replacement → no click
new observation supersedes prepared action
duplicate Approve / Approve+Reject race → one winner
TTL: expiresAt - 1 valid, expiresAt expired
tab close / in-memory-only disposal / new same-tab request / clear conversation
website-originated main-frame navigation stales pending approval
approved navigating click stays executing then executed (not stale)
claimed grant stale or mechanical fail before dispatch is terminal
post-dispatch adapter failure and post-click observation failure → execution-attempted-state-unknown
failed renderer emission does not record approval-presented and does not execute
```

## Security / static gates

```text
model cannot emit approvalId / ExecuteGrant / authority EXECUTE / approved true
renderer decide payload is only approvalId + decision
approval IPC channels are exactly approval:decide and approval:event
preload exposes decideApproval / onApprovalEvent, not click/execute/grant
website WebContentsView has no preload
ApprovalCard renders summary as React text; Approve/Reject only in pending/deciding
Enter in AI textarea submits Ask/Act only
one production ApprovalManager shared across prepare, lifecycle, controller, workflow, execute
no new production CDP methods, Runtime.*, executeJavaScript, or DOM.resolveNode
```

## No live / paid model calls

```text
npm run test:v2-catalog-live   not run
npm run smoke:v2-gateway       not run
AI_GATEWAY_API_KEY             unset / not required
AiSdkGatewayRuntime            not used by V4 acceptance
```

## Remaining known limitations

```text
V4 EXECUTE is click-only. Deferred select stays denied.
Sensitive typing cannot be approved.
Approvals are in-memory only; process restart does not recover them.
Renderer crash is covered by the same tab-invalidation path as tab close, not by crashing a live renderer in the harness.
V5 agent loops, persistent workflows, and always-approve are out of scope.
```
