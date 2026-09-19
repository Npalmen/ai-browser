# V6 acceptance evidence

**Base implementation:** `05ff274081704e872d0fce0a4e228e726bdda564` (`Quiesce V6 orchestration before lifecycle drains`)  
**Acceptance candidate:** `b633acb01f131f2e4738e44e80b82bc63b3d4ae7` (`Add V6 autonomous task acceptance`)  
**Closure docs:** Commit B (`Close V6 autonomous task milestone`)  
**Date:** 2026-09-19

## Commands run on the acceptance candidate

```text
npm run typecheck                          PASS
npm run test:ai                            PASS (226 tests)
npm run test:observation                   PASS (40 tests)
npm run test:fixture                       PASS (11 tests)
npm run test:v2-acceptance                 PASS (29 tests + [v2-electron-observation] PASS)
npm run test:v3-acceptance                 PASS (29 tests + [v3-electron-interaction] PASS)
npm run test:v4-acceptance                 PASS (46 tests + [v4-electron-approval] PASS)
npm run test:v5-acceptance                 PASS (31 tests + [v5-electron-agent-loop] PASS)
npm run test:v6-acceptance                 PASS (52 tests + [v6-electron-autonomous-task] PASS)
```

Targeted suites used while building the candidate (also green):

```text
npx tsx --test src/v6-acceptance/*.test.ts                               PASS (52 tests)
npx tsx --test src/autonomous-task/autonomous-task-child-run-executor.test.ts
npx tsx --test src/main/autonomous-task-controller.test.ts
```

Dedicated Electron marker:

```text
[v6-electron-autonomous-task] PASS
```

`npm run test:v2-catalog-live` and `npm run smoke:v2-gateway` were not run.

## Fixtures

Localhost only, served by the existing observation fixture server:

```text
/agent-run/two-safe.html                 Safe control A / Safe control B
/autonomous-task/background.html         unrelated foreground tab
/autonomous-task/popup-click.html        Open related → window.open popup-child
/autonomous-task/popup-child.html        adopted popup marker
/autonomous-task/delayed-popup.html      setTimeout window.open (TS delayed-popup proof)
/approval/consequential.html             Buy now V4 approval
/interaction/policy-deny.html            V3 DENY
/agent-run/prompt-injection.html         hostile page/subgoal text
```

## Live Electron authority proof

Recording planner and child model runtimes only. `AI_GATEWAY_API_KEY` deleted and asserted unset.

```text
real BrowserWindow + WebContentsView
real ElectronBrowserAdapter
production V3/V4/V5/V6 classes via createV6ProductChain
no direct fixture DOM mutation to simulate agent actions
```

Session-background continuation:

```text
task owns A and starts a real child click on A
user activates unrelated B
browser activeTabId remains B
child click on A still occurs (clickOnA >= 1) through SafeAgentLoop → V3/V4 → ElectronBrowserAdapter
after completion B is still foreground
```

Causal popup:

```text
task child click on A → website window.open during input-dispatch scope
converted WebContentsView C is adopted as task-created
B remains foreground when it was already active
no test call to coordinator.adoptTaskTab
```

Consequential V4 approval:

```text
task child Buy now → approval-required
adapterPrimitiveInvoked = false and click count = 0 until trusted decide
free-text yes/approve/do it does not approve
ApprovalWorkflowController.decide(approve) → one browser click
taskApprovalCount = 1, task completes
```

## Core V6 scenarios (TypeScript acceptance)

