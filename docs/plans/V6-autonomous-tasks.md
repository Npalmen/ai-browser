# Plan: V6 — Autonomous tasks

**Status:** architecture locked  
**Implementation:** not started  
**Explicit reference:** Implementation tasks must cite `docs/plans/V6-autonomous-tasks.md` to treat this file as authoritative.

Authoritative architecture:

```text
docs/architecture/ADR-007-autonomous-task-orchestration.md
docs/architecture/ADR-006-agent-loop-orchestration.md
docs/architecture/ADR-005-approval-execute-authority.md
docs/architecture/ADR-004-interaction-authority.md
docs/architecture/ADR-003-model-runtime-routing.md
docs/architecture/browser-architecture.md
docs/plans/V5-agent-loop.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
```

```text
V6 autonomous tasks — architecture locked
implementation not started
```

V0 (shell), V1 (observation), V2 (read-only agent), V3 (permissioned INTERACT), V4 (PREPARE / APPROVAL / EXECUTE), and V5 (bounded agent loop) are **complete and frozen**. V6 must not reopen already-green V3/V4/V5 authority.

This plan implements ADR-007. It does not start V7 persistent workflows.

---

## Objective

Deliver **session-scoped autonomous task delegation** for one explicit user objective:

```text
one explicit delegated objective
→ session-scoped AutonomousTask
→ planner decomposes objective into bounded subgoals
→ sequential child V5 AgentRuns
→ task may continue while user works in other tabs
→ explicit V4 approval remains mandatory per consequential action
→ task final answer completes the delegation
```

```text
AutonomousTask owns delegated task progression and workspace,
not browser authority.
```

### V5 vs V6

```text
V5:
one explicit Act
→ one foreground AgentRun
→ bounded sequential browser steps
→ terminal

V6:
one explicit delegated objective
→ trusted AutonomousTask
→ bounded planning + multiple child AgentRuns
→ may own multiple task tabs
→ may continue within the current app session while user works elsewhere
→ terminal
```

V6 is **session autonomous**, not persistent. V7 owns resume-after-restart, schedules, and durable workflows.

## Out of scope

Do not implement in V6:

```text
disk persistence / resume after restart
scheduled / cron / webhook-triggered tasks
OS background daemon / cloud worker
parallel child AgentRuns or parallel browser mutations
multi-agent / nested AutonomousTask / planner recursion
blanket task approval / approve-all / approval memory
planner DOM targeting or provider tool-calling browser path
automatic EXECUTE retry / reprepare after reject / expiry / stale
converting DENY into approval
free-text user reply as V4 approval
download / upload / filesystem (not in current BrowserAdapter)
password / card / OTP filling expansion
native select EXECUTE expansion
silent replacement of Act mode with autonomy
inferring autonomy from prompt length
V7 persistent workflows
V8 AI-native browser
```

Do not mark V6 complete in this architecture-only task. No implementation phase in this file is complete until an implementation task finishes it.

## Model policy

