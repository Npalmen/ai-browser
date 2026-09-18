# ADR-007: Autonomous task orchestration

**Status:** Accepted  
**Date:** 2026-09-18  
**Supersedes:** none  
**Extends:** ADR-003, ADR-004, ADR-005, ADR-006  
**Does not reopen:** V0 shell, V1 observation, V2 read-only agent, V3 INTERACT authority, V4 PREPARE / APPROVAL / EXECUTE authority, V5 bounded AgentRun authority  
**See also:** `docs/architecture/browser-architecture.md`; `docs/plans/V6-autonomous-tasks.md`; `docs/plans/V5-agent-loop.md`; `.cursor/rules/browser-agent-safety.mdc`

## Context

V0–V5 are complete and frozen. V5 delivers one explicit foreground Act instruction as a bounded `AgentRun` per tab: sequential observe → reason → safe V3 action or per-action V4 approval, with hard local budgets, no persistence, and no background continuation.

Users now need **session-scoped delegation** beyond a single Act run:

```text
"Compare these three plans and tell me which has the lowest total price."
"Find the invoice in this portal and prepare it for download."
"Research these hotels, compare refundable prices, and stop before booking."
```

That requires:

```text
one explicit user-delegated objective
→ trusted AutonomousTask
→ planner decomposes into bounded subgoals
→ sequential child V5 AgentRuns
→ task may continue while user works in other tabs
→ explicit V4 approval remains mandatory per consequential action
→ one task-level final answer
```

V6 adds **genuine autonomy beyond V5** without becoming V7 persistence.

### Current-contract findings this ADR must respect

Audit of the shipped V5 product stack (`initializeAiRuntime()`):

- `AgentRunController` wraps `SafeAgentLoop` + `AgentRunCoordinator` and **commits one durable `ConversationStore` turn** on completed Act runs.
- `SafeAgentLoop` owns one-step sequencing through `InteractiveStepAgent`, `InteractionExecutor`, and `AgentRunApprovalBridge` → V4 workflow. It does not call `BrowserAdapter` directly.
- `AgentRunCoordinator` owns run lifecycle, budgets (`8` / `6` / `2`), approval correlation, no-progress fingerprint, generation/late-result guards, and terminal semantics including `execution-state-unknown`.
- One active `AgentRun` per tab. Same-tab supersede cancels the prior run. Different tabs are independent.
- Trusted chrome navigation cancels V5 runs. Agent-caused navigation continues after trusted post-action observation.
- `ReadOnlyAgent` remains Ask/read-only. Act uses `AgentRunController`, not `InteractiveAgent.interact()`.
- V4 `PreparedAction`, `ApprovalDecision`, and `ExecuteGrant` contain no `runId`. Approval remains exact-action-specific.
- No download/upload/filesystem primitives exist in current `BrowserAdapter` scope.

No contradiction requires reopening ADR-004, ADR-005, or ADR-006. V6 orchestrates existing V5 child runs. It does not change `InteractionGrant`, `PreparedAction`, `ApprovalDecision`, or `ExecuteGrant`.

## Decision

Introduce a **trusted-main AutonomousTask** and **AutonomousTaskCoordinator** that own **delegated task progression and workspace**, not browser authority.

```text
AutonomousTask owns delegated task progression and workspace,
not browser authority.
```

V6 is **session autonomous**, not persistent.

### V5 vs V6 vs V7

| | V5 | V6 | V7 |
|---|----|----|-----|
| User trigger | one explicit Act | one explicit delegated objective | scheduled / event / restart-resume workflows |
| Scope | one foreground `AgentRun` per tab | one `AutonomousTask` may own multiple task tabs | durable workflows across sessions |
| Planning | none (model proposes one browser step at a time) | bounded planner chooses semantic subgoals | persistent workflow engine |
| Execution | one bounded loop | sequential child V5 runs | multi-step durable orchestration |
| While user elsewhere | run tied to foreground tab semantics | task may continue on owned tabs while user uses unrelated tabs | background/event continuation |
| Persistence | in-memory only | in-memory only | disk / schedule / webhook / DB |
| After restart | gone | gone | may resume |

