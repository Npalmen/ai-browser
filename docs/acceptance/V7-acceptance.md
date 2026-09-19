# V7 acceptance evidence

**Base implementation:** `d3e1306f8c8d483b58191f709c94a4c02ed8c1df` (`Implement V7 workflows product surface`)  
**Acceptance candidate:** `fa647d4e780f9f97c5088af9bfa51182116d59d4` (`Add V7 persistent workflow acceptance`)  
**Closure docs:** Commit B (`Close V7 persistent workflow milestone`)  
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
npm run test:v7-acceptance                 PASS (44 tests + Electron runner exit 0)
```

Targeted suite used while building the candidate (also green):

```text
npx tsx --test src/v7-acceptance/*.test.ts                               PASS (44 tests)
```

Dedicated Electron marker (printed by the harness immediately before `app.exit(0)`):

```text
[v7-electron-persistent-workflow] PASS
```

Official `npm run test:v7-acceptance` Electron child exited 0. On this Windows host, Electron GUI-process `console.log` is not always inherited into the npm log; the runner still fails closed on non-zero child status.

`npm run test:v2-catalog-live` and `npm run smoke:v2-gateway` were not run.

## Fixtures

Localhost only, served by the existing observation fixture server. Temporary workflow store / Electron `userData` directories only — never the developer `app.getPath('userData')` workflow file.

```text
/agent-run/two-safe.html                 Safe control A
/autonomous-task/background.html         unrelated foreground tab
/approval/consequential.html             Buy now V4 approval
/agent-run/prompt-injection.html         hostile page/subgoal text (static)
```

Recording planner and child model runtimes only. `AI_GATEWAY_API_KEY` deleted and asserted unset in the Electron harness.

## V7 TypeScript acceptance (44)

Scenario groups:

```text
architecture-security     10   single-instance lock order; persistence denylist;
                               workflowId/occurrenceId off V3–V6 grants; product-view strip;
                               scheduler queue-only; runner createTab/closeTab only;
                               trusted typed IPC + fixed preload; no cron/reviewRequired write;
                               Ask/Act/Delegate unchanged; no V8 daemon/webhook; no auto retry
persistence-recovery       7   reconstruct definition/history; queued survives;
                               running → interrupted + review; ack is not retry;
                               unknown stop barrier; frozen revision; disable/delete;
                               corrupt/missing+backup/aside/newer schema fail closed
scheduler-idempotency      5   one-time/daily/weekly one row per slot; restart no duplicate;
                               history compaction keeps scheduled dedupe anchor;
                               misfire coalesce + no hole fill; Stockholm/NY/Kathmandu DST
lifecycle-concurrency     11   markRunningGate vs manual busy; manual-first FIFO drain;
                               Resume busy while workflow owns slot; FIFO skip review-required;
                               queue then attach same occurrence; notify after durable commit;
                               disable keeps queued; pause/startup-pending hold slot;
                               detach stale manual; live loss → unknown; persist-fail disables auto-run;
                               stop/cancel identity
product-security           5   extra/authority fields rejected; views strip internals;
                               page injection has no schedule authority; Workflows ≠ AiPanelMode;
                               approval-required forces Assistant; storage-error + stale detail
chain-acceptance           6   full DurableWorkflow → runner → V6 → V5 → V3/V4 → adapter click;
                               frozen URL after edit; per-occurrence V4 approval + free-text no;
                               reject without retry; post-dispatch unknown no second click;
                               queued restart fresh tab/task; running reconstruct no replay
```

## Electron proof

```text
real BrowserWindow + WebContentsView
real ElectronBrowserAdapter
production V3/V4/V5/V6/V7 classes
PersistentWorkflowRuntime.initialize / dispose reconstruction (no private-field mutation)
recording planner/child runtimes
localhost fixtures
temporary userData + workflows directory
```

Restart / reconstruction:

```text
runtime A persists definition to workflows-v1.json
runtime A2 reloads same workflowId / objective / URL
no tabId/taskId on disk
new runtimeSessionId
```

Queued vs running:

```text
queued occurrenceId survives
fresh runtime starts that same occurrence
new background WebContentsView tab + fresh V6 task
foreground user tab remains active
fixture __v5Markers.safeA >= 1 through production click (no test DOM click)
running occurrence + event forwarding dropped → interrupted + reviewRequired
reconstructed runtime does not replay clicks
```

Approval:

```text
Buy now → approval-required
adapterPrimitiveInvoked = false, click count = 0, fixture buy = 0
free-text yes / approve / do it does not approve
ApprovalWorkflowController.decide(approve) → one click, fixture buy = 1
occurrence completes durably
```

Unknown / no-retry:

```text
post-dispatch InteractionError after one real click
V7 occurrence execution-state-unknown
reconstruct + flush: click count remains 1
```

UI / preload:

```text
website fixture: window.workflows undefined, window.ipcRenderer undefined
trusted app-ui window with production app-preload: window.workflows.getState is a function
```

Second-instance proof: **static source ordering only** (not a multi-process spawn). `app.requestSingleInstanceLock()` occurs before `initializePersistentWorkflowRuntime`. The loser branch calls `app.quit()` with no path to WorkflowStore, scheduler, runner, or due evaluation. A live two-process spawn was not added because it would be fragile in this harness.

## Persistence / scheduler / slot

```text
durable intent survives reconstruction; live tab/task/approval/grant do not
queued starts the existing row after a fresh binding
running + foreign session → interrupted + reviewRequired; acknowledge is not retry
unknown remains terminal and blocks schedule/manual start until acknowledge
scheduled identity workflowId + scheduledForUtc is idempotent across restart and compaction
missed recurring slots coalesce to latest due; historical holes are not filled
DST: Europe/Stockholm gap skipped, fall overlap first occurrence; America/New_York; Asia/Kathmandu
one V6 slot: pending durable claim rejects manual; opposite race keeps workflow queued;
  paused workflow still owns the slot; awaiting-approval holds the slot
FIFO skips disabled/review-required older rows without deleting them
corrupt canonical + backup present → storage-error, no auto-promote
canonical missing + backup or owned aside → fail closed
schemaVersion 99 → storage-error, no downgrade
app/runtime dispose clears the process-local scheduler timer; no daemon
```

## Product / IPC / security

```text
assertTrustedAppSender first on workflow handlers
typed fixed payloads; extra/unknown/authority fields rejected, not dropped
no cron / RRULE / natural-language schedule
edit(... reviewRequired:false) rejected; only acknowledgeReview clears the flag
renderer views omit tabId, taskId, runId, grants, triggerKey, runtime sessions, frozenDefinition
window.workflows is a fixed typed preload API; no generic invoke
page/model strings cannot create/edit/enable/run/acknowledge/approve workflows
no workflow approval controls on WorkflowsPanel
Ask / Act / Delegate remain; Workflows is a separate right-panel surface
```

## Narrow production fixes uncovered by acceptance

None. Acceptance used production classes as-is. Test fixtures were adjusted where they violated production rules (completed occurrences require `finalAnswer`; `markOccurrenceRunning` is refused while the definition is disabled).

## Electron first-attempt record

While building the candidate (before Commit A):

```text
1. app.disableHardwareAcceleration() can only be called before app is ready
   cause: awaited mkdtemp/mkdir before disableHardwareAcceleration; fixed with sync temp dirs
2. queued occurrence did not complete (clicks=0) on one development run
   subsequent runs completed; official matrix Electron child exited 0
3. Official npm run test:v7-acceptance Electron runner exit 0
```

Official `npm run test:v5-acceptance` Electron run used the existing V5 runner retries: first attempt `agent-run-failed` / `ACTION_FAILED`, retry `[v5-electron-agent-loop] PASS`. V5 TypeScript assertions were not changed.

## No live / paid model calls

```text
npm run test:v2-catalog-live   not run
npm run smoke:v2-gateway       not run
AI_GATEWAY_API_KEY             deleted and asserted undefined in the Electron harness
AiSdkGatewayRuntime            not used by V7 acceptance
no live OpenAI / Anthropic / Google
no live external websites
```

## Known limitations

These define current V7 scope; they are not bugs.

```text
app must be open for workflows to execute
no daemon/cloud execution
no webhook triggers
no cron/RRULE
manual + one-time + daily + weekly only
one active workflow occurrence
one V6 task
workflow consequential actions still require user V4 approval
no cross-device sync
no cross-process live continuation
interrupted active work is not resumed
review acknowledgement is not retry
no persisted browser authority
V4 EXECUTE remains click-only
sensitive typing remains non-approvable
```