```yaml
model:
  default: composer-2.5
  escalation_allowed: true
  escalation_model: grok-4.6
  escalation_reason: |
    Use Grok 4.6 only for:
    - AutonomousTask state-machine authority
    - task/tab ownership
    - pause/resume concurrency
    - planner-vs-child generation races
    - post-dispatch pause/stop
    - approval-vs-task cancellation
    - causal popup ownership
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

## Verification philosophy

Per implementation phase: **targeted tests only**.

Full `V2` / `V3` / `V4` / `V5` / `V6` acceptance only at V6 closure or after shared authority changes.

No live or paid model calls in acceptance. Recording / fake planner and model runtimes only.

---

## Phase overview

| Phase | Deliverable | Verification | Status |
|-------|-------------|--------------|--------|
| 1 | `AutonomousTask` types, state machine, budgets, generation, audit; `TaskTabRegistry`; no model/browser | targeted unit tests | not started |
| 2 | `AutonomousTaskPlanner` structured-output runtime; trusted task-progress/context builder; no child execution | targeted planner tests | not started |
| 3 | `AgentRunExecutor` abstraction; decouple child runs from product `ConversationStore`; single-tab sequential subgoals | targeted executor + coordinator tests | not started |
| 4 | Task-owned tab lifecycle; causal new-tab adoption; pause/resume; manual navigation semantics | targeted tab/lifecycle tests | not started |
| 5 | V4 approval-aware task integration; task approval budget; pause/stop after dispatch; unknown propagation | targeted approval-task tests | not started |
| 6 | Main/runtime/IPC/UI task center; Ask and Act unchanged; explicit Autonomous Task mode | targeted main + UI tests | not started |
| 7 | Deterministic V6 fixtures; Electron session-background acceptance; V2–V6 closure | full acceptance matrix | not started |

Each phase must remain independently reviewable. Do not collapse later phases into earlier ones.

---

## Phase 1 — AutonomousTask core (no model, no browser)

Deliver trusted-main types and coordinator core unit-testable without planner runtime or `BrowserAdapter`.

Include:

- `AutonomousTask` / `AutonomousTaskId` / `AutonomousTaskRef` / terminal and nonterminal states
- hard budget constants (`8` / `4` / `3` / `4`) and increment rules
- budget checks **before** child run creation, tab adoption, or approval allowance
- task generation / late-result rejection
- task-level no-progress fingerprint helper
- `TaskTabRegistry` (workspace membership only)
- in-memory only; clear on runtime disposal
- observational task audit record shape (no page text)

Do **not** wire planner, child `AgentRun`, IPC, or UI.

**Targeted verification:** state-machine transitions, budget exhaustion (`TASK_LIMIT_REACHED`), task no-progress, generation mismatch ignores late planner resume, no transition out of terminal states, tab registry alias mapping.

---

## Phase 2 — Planner primitive (no child execution)

Extract bounded planner decision without browser integration.

Include:

- strict `AutonomousTaskDecision` schema validation
- rejection of authority fields and unknown fields
- bounded task-progress context builder (trusted vs untrusted separation)
- planner step counting (provider fallback = one logical step)
- no `BrowserAdapter`, grants, or V4 types in planner module

Do **not** start child AgentRuns yet.

**Targeted verification:** valid decisions parse; malicious authority output fails; context omits forbidden canaries; prompt-injection page text cannot alter budgets in context structure.

---

## Phase 3 — Child AgentRun execution abstraction

Introduce `AgentRunExecutor` beneath `AgentRunController`.

Include:

- execute one V5 child run via existing `SafeAgentLoop` + `AgentRunCoordinator`
- **no** `ConversationStore` commit from executor path
- child result mapping back to task coordinator
- one active child per task
- fresh child `runId` and per-tab generation per subgoal

Preserve `AgentRunController` as manual Act wrapper with one durable turn on completion.

**Targeted verification:** child run completes without conversation turn; late child result ignored; child budgets remain V5 constants; Act path unchanged.

---

## Phase 4 — Task-owned tab lifecycle

Wire `TaskTabRegistry` to real tab lifecycle.

Include:

- adopt current tab on explicit task start
- causal popup/new-tab adoption within tab budget
- reject user-created / unrelated tab adoption
- trusted chrome navigation on owned tab → pause task + cancel child + invalidate approval
- tab close semantics (execution tab vs reference tab)
- task continues when user switches to unrelated tab
- manual Act blocked on task-owned tab while task active (unowned tab Act still allowed)

Document website direct-click limitation: user must Pause; no insecure origin detection.

**Targeted verification:** adoption rules; tab budget; switch-away continuation; manual navigation pause; tab close outcomes.

---

## Phase 5 — V4 approval-aware task integration

Connect child V5 `awaiting-approval` to task state.

Include:

- `awaiting-approval` task state while child waits on V4
- task `taskApprovalCount` outer bound in addition to per-child V5 bound
- executed → resume planning; reject/expiry/stale → task blocked (no replan)
- pre-dispatch failed → task failed
- unknown → **entire task** `execution-state-unknown`
- pause/stop while awaiting approval (V5/V4 semantics)
- pause/stop after dispatch (truthful V4 outcome; unknown wins)
- free-text user reply cannot approve

Reuse existing `ApprovalCard` and `approval:decide` IPC unchanged.

**Targeted verification:** two child consequential actions → two independent approvals; reject blocks whole task; unknown kills whole task; no automatic reprepare.

---

## Phase 6 — Product integration

Main + renderer task center.

Include:

- explicit **Autonomous Task** / **Delegate** product mode separate from Ask and Act
- renderer-safe `autonomous-task-*` events (no authority handles)
- Pause / Resume / Stop / reply-to-task APIs
- task UI: status, subgoal summary, owned-tab count, safe counters
- reuse V4 `ApprovalCard` (no second approval UI)
- app-level indicator when task needs approval/input while user on another tab (no OS notifications required)
- runtime disposal clears all tasks
- one durable conversation turn on completed delegation only

Ask remains `ReadOnlyAgent`. Act remains V5 `AgentRunController`.

**Targeted verification:** UI state machine; Enter cannot approve; unknown copy has no Retry; panel close is observational only.

---

## Phase 7 — Acceptance and closure

Add dedicated:

```text
src/v6-acceptance/
test:v6-acceptance
```

Recording / fake planner and model runtime only. No paid model calls. No internet.

### Minimum acceptance scenarios

```text
delegated task → planner → child run → planner → final answer
two sequential child runs
task continues while user switches to unrelated tab
agent-caused new task tab causally adopted
user-created tab not adopted
task tab / planner / child-run / approval budgets enforced
two consequential child actions → two independent approvals
DENY in child → whole task blocked
Reject → whole task blocked
expiry/stale → whole task blocked
V4 unknown → whole task unknown permanently
Pause during planner / child / awaiting approval
Pause/Stop after dispatch (executed and unknown paths)
Resume creates fresh planning epoch
late pre-pause planner result ignored
late child result ignored
manual trusted navigation in owned tab pauses task
tab close during task
manual Act on unowned tab isolated
planner repeats identical subgoal → task no-progress
prompt injection cannot raise task limits or self-approve
free-text "yes" cannot satisfy approval
restart/dispose destroys task
one durable conversation turn on completed delegation
```

### Security acceptance (must prove)

```text
planner cannot approve
planner cannot mint grants
planner cannot target DOM elements
planner cannot expand task tab set by claim alone
taskId is not browser authority
task ownership is main-only
one child run at a time
one browser mutation at a time
every consequential action still gets V4 approval
free-text reply cannot approve
DENY cannot become approval
unknown kills entire task
no automatic EXECUTE retry
no cross-restart continuation
no task persistence
no schedules
```

### Closure gates

```text
npm run typecheck
targeted V6 unit tests added in phases 1–6
npm run test:v2-acceptance
npm run test:v3-acceptance
npm run test:v4-acceptance
npm run test:v5-acceptance
npm run test:v6-acceptance
```

Do not reopen V3/V4/V5 authority to make V6 green.

Real Electron harness must exercise session-background continuation (task on owned tab while user switches away) through production authority chain — no fixture DOM shortcuts.

Dedicated Electron PASS marker:

```text
[v6-electron-autonomous-task] PASS
```

---

## Implementation notes (binding, not optional)

1. **Do not invent a parallel browser-control stack.** Reuse V5 child runs and frozen V3/V4 authority.
2. **Extract `AgentRunExecutor` before looping child runs in product conversation paths.**
3. **Check task budgets before child run / tab adoption / approval allowance** so the UI never shows work that cannot finish.
4. **Child subgoal answers are task-local progress**, not `ConversationStore` turns.
5. **Reject/expiry/stale do not auto-reprepare** at task level.
6. **Unknown is catastrophic for the whole task**, not just the child run.
7. **Free-text is never approval.**
8. **One active AutonomousTask per runtime** in initial V6.
9. **Audit is observational** and must not gate authority.
10. **No production code in this architecture-lock task.**

---

## Completion criteria

V6 is complete only when Phase 7 closure gates are green and this plan’s status is updated to `complete` by a later implementation task.

Until then:

```text
V6 architecture locked
implementation not started
```