V6 allows:

```text
task continues while app remains running
panel may be closed
user may use unrelated tabs
task may own dedicated tabs
user may pause/resume task in the same process
```

V6 does **not** allow:

```text
resume after application restart
disk-persisted task state
scheduled future start / cron / "run tomorrow"
webhook-triggered autonomous task
condition monitoring across restart
long-lived workflow database
OS background daemon / cloud worker / remote browser
```

**Background in V6** means only:

```text
within the currently running AI Browser process
while the user is looking at another tab/window
```

It does **not** mean Electron closed, OS service, or scheduled wake.

### Rejected child-run alternatives

| Option | Verdict | Reason |
|--------|---------|--------|
| A. One extremely large AgentRun | Rejected | Collapses semantic subgoals; worsens `ConversationStore` coupling; weak pause/resume boundaries; planner and browser-step budgets become indistinguishable |
| B. AutonomousTask → sequential child V5 AgentRuns | **Accepted** | Reuses proven V5 loop, approval pause/resume, cancellation, late-result protection, conversation split, and exact V3/V4 authority |
| C. New autonomous loop bypassing AgentRun | Rejected | Duplicates V5 semantics and risks authority drift |

---

## 1. Architecture hierarchy

```text
AutonomousTaskCoordinator
        │
        ├── AutonomousTaskPlanner (structured model output only)
        │
        ├── task budgets / task state / generation
        │
        ├── TaskTabRegistry (workspace membership only)
        │
        └── child subgoal orchestration
                │
                ▼
        AgentRunExecutor (trusted main)
                │
                ▼
        SafeAgentLoop + AgentRunCoordinator (existing V5 machinery)
                │
                ▼
        InteractiveStepAgent → InteractionExecutor / V4 bridge
                │
                ▼
        BrowserAdapter
```

V6 must reuse, not copy:

```text
InteractiveStepAgent
AgentRunCoordinator / SafeAgentLoop
InteractionExecutor
PrepareActionService
ApprovalManager
ExecuteExecutor
BrowserAdapter
```

### Module ownership

| Module | Owns | Must not |
|--------|------|----------|
| `AutonomousTaskCoordinator` | task lifecycle, planner/child budgets, pause/resume/stop, task generation, task-local progress, tab ownership routing | Mint grants; classify INTERACT vs EXECUTE; call `BrowserAdapter`; persist tasks |
| `AutonomousTaskPlanner` | One bounded planner decision per step | Target elements; grants; approvals; browser primitives |
| `TaskTabRegistry` | `taskId → owned tab set`, task-local aliases, origin metadata | Targets; grants; CDP; browser mutation |
| `AgentRunExecutor` | Execute one child V5 run without product `ConversationStore` commit | Product UI events; task planning |
| `AgentRunController` | Manual Act wrapper; one durable user turn on completion | Task planning; multi-tab workspace |
| V4 approval workflow | unchanged per-action authority | Task-level blanket approval |
| Renderer task UI | observational state only | Browser authority; approval decisions via free text |

Exact class names may differ. The split must not place planner logic inside `SafeAgentLoop` or grant logic inside `AutonomousTaskCoordinator`.

---

## 2. AutonomousTask identity

```ts
type AutonomousTaskId = string;

interface AutonomousTaskRef {
  readonly taskId: AutonomousTaskId;
  readonly generation: number;
}
```

- IDs are main-generated, opaque, and correlation-only.
- The model does not choose `taskId`.
- The renderer cannot use `taskId` to execute browser actions, select targets, approve actions, or raise budgets.
- `taskId` is **not** on `PreparedAction`, `ApprovalDecision`, or `ExecuteGrant`.

