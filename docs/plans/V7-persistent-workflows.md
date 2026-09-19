# Plan: V7 — Persistent workflows

**Status:** locked  
**Implementation:** NOT STARTED  
**Explicit reference:** Implementation tasks must cite `docs/plans/V7-persistent-workflows.md` to treat this file as authoritative.

Authoritative architecture:

```text
docs/architecture/ADR-008-persistent-workflow-orchestration.md
docs/architecture/ADR-007-autonomous-task-orchestration.md
docs/architecture/ADR-006-agent-loop-orchestration.md
docs/architecture/ADR-005-approval-execute-authority.md
docs/architecture/ADR-004-interaction-authority.md
docs/architecture/browser-architecture.md
docs/plans/V6-autonomous-tasks.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
```

```text
V7 architecture locked
V7 implementation NOT STARTED
```

V0 (shell), V1 (observation), V2 (read-only agent), V3 (permissioned INTERACT), V4 (PREPARE / APPROVAL / EXECUTE), V5 (bounded agent loop), and V6 (autonomous tasks) are **complete and frozen**. V7 must not reopen already-green V3/V4/V5/V6 authority.

This plan implements ADR-008. It does not start V8 AI-native browser work.

---

## Objective

Deliver **persistent workflows** that survive process restart without restoring stale browser authority:

```text
durable workflow definition
+ structured manual/scheduled trigger
+ restart-safe occurrence queue and history
+ misfire coalescing and idempotent occurrence keys
+ fresh V6 AutonomousTask per live run
+ existing per-action V4 approval unchanged
```

```text
DurableWorkflow owns durable intent, trigger, queue state, and run history.

It does NOT own browser authority.
```

```text
DurableWorkflow ≠ serialized AutonomousTask
```

Persistence may survive restart. Browser authority may not.

## Out of scope

Do not implement in V7:

```text
serializing live AutonomousTask / AgentRun / tab / target / approval / grant
auto-resume of interrupted occurrences
workflow-wide or remembered approval
arbitrary cron strings / sub-daily schedules
public webhook listener / external HTTP server / cloud scheduler
OS daemon / self-wake while the app is closed
SQLite or any new database dependency (unless a later ADR supersedes ADR-008)
parallel workflow occurrences or parallel V6 tasks
renderer filesystem/DB/cron IPC
automatic query-string stripping of entry URLs
cross-restart continuation checkpoints (reserved only)
multi-agent / OS-wide / cloud / mobile / connectors / MCP / voice
V8 AI-native browser
```

Do not mark V7 implementation complete in this architecture-lock task. No implementation phase in this file is complete until an implementation task finishes it.

## Model policy

```yaml
model:
  default: composer-2.5
  escalation_allowed: true
  escalation_model: grok-4.6
  escalation_reason: |
    Use Grok 4.6 only for:
    - persistence schema / migration authority
    - crash recovery
    - idempotency
    - schedule misfire semantics
    - definition/queue transactional races
    - restart safety
    - approval-vs-process-death reasoning
    - single-writer concurrency
    - major ADR correction
    Do not escalate because a test failed, a command failed, or more
    confidence would be convenient.
```

Composer 2.5 is the default implementation model for every phase.

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

Per implementation phase: **targeted tests only**.

Full V2–V7 acceptance only at Phase 7 closure.

No live or paid model calls in acceptance. Recording / fake planner and model runtimes only. No external network.

Architecture-lock task (this document’s creation): docs consistency only; no production tests required.

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

This plan does **not** authorize production V7 code, dependency installation, or scheduler/IPC/UI implementation in the architecture-lock task.

---

## Phase overview

Seven implementation phases. Do not implement them in the architecture-lock task.

| Phase | Deliverable | Verification | Status |
|-------|-------------|--------------|--------|
| 1 | Durable storage foundation: schema, `WorkflowStore`, atomic JSON, single-writer, corruption handling; no scheduler/model/browser | targeted store tests | not started |
| 2 | Durable workflow core: definitions, revisions, occurrences, queue, interrupted recovery, review-required; no browser execution | targeted coordinator tests | not started |
| 3 | Scheduler: manual + structured schedule, UTC/IANA, misfire coalesce, idempotent keys; queue only | targeted clock/scheduler tests | not started |
| 4 | Workflow → V6 execution bridge: fresh background tab, entry URL, fresh V6 task, V4 unchanged, result mapping | targeted runner + V6 mapping tests | not started |
| 5 | Lifecycle + restart recovery: startup order, stop/cancel, queue vs Delegate, shutdown vs crash | targeted recovery + concurrency tests | not started |
| 6 | Product integration: typed IPC, Workflows UI, CRUD, run-now, history, review | targeted IPC/UI tests | not started |
| 7 | Acceptance + closure: deterministic scheduler/crash tests, real Electron scheduled workflow, V2–V7 matrix | full acceptance matrix | not started |

