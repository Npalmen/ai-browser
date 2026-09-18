# V5 acceptance evidence

**Base implementation:** `5a536747d06ed98fc9cf20a7a1a003f3dc496cbe` (`Wire V5 bounded agent runs into product`)  
**Acceptance candidate:** `dad7e76` (`Add V5 bounded agent loop acceptance`)  
**Closure docs:** Commit B (`Close V5 bounded agent loop milestone`)  
**Date:** 2026-09-18

## Commands run on the acceptance candidate

```text
npm run typecheck                          PASS
npm run test:ai                            PASS (220 tests)
npm run test:observation                   PASS (40 tests)
npm run test:fixture                       PASS (7 tests)
npm run test:v2-acceptance                 PASS (29 tests + [v2-electron-observation] PASS)
npm run test:v3-acceptance                 PASS (29 tests + [v3-electron-interaction] PASS)
npm run test:v4-acceptance                 PASS (46 tests + [v4-electron-approval] PASS)
npm run test:v5-acceptance                 PASS (31 tests + [v5-electron-agent-loop] PASS)
```

Targeted suites on the same candidate (also green before the final matrix):

```text
npx tsx --test src/agent-run/*.test.ts                                   PASS
npx tsx --test src/main/agent-run*.test.ts                               PASS
npx tsx --test src/main/ai-request-controller.test.ts                    PASS
npx tsx --test src/main/approval*.test.ts                                PASS
npx tsx --test src/app-ui/*.test.ts                                      PASS
npx tsx --test src/ai/interactive-step-agent.test.ts                       PASS
npx tsx --test src/ai/trusted-run-progress.test.ts                         PASS
```

Electron multi-step AgentRun marker:

```text
[v5-electron-agent-loop] PASS
```

## Fixtures

Localhost only, served by the existing observation fixture server.

### Agent-run routes (`fixtures/agent-run/`)

```text
/agent-run/two-safe.html              Safe control A + Safe control B (window.__v5Markers.safeA/safeB)
/agent-run/safe-navigation-a.html     Safe Next → navigates to safe-navigation-b
/agent-run/safe-navigation-b.html     Safe control B on destination page
/agent-run/multi-step.html            Safe A + Buy now + Publish (independent consequential controls)
/agent-run/repeat-safe.html           Repeatable same-document safe action + marker counter
/agent-run/prompt-injection.html      V5_PROMPT_INJECTION_CANARY in page text
```

### Reused V3/V4 routes

```text
/approval/consequential.html          consequential click markers
/approval/navigate-action.html        approved Buy now navigates to after-purchase.html
/approval/after-purchase.html         destination after approved navigation
/approval/replace-target.html         visually identical replacement target
/approval/consequential-select.html   deferred select
/interaction/sensitive-fields.html    password field
/interaction/policy-deny.html         V3 DENY control
```

Each relevant fixture action mutates `window.__v5Markers` (or existing V4 markers) so harnesses can prove no mutation before approval and exactly one mutation after successful execute.

## Live Electron authority proof

Recording model runtime only. `AI_GATEWAY_API_KEY` unset and verified `undefined` at harness start.

Production chain exercised without shortcuts:

```text
AgentRunController
→ SafeAgentLoop
→ InteractiveStepAgent
→ proposal binder
→ InteractionExecutor
→ (consequential) AgentRunApprovalBridge
→ PrepareActionService
→ ApprovalLifecycle
→ ApprovalWorkflowController
→ ApprovalManager
→ ExecuteExecutor
→ ElectronBrowserAdapter
```

Real `BrowserWindow`, `WebContentsView`, and `ElectronBrowserAdapter` with V4 reliability switches (renderer backgrounding disabled, visible focused window). Website view invariants unchanged: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, `webSecurity: true`.

### Scenario A — two safe actions then answer

```text
modelStepCount = 3
actionAttemptCount = 2
approvalCount = 0
safeA marker = 1, safeB marker = 1
AgentRun state = completed
ConversationStore = 1 durable turn (original question + final answer)
```

### Scenario B — safe navigation continues

```text
page A → Safe Next → page B → Safe control B → final answer
agent-caused main-frame navigation does NOT cancel AgentRun
post-action observation succeeds on destination
run completes
```

### Scenario C — safe action → consequential approval → resume

```text
before approval: consequential marker = 0, grantClaimed = false, adapterPrimitiveInvoked = false
awaiting-approval: no model calls, no browser mutation
after explicit Approve: one ExecuteGrant, one real click, marker = 1
modelStepCount = 3, actionAttemptCount = 3, approvalCount = 1
AgentRun resumes to running, then completes
```

### Approved navigating click

```text
/approval/navigate-action.html
Approve → dispatch → main-frame navigation during V4 execution
V4 reaches executed (not stale after dispatch)
AgentRun resumes and completes on destination page
```

## Unit/static acceptance coverage

`src/v5-acceptance/` — 31 tests across architecture/security gates, agent-loop lifecycle, and adversarial cases including:

```text
budget limits (model 8 / action 6 / approval 2)
no-progress guard and revision change permit
reject / expiry / DENY / sensitive type / deferred select
third approval blocked before prepare
supersede / late model result / different-tab independence
cancel while awaiting approval
two independent consequential approvals
visually identical replacement → ACTION_STALE
model self-approval / grant minting / runId authority static gates
renderer IPC / event privacy / Act routing / CDP / no persistence
Ask mode regression (ReadOnlyAgent, no AgentRun)
conversation: one completed turn, no failed-terminal commits, first-step prior context
trusted progress privacy
```

## Narrow production fix uncovered by acceptance

`ApprovalWorkflowController.decide()` now notifies AgentRun on `APPROVAL_EXPIRED` and `APPROVAL_STALE` at decision time so runs do not hang in `awaiting-approval` when approve is attempted at TTL boundary.

## Security / static gates

```text
one active AgentRun per tab; different tabs independent
model cannot raise loop budgets (8 / 6 / 2)
model cannot self-approve or mint grants
runId is correlation only; not on ExecuteGrant / PreparedAction / ApprovalDecision
renderer cannot inject target/proposal; no execute IPC channels
agent-run events omit authority handles
SafeAgentLoop isolated from BrowserAdapter / ExecuteGrant / IPC
production Act uses AgentRunController, not InteractiveAgent.interact()
no new production CDP methods
no AgentRun persistence or background autonomy
V2/V3/V4 acceptance semantics unchanged
```

## No live / paid model calls

```text
npm run test:v2-catalog-live   not run
npm run smoke:v2-gateway       not run
AI_GATEWAY_API_KEY             unset / not required
AiSdkGatewayRuntime            not used by V5 acceptance
```

## Known limitations

```text
V4 EXECUTE remains click-only; deferred select stays blocked in V5.
Sensitive typing cannot become approval.
Approvals and AgentRuns are in-memory only; process restart clears them.
Renderer crash is covered by lifecycle/unit paths (same tab-invalidation callback), not by crashing a live renderer in the Electron harness.
Live renderer-process crash test intentionally not executed in Electron harness; source + lifecycle tests prove the path.
V6 autonomous tasks and V7 persistent workflows are out of scope.
```