Process restart or AI-runtime disposal: all `AutonomousTask` state is gone. V7 owns cross-restart recovery.

---

## 3. AutonomousTask state machine

Nonterminal:

```text
planning
running-subgoal
awaiting-approval
awaiting-user-input
paused
```

Terminal:

```text
completed
cancelled
blocked
failed
execution-state-unknown
```

No transition out of a terminal state. A new explicit user delegation creates a new `taskId`.

```text
planning
  ├─ delegate-subgoal selected     → running-subgoal
  ├─ request-user-input            → awaiting-user-input
  ├─ complete                      → completed
  ├─ pause                         → paused (after safe boundary)
  ├─ cancel/stop                   → cancelled
  └─ planner failure               → failed

running-subgoal
  ├─ child completed               → planning
  ├─ child awaiting V4             → awaiting-approval
  ├─ child blocked                 → blocked
  ├─ child failed                  → failed
  ├─ child unknown                 → execution-state-unknown
  ├─ pause                         → paused (after child reaches safe boundary)
  └─ cancel/stop                   → cancelled

awaiting-approval
  ├─ executed                      → planning (or running-subgoal while child finalizes)
  ├─ reject                        → blocked
  ├─ expired                       → blocked
  ├─ stale                         → blocked
  ├─ pre-dispatch failed           → failed
  ├─ unknown                       → execution-state-unknown
  ├─ pause                         → paused only at safe boundary
  └─ cancel/stop                   → cancelled (V5/V4 truthful semantics)

awaiting-user-input
  ├─ trusted user reply            → planning
  ├─ pause                         → paused
  └─ cancel/stop                   → cancelled

paused
  ├─ explicit Resume               → planning (fresh planner epoch)
  └─ cancel/stop                   → cancelled
```

### V4 / V5 outcome propagation to task

| Child / V4 outcome | AutonomousTask result |
|----------------------|------------------------|
| child `completed` answer | return to `planning` |
| V3 `DENY`, sensitive, unsupported | `blocked` / `POLICY_BLOCKED` |
| V4 `reject` | `blocked` / `APPROVAL_REJECTED` — **no automatic replan around rejection** |
| V4 `expired` | `blocked` / `APPROVAL_EXPIRED` — no reprepare |
| V4 `stale` | `blocked` / `ACTION_STALE` — no fresh target / new approval |
| V4 pre-dispatch `failed` | `failed` / `CHILD_RUN_FAILED` |
| V4 `execution-state-unknown` | **entire task** → `execution-state-unknown` — no planner call, no retry, no new approval |
| task budget exhausted | `blocked` / `TASK_LIMIT_REACHED` |
| task no-progress | `blocked` / `TASK_NO_PROGRESS` |

After child `blocked`, `failed`, `cancelled`, or `execution-state-unknown`, the coordinator must **not** automatically create another child run. Safe replanning is allowed only after a **completed** child subgoal or an explicit user reply while `awaiting-user-input`.

---

## 4. Hard task-level budgets

Local constants. Model and renderer cannot raise them. Check **before** creating child runs, adopting tabs, or allowing another approval presentation.

```text
MAX_AUTONOMOUS_TASK_PLANNER_STEPS = 8
MAX_AUTONOMOUS_TASK_CHILD_RUNS    = 4
MAX_AUTONOMOUS_TASK_OWNED_TABS    = 3
MAX_AUTONOMOUS_TASK_APPROVALS     = 4
```

Rationale:

- Planner steps mirror V5 model-step headroom: a multi-tab compare task may need several planning passes without unbounded autonomy.
- Four child runs allow e.g. open three comparison tabs plus a synthesis pass, while each child remains independently bounded by V5 (`8` / `6` / `2`).
- Three owned tabs cap workspace growth in initial V6.
- Four task-level approvals allow more consequential actions across multiple subgoals than a single V5 run (`2`), while still forbidding approval churn.

Child V5 budgets remain frozen per ADR-006:

```text
MAX_AGENT_LOOP_MODEL_STEPS      = 8
MAX_AGENT_LOOP_ACTION_ATTEMPTS  = 6
MAX_AGENT_LOOP_APPROVALS        = 2
```

Count separately:

```text
plannerStepCount
childRunCount
taskApprovalCount
per-child modelStepCount / actionAttemptCount / approvalCount
```

A planner provider fallback is one logical `plannerStep`. A child provider fallback remains one V5 logical model step.

Budget ordering examples:

```text
childRunCount at limit        → do not start another child AgentRun
taskApprovalCount at limit    → child must not prepare another approval
ownedTabCount at limit        → do not adopt/create another task tab
plannerStepCount at limit     → terminate blocked TASK_LIMIT_REACHED
```

---

## 5. Planner contract

The planner is **not** a browser tool user. It chooses semantic subgoals only.

```ts
type AutonomousTaskDecision =
  | {
      kind: 'delegate-subgoal';
      taskTabAlias: string;
      instruction: string;
    }
  | {
      kind: 'request-user-input';
      question: string;
    }
  | {
      kind: 'complete';
      answer: string;
    };
```

Planner output must **not** include:

```text
targetId
observationId
documentRevision
backendNodeId
approvalId
ExecuteGrant
InteractionGrant
browser coordinates
CDP command
approved / authority / unlimited flags
```

Unknown or extra authority fields fail closed (`MODEL_OUTPUT_INVALID` or task-equivalent), consistent with ADR-003/006 parsing.

Subgoal instruction bounds:

```text
maximum instruction length (product constant, e.g. 4000 chars)
one subgoal at a time
no nested AutonomousTask
no "continue indefinitely"
```

The planner does **not** classify `INTERACT` / `DEFER_EXECUTE` / `DENY`. V3 policy decides at child-run action time.

No provider tool-calling browser path. Architecture remains:

```text
structured model output → validator → trusted coordinator
```

### Planner context (bounded)

Trusted sections only:

```text
original user objective
task-level trusted facts and counters
bounded task-tab metadata (alias, origin/title, owned state, last child status)
last N bounded subgoal summaries
optional current user clarification reply
```

Separate untrusted page/model content from trusted task state. Page prompt injection cannot alter budgets, ownership, approval requirements, pause/stop, or planner state.

Child summaries must distinguish:

```text
TRUSTED_EXECUTOR_FACT
MODEL_SUBGOAL_RESULT   // model-generated, not authority
```

A consequential external effect is factual in task state only when trusted V4 reports `executed`. Unknown child outcome makes the **whole task** unknown.

---

## 6. Child AgentRun architecture

### AgentRunExecutor vs AgentRunController

V5 today couples execution with product conversation commit in `AgentRunController`. V6 requires:

```text
AgentRunExecutor
  → executes one V5 AgentRun on a task-owned tab
  → no product ConversationStore commit

AgentRunController
  → manual Act wrapper
  → commits one V5 user turn on completion

AutonomousTaskCoordinator
  → invokes AgentRunExecutor for child subgoals
  → stores task-local trusted progress only
```

A child run's final subgoal answer is **internal task progress**, not a durable user-facing `ConversationStore` turn.

### Child run rules

```text
maximum one active child AgentRun per AutonomousTask
maximum one browser mutation at a time across all task tabs
no parallel child runs
no nested AutonomousTask
no planner recursion / multi-agent delegation
```

Each child run gets:

```text
fresh runId
per-tab V5 generation
fresh observation authority
```

Planner cannot carry `targetId` or `documentRevision` across child runs. Every child begins with fresh V5 inference authority.

Late child results are ignored by V5 generation rules **and** by task-generation guards.

### Fresh authority invariant

No target from planner, prior child, or another task tab may be reused as execution authority. This is explicit and testable.

---

## 7. Conversation and durable history

Product modes:

```text
Ask     → ReadOnlyAgent (unchanged)
Act     → AgentRunController / V5 (unchanged)
Delegate / Autonomous Task → AutonomousTaskCoordinator (new explicit mode)
```

Do not infer autonomy from prompt length.

Durable user history for an autonomous delegation:

```text
one original delegated objective
+
one final AutonomousTask answer
=
one durable conversation turn
```

No durable turn per planner step, child subgoal, or approval. No approval tokens in history. Task audit is not serialized as conversation.

Non-completed tasks (`blocked`, `cancelled`, `failed`, `execution-state-unknown`) do not commit a durable turn.

---

## 8. Task-owned tabs

### Definitions

```text
task-owned tab   → tab registered to an AutonomousTask workspace
user-owned tab   → all other tabs
```

Task ownership is **task progression authority**, not browser-action authority. Every action in an owned tab still passes V3/V4 unchanged.

### Starting tab rule

Initial V6 behavior:

```text
explicit delegation from current tab
→ current tab becomes task-owned for the task duration
```

Do not silently adopt arbitrary tabs. User may switch away and use unrelated tabs.

### Causal new-tab adoption

```text
agent action in task-owned tab
→ browser opens new tab/popup
→ if causally created by the current child AgentRun
  and within MAX_AUTONOMOUS_TASK_OWNED_TABS
→ new tab may become task-owned
```

Trusted main correlates causality (current child run, source tab, creation during action lifecycle). Page JavaScript cannot claim task ownership.

Do **not** adopt:

```text
user-created tabs
unrelated website popups
tabs from another task
tabs by URL/title fuzzy search
```

Planner tab aliases (`task-tab-1`, `task-tab-2`) are routing only. Main maps alias → owned `tabId`. Invalid alias fails closed.

### Manual user interaction on owned tabs

Trusted chrome navigation on a task-owned tab is user intervention:

```text
pause AutonomousTask
cancel active child safely
invalidate unresolved child approval
preserve session-local task state
```

User may explicitly Resume from current page. Do not let the planner silently reinterpret user navigation.

Direct website clicks inside the website renderer are a known limitation. Initial V6 does **not** invent insecure origin detection. UI/ownership semantics require the user to **Pause** before intentionally taking manual control of a task-owned tab. Task-owned tabs should be visibly marked.

### Tab close

| Event | Preferred behavior |
|-------|-------------------|
| Close current execution tab | cancel child; task `blocked` or `paused` depending on policy |
| Close non-critical owned tab | remove ownership; planner receives trusted `tab unavailable` metadata |
| Close adopted user tab | never auto-close; release ownership only |

At terminal: **do not auto-close adopted user tabs**. Task-created tabs default to **leave open**; release ownership.

Agent-caused navigation within an owned tab may continue task ownership; V3 policy still governs each action.

---

## 9. Concurrency model

```text
maximum one active AutonomousTask per browser profile / AI runtime
```

Paused or terminal task history may appear in UI, but only one task may be `planning`, `running-subgoal`, `awaiting-approval`, or `awaiting-user-input` at a time.

Manual V5 Act while a task runs:

```text
Act on tab NOT owned by active AutonomousTask → allowed
Act on task-owned tab                     → require Pause/Stop task first
```

No overlapping `AgentRun` on one tab. Switching the user's active browser tab alone does **not** cancel the task.

---

## 10. Pause, Resume, and Stop

### Pause

Distinct from Stop/Cancel. Keeps ephemeral in-memory task state. No new browser work while paused. Resume requires explicit user action.

**During planner generation:** abort planner; discard in-flight generation; `paused`; late planner result ignored.

**During child V5 run:** request child cancellation; wait for truthful V5/V4 boundary; task becomes `paused` only after child reaches safe terminal/safe pause boundary; no live child while paused.

**After V4 dispatch (`adapterPrimitiveInvoked = true`):** Pause cannot undo input. Wait for V4 `executed` or `execution-state-unknown`. Executed → may become `paused`. Unknown → entire task `execution-state-unknown`.