```text
basic delegate → one child → planner complete; plannerStepCount=2 childRunCount=1; one delegation turn
two sequential children; never two active; fresh AgentRunRef; one final turn
background continuation while unrelated tab is active
causal popup adopted; explicit and delayed popups rejected
owned-tab budget 3; fourth causal popup not owned
planner budget 8; no ninth model call
child-run budget 4; no fifth AgentRun
approval budget 4; fifth consequential action blocked before PrepareAction
two independent V4 approvals; distinct approvalId / PreparedAction / ExecuteGrant
V3 DENY → POLICY_BLOCKED; no approval, no replan
approval Reject → APPROVAL_REJECTED; planner does not resume
TTL expiry → APPROVAL_EXPIRED; no execute
natural stale → ACTION_STALE; no reprepare
V4 unknown → task execution-state-unknown; no retry; no completed turn
Pause during planner; late planner ignored
Pause during child; child-completes-at-cancel race; late child ignored
Pause awaiting approval pre-dispatch → stale, not ACTION_STALE
Pause/Stop after dispatch executed vs unknown
Resume fresh generation/epoch; renderer never receives generation
trusted chrome navigation pauses; generic agent navigation does not
execution-tab close vs reference-tab close vs last paused tab
manual Act isolation on unowned tab; blocked on active owned tab; paused takeover
TASK_NO_PROGRESS vs fingerprint change after trusted navigation
hostile page/subgoal text cannot raise limits, own tabs, approve, or mint grants
malicious planner authority fields → MODEL_OUTPUT_INVALID
free-text cannot approve; approval:decide still works
unknown alias cannot expand workspace
dispose/restart destroys tasks; second task can start after the first completes
Ask = ReadOnlyAgent; Act = AgentRunController; Delegate = AutonomousTask
```

## Authority / security proofs

```text
planner does not import BrowserAdapter / ApprovalManager / mint grants / target DOM
AutonomousTaskController does not click/type/select/scroll or call ApprovalWorkflowController.decide
child execution goes only through the V5 AgentRunExecutor port
taskId is absent from InteractionGrant, PreparedAction, ApprovalDecision, ExecuteGrant, AgentRunRef, AdapterClickRequest
one child AgentRun and one mutation chain at a time
no automatic EXECUTE retry after post-dispatch unknown (primitive count = 1)
renderer events omit generation, runId, AgentRunRef, approvalId, preparedActionId, executionId, targetId, observationId, documentRevision, backendDOMNodeId, frameId, InteractionGrant, ExecuteGrant, raw planner instruction
V6 IPC is start/pause/resume/stop/reply/get-state only; payloads reject generation, approvalId, targetId, approved, budgets
no task persistence (no fs/localStorage/IndexedDB/sqlite/task JSON)
no schedules / cron / runAt / webhook resume
```

## Narrow production fixes uncovered by acceptance

- `AgentRunExecutor.stopExact` no-ops coordinator cancel when the run is already terminal, so dispose after blocked/unknown does not throw.
- `AutonomousTaskChildRunExecutor` maps an ignored AgentRun completion during requested lifecycle cancel to `lifecycle-cancelled` instead of `CHILD_RUN_FAILED`.
- Terminal tasks release `TaskTabStateRegistry` workspace tracking so a later AutonomousTask can start on the same runtime.
- Inactive task tabs remain in the Electron view hierarchy (hidden/offscreen, background throttling disabled) so CDP observe/click continues after the user activates another tab; background clicks do not steal OS focus.

## Electron first-attempt record

Dedicated harness while building the candidate:

```text
1. Timed out waiting for acceptance condition
2. background task did not complete (state=running-subgoal, clicksOnA=1)
   cause: CDP on a fully detached inactive WebContentsView
3. popup task did not start: INVALID_REQUEST
   cause: TaskTabStateRegistry still tracked the completed task's starting tab
4. approval-required was not emitted (state=failed)
   cause: harness started the approval task on foreground B instead of A
5. [v6-electron-autonomous-task] PASS
```

Official `npm run test:v6-acceptance` Electron run: **PASS on first attempt**.

Official `npm run test:v5-acceptance` Electron run used the existing V5 runner retries: first attempt `agent-run-failed` / `ACTION_FAILED`, second attempt timeout, third attempt `[v5-electron-agent-loop] PASS`. V5 TypeScript assertions were not changed. A later dedicated first-attempt rerun of the V5 harness passed.

## No live / paid model calls

```text
npm run test:v2-catalog-live   not run
npm run smoke:v2-gateway       not run
AI_GATEWAY_API_KEY             deleted and asserted undefined in the Electron harness
AiSdkGatewayRuntime            not used by V6 acceptance
```

## Known limitations

These define current V6 scope; they are not bugs.

```text
V4 EXECUTE remains click-only
sensitive typing remains non-approvable
tasks are session/in-memory only
no process-restart continuation
no schedules
one active AutonomousTask per runtime
child runs sequential only
no background execution after Electron process closes
```