Each phase must remain independently reviewable. Do not collapse later phases into earlier ones.

---

## Phase 1 — Durable storage foundation (no scheduler, no model, no browser)

Deliver a single main-only `WorkflowStore` over atomic JSON.

Include:

- `schemaVersion` / `storeRevision`
- snapshot types for definitions + occurrences (even if coordinators are stubs)
- `load()` + `commit(expectedStoreRevision, mutation)` with optimistic revision check
- write temp → fsync → Windows-correct replace; last-known-good backup after success
- in-process serial writer queue
- strict validation; unknown newer schema refuses load-for-execution
- bounded file size; fail closed on corruption; **no** silent empty reset; **no** auto-promote backup
- tests use a temporary directory, never real Electron `userData`

Do **not** wire scheduler, V6, IPC, or UI. Do **not** add sqlite or other dependencies.

**Targeted verification:** round-trip commit, revision conflict, corrupt file fail-closed, extra/missing fields rejected, Windows replace semantics covered on this repo’s OS, backup written but not auto-used.

---

## Phase 2 — Durable workflow core (no browser execution)

Deliver `DurableWorkflowCoordinator` over the store: definitions, `definitionRevision`, occurrence state machine, durable FIFO queue, recovery to `interrupted`, `reviewRequired`.

Include:

- `DurableWorkflowId` / `WorkflowOccurrenceId` generation (opaque, main-only)
- create/edit/enable/disable with frozen snapshots on enqueue
- occurrence states from ADR-008
- idempotent `triggerKey` insert
- recover `running` + foreign `ownerRuntimeSessionId` → `interrupted` + review-required
- acknowledge/mark-reviewed is not retry
- delete/disable vs queued/running rules (Stop required if running — may be stubbed until Phase 5 live tasks exist)
- bounded occurrence history: 50 newest ordinary terminals, plus the latest scheduled occurrence (`scheduledFor !== null`) retained as a durable `triggerKey` dedupe anchor

Do **not** create tabs, navigate, or start V6 tasks.

**Targeted verification:** revision freeze, duplicate triggerKey, interrupted recovery, unknown sets review-required, disabled/deleted workflow cannot enqueue, review does not replay, scheduled triggerKey remains idempotent after ordinary-history compaction.

---

## Phase 3 — Scheduler (queue only)

Deliver `WorkflowScheduler` that decides **due identity** only.

Include:

- triggers: `manual`, `one-time`, `recurring-daily`, `recurring-weekly`
- UTC instants + required IANA zone for recurring
- DST gap skip / overlap earlier-offset
- misfire: recurring coalesce to at most one catch-up; one-time overdue enqueue once
- one next-due timer + recompute on startup / simulated wake / store change
- no browser, no model

Do **not** start occurrences.

Scheduler duplicate suppression uses durable occurrence `triggerKey`s. After Phase 2 compaction, only the latest scheduled occurrence is guaranteed to remain as a prune-resistant dedupe anchor. Phase 3 must not assume every historical scheduled trigger key remains forever. One-time still cannot re-enqueue because its single scheduled occurrence is that latest anchor; a recurring slot cannot duplicate until a newer slot replaces the anchor.

**Targeted verification:** fake clock — due/not due, coalesce five missed dailies to one, one-time not duplicated, DST cases, unknown timezone fails closed, ineligible (`reviewRequired` / disabled) enqueues nothing.

---

## Phase 4 — Workflow → V6 execution bridge

Deliver `WorkflowOccurrenceRunner`.

Include:

- trusted create background tab
- navigate frozen http(s) entry URL (reject userinfo; no `javascript:` / `file:` / `data:`)
- start **fresh** V6 AutonomousTask on that tab (not renderer-selected)
- map V6 terminal states onto occurrence terminal states
- persist bounded final answer
- V4 approval path unchanged; no workflow-wide approval
- runner must not call click/type/select/scroll/`ExecuteExecutor`/`InteractionExecutor`

**Targeted verification:** occurrence start does not reuse tabId/targetId/approvalId; V6 busy blocks a second occurrence; V4 reject → occurrence `blocked` without retry; unknown → review-required.

---

## Phase 5 — Lifecycle + restart recovery

Wire process lifetime.

Include:

- startup order from ADR-008 (lock → load → new `runtimeSessionId` → recover → scheduler → then auto-start)
- `requestSingleInstanceLock`; loser must not run scheduler
- stop/cancel; delete-requires-stop
- manual Delegate vs workflow slot precedence (queue vs busy; no silent cancel)
- manual Act on owned vs unrelated tabs (preserve V6)
- app closed → zero execution (unit/architecture proof + no daemon)
- graceful-quit hooks optional; crash path must not depend on them

**Targeted verification:** simulated process teardown reconstructs store with `running` → `interrupted`; second-instance flag disables scheduler; Delegate busy; queued FIFO after Delegate ends.

---

## Phase 6 — Product integration

Workflows product surface. Do **not** replace Ask / Act / Delegate.

Include:

- typed IPC CRUD/lifecycle (no `readFile`/`writeFile`/path/DB/cron-string)
- preload remains typed; renderer gets ids as correlation only
- UI: name, enabled, next run, last result, review required, history, run now, enable/disable, delete, acknowledge interrupted/unknown
- prompt-injection has no schedule authority (reuse V6 injection posture)

**Targeted verification:** IPC guards; schedule payload is structured not cron; renderer cannot set `reviewRequired` false except via acknowledge channel; Ask/Act/Delegate unchanged.

---

## Phase 7 — Acceptance + closure

Prove the architecture with deterministic tests and one real Electron harness.

### Acceptance direction

```text
workflow survives process restart
queued occurrence survives restart
same scheduled occurrence is not duplicated
missed recurring schedules coalesce
workflow execution creates fresh task/tab authority
no stale target/approval/grant restored
scheduled consequential action still waits for V4 approval
manual Delegate and workflow occurrence do not overlap illegally
app closed → zero execution
restart of active run → interrupted, not replayed
unknown suspends future automation
workflow edit revision is atomic
disable/delete prevents future enqueue
store corruption fails closed
free-text/page prompt injection cannot change schedule
no persistence of authority handles
```

### Real Electron closure

A real Electron harness must prove at least:

```text
persist workflow
close/recreate AI workflow runtime
reload workflow

due occurrence
→ fresh background tab
→ fresh V6 task
→ real child action

scheduled consequential action
→ real V4 approval
→ zero mutation before approval

old tab/target/grant is not reused
```

Do **not** require the Electron process to execute while actually closed. Restart may be simulated as real runtime/store teardown + reconstruction or as separate process launches, whichever provides stronger evidence.

Use temporary user-data/store directories. No external network. No paid model calls.

### Security acceptance (must prove)

```text
workflowId / occurrenceId are not browser authority
no persisted target / approval / grant / AgentRun / AutonomousTask authority
restart creates fresh browser authority
interrupted is never auto-replayed
unknown suspends automation
every consequential action still gets independent V4 approval
no workflow-wide approval
model/page cannot modify workflow schedule
one active occurrence
one browser mutation chain
enqueue is idempotent
store corruption fails closed
second process cannot run a second scheduler
app closed means zero execution
no automatic browser-action retry
no webhook/cloud daemon
V3/V4/V5/V6 authority unchanged
```

### Closure gates

```text
npm run typecheck
targeted V7 unit tests added in phases 1–6
npm run test:v2-acceptance
npm run test:v3-acceptance
npm run test:v4-acceptance
npm run test:v5-acceptance
npm run test:v6-acceptance
npm run test:v7-acceptance   (added in this phase)
```

Do not reopen V3/V4/V5/V6 authority to make V7 green.

Dedicated Electron PASS marker (name locked at Phase 7 implementation):

```text
[v7-electron-persistent-workflow] PASS
```

---

## Implementation notes (binding, not optional)

1. **Do not deserialize live V6 authority.** Fresh tab, fresh task, fresh observation, fresh V4 every live run.
2. **One storage boundary.** No scattered `writeFile` in workflow modules.
3. **Atomic JSON**, not sqlite, unless a later ADR supersedes this plan.
4. **Timers are hints.** Recompute due work from persisted timestamps + clock.
5. **Interrupted ≠ resume.** Review ≠ retry.
6. **Scheduler does not own browser authority.**
7. **Entry URLs reject userinfo.** Persist exact validated URL including query; do not silently strip query.
8. **`persist:website` cookies are not workflow authority.**
9. **Ask / Act / Delegate stay.** Workflows is a separate surface.
10. **No production code in this architecture-lock task.**

---

## Completion criteria

This architecture-lock task is complete when:

```text
ADR-008 Status: Accepted
V7 plan Status: locked
V7 implementation: NOT STARTED
browser-architecture V7: architecture locked; implementation not started
V6 remains COMPLETE / CLOSED
```

V7 implementation is complete only after Phase 7 closure gates are green and evidence is recorded (future `docs/acceptance/V7-acceptance.md`).