### Resume

Increments or otherwise invalidates planning epoch so late pre-pause planner output cannot create a child run. Fresh planner generation uses current trusted task state.

Resume creates a **fresh** child run when delegating; it does not resume an old `runId`.

### Stop

Permanently terminates the task: abort planner; cancel child; invalidate unresolved pre-dispatch approval; release tab ownership per lifecycle rules; no later resume. Post-dispatch effects follow V4 truthfully.

---

## 11. Awaiting user input

Planner may return `request-user-input` when a required user choice is missing.

```text
task → awaiting-user-input
```

No model/browser work until reply.

Renderer API conceptually:

```text
replyToAutonomousTask({ taskId, reply })
```

Main verifies: task exists, current generation, state = `awaiting-user-input`. Reply is task information only.

**Free-text reply is never approval.**

```text
"yes" / "do it" / "looks good"
```

cannot satisfy a pending V4 approval. Consequential approval still requires `ApprovalCard` → `approvalId` + `approve|reject` through frozen V4 IPC.

While task waits on V4:

```text
task UI → "Waiting for approval"
existing ApprovalCard → actual action decision
```

No `taskId` required to approve.

---

## 12. Task-level no-progress

V5 exact action no-progress remains per child run. V6 adds task-level no-progress:

```text
fingerprint = hash(
  taskTabAlias,
  normalized delegated instruction,
  trusted tab state generation / revision summary
)
```

If planner requests an identical subgoal on unchanged task state after that subgoal already completed:

```text
blocked / AUTONOMOUS_TASK_NO_PROGRESS
```

Do not launch another child run. A fresh explicit user reply or changed task-tab state may start a new planning epoch where repetition is valid. No fuzzy semantic similarity.

---

## 13. Task audit (observational)

Separate metadata-only audit. Examples:

```text
task-started
planner-step-completed
subgoal-started
subgoal-completed
task-tab-added
task-paused
task-resumed
awaiting-user-input
task-terminal
```

May include: `taskId`, `generation`, state, `plannerStepCount`, `childRunCount`, `ownedTabCount`, `taskApprovalCount`, timestamp, `terminalReason`.

Must not include: page text, secrets, `targetId`, `backendNodeId`, `approvalId`, `ExecuteGrant`, screenshots.

Audit failure must not grant authority or retry browser actions (same rule as V4/V5).

---

## 14. Renderer task events

High-level events only:

```text
autonomous-task-started
autonomous-task-progress
autonomous-task-awaiting-approval
autonomous-task-awaiting-user-input
autonomous-task-paused
autonomous-task-resumed
autonomous-task-completed
autonomous-task-blocked
autonomous-task-failed
autonomous-task-cancelled
autonomous-task-execution-state-unknown
```

Forbidden on renderer events: `targetId`, `observationId`, `documentRevision`, `approvalId`, `preparedActionId`, `executionId`, grants, `backendNodeId`, `frameId`, raw planner chain-of-thought, page text.

`taskId` is correlation only.

Pause/Resume/Stop APIs:

```text
pauseTask(taskId)
resumeTask(taskId)
cancelTask(taskId)
```

No target/grant fields. No direct child `AgentRun` manipulation from renderer.

---

## 15. Scope boundaries

### Unchanged from V5

```text
password / card / OTP automation
deferred select EXECUTE
download / upload / filesystem (not in current BrowserAdapter)
V3 DENY semantics
V4 click-only EXECUTE
per-action exact approval
no automatic EXECUTE retry
```

### V6 must not

```text
mint InteractionGrant or ExecuteGrant
approve an action
override DENY
convert DENY into approval
reuse stale target authority
retry EXECUTE automatically
call BrowserAdapter from planner
grant blanket task approval / "approve task"
persist across restart
schedule itself
wake the application
spawn hidden parallel agents
```

Starting an AutonomousTask does **not** approve future EXECUTE actions. Safe `ALLOW_INTERACT` / `ALLOW_NAVIGATE` may proceed within budgets on task-owned tabs.

---

## 16. Explicit decision record

| Question | Decision |
|----------|----------|
| What makes V6 autonomous beyond V5? | Session-scoped delegated objective, planner subgoals, multi-tab workspace, continue while user uses other tabs |
| What remains V7? | Persistence, schedules, restart resume, event/webhook triggers |
| Who owns AutonomousTask state? | Trusted main `AutonomousTaskCoordinator` |
| How many active tasks? | One per AI runtime / browser profile |
| Task while another tab active? | Yes, on task-owned tabs |
| While app closed? | No |
| Task budgets? | `8` planner / `4` child runs / `3` tabs / `4` approvals |
| Planner output? | `delegate-subgoal` \| `request-user-input` \| `complete` |
| Planner targets DOM? | No |
| Child runs? | Sequential child V5 runs via `AgentRunExecutor` |
| Child result summaries? | Bounded, labeled trusted vs model-generated |
| Avoid child conversation turns? | `AgentRunExecutor` without `ConversationStore` commit |
| Simultaneous child runs? | One |
| Task-owned tab? | Main-registered workspace member for V5 attempts |
| Starting tab? | Adopt current tab on explicit delegation |
| Popup adoption? | Causal only, within tab budget |
| Auto-adopt user tabs? | No |
| Manual navigation on owned tab? | Pause task; cancel child; invalidate approval |
| Direct website interaction? | User must Pause; no insecure detection invented |
| Tab close? | Block/pause/remove ownership per role |
| Runtime disposal? | All tasks terminate |
| Pause meaning? | In-memory state kept; no new work |
| Resume meaning? | Fresh planner epoch + fresh child runs |
| Pause after dispatch? | Wait for V4 truth; unknown kills task |
| Stop after dispatch? | V4 truth stands; task terminal; no further steps |
| Late planner output? | Ignored via task generation |
| Late child result? | Ignored via V5 + task generation |
| V3 DENY? | Whole task blocked |
| Reject? | Whole task blocked; no replan around rejection |
| Expiry/stale? | Whole task blocked; no reprepare |
| V4 failed? | Task failed |
| V4 unknown? | Whole task `execution-state-unknown` permanently |
| Auto retry consequential? | No |
| Free-text approves action? | No |
| Task no-progress? | Exact fingerprint on subgoal + tab state |
| Final conversation? | One durable turn for delegation |
| Audit? | Metadata-only, observational |
| Renderer events? | High-level, no authority handles |
| `taskId` grants anything? | No |

---

## 17. Security invariants

```text
[ ] V3 authority unchanged
[ ] V4 authority unchanged
[ ] V5 child-run authority unchanged
[ ] Planner cannot approve or mint grants
[ ] Planner cannot target DOM elements
[ ] Planner cannot expand tab set by claim alone
[ ] taskId is not browser authority
[ ] Task tab ownership is main-only
[ ] One child run at a time
[ ] One browser mutation at a time
[ ] Every consequential action still gets independent V4 approval
[ ] Free-text reply cannot approve
[ ] DENY cannot become approval
[ ] unknown kills entire task
[ ] No automatic EXECUTE retry
[ ] No cross-restart continuation
[ ] No task persistence or schedules
[ ] No OS background service
```

## Consequences

- V6 sits above V5 without a parallel browser stack.
- Implementation requires extracting `AgentRunExecutor`, adding `AutonomousTaskCoordinator`, `TaskTabRegistry`, planner runtime, and task UI — specified in `docs/plans/V6-autonomous-tasks.md`.
- Ask and Act remain unchanged. Autonomous Task is a separate explicit product mode.
- V7 remains the home for persistent workflows and cross-restart autonomy.

V6 architecture is locked by this ADR. Implementation is **not** started by accepting this ADR.
