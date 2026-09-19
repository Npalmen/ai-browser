# ADR-008: Persistent workflow orchestration

**Status:** Accepted  
**Date:** 2026-09-19  
**Supersedes:** none  
**Extends:** ADR-003, ADR-004, ADR-005, ADR-006, ADR-007  
**Does not reopen:** V0 shell, V1 observation, V2 read-only agent, V3 INTERACT authority, V4 PREPARE / APPROVAL / EXECUTE authority, V5 bounded AgentRun authority, V6 AutonomousTask authority  
**See also:** `docs/architecture/browser-architecture.md`; `docs/plans/V7-persistent-workflows.md`; `docs/plans/V6-autonomous-tasks.md`; `.cursor/rules/browser-agent-safety.mdc`

## Context

V0–V6 are complete and frozen. V6 delivers **session-scoped** autonomous delegation: one explicit Delegate objective, a bounded planner, sequential child V5 `AgentRun`s, task-owned tabs, and per-action V4 approval. That work disappears when the AI runtime or process disappears. ADR-007 forbids persistence, schedules, webhooks, and resume-after-restart.

Users now need **durable workflows** that survive application restart:

```text
save a reusable objective and entry URL
trigger it manually or on a schedule
queue missed work deterministically
keep history independent of the current session
when the app is open and a run is due, launch a fresh V6 AutonomousTask
```

That is V7. It extends V6. It does **not** serialize live V6 authority.

### Audit findings this ADR must respect

Repository audit at HEAD `996e6c21f5b76ea0490a3c62be59dcefc59da6c5` (`Close V6 autonomous task milestone`):

| Area | Finding |
|------|---------|
| Workflow persistence | **None.** No `WorkflowStore`, no `userData` workflow file, no SQLite / `better-sqlite3`, no IndexedDB, no renderer `localStorage` workflow state. |
| Filesystem writes | Production `src/` does not call `app.getPath`, `writeFile`, or `readFile` for product state. `fs` / `fs/promises` appear in tests, fixture servers, and static scans only. |
| `ConversationStore` | In-memory `Map` keyed by `tabId`. Process-local. Not a persistence stack. |
| Scheduler | **None.** No cron parser, no due-time engine, no `setInterval` workflow poller. ADR-006 and ADR-007 explicitly forbid schedules. |
| Webhooks / HTTP listener | **None** in product main. Fixture HTTP is test-only. |
| Single-instance lock | **None.** `src/main/main.ts` uses `app.whenReady`, `activate`, and `window-all-closed` only. No `requestSingleInstanceLock`. No `before-quit` / `will-quit` drain. |
| Electron session | `WEBSITE_PARTITION = 'persist:website'` already persists website cookies/cache across launches (V0). That is **not** workflow authority and must not be treated as deserialized V6 state. |
| Production dependencies | `package.json` runtime dependency is `ai` only. No database native module. |
| URL policy | `normalizeNavigationUrl` allows `http:` / `https:` (and `about:blank`). It does **not** currently reject `username:password@` userinfo. V7 entry points must. |
| V6 slot | `AutonomousTaskCoordinator.assertNoActiveTask()` — one active AutonomousTask per AI runtime. |
| V6 start | Adopts a caller-supplied `startingTabId`. V7 must not use a renderer-selected execution tab. |
| IPC / preload | Typed `browserShell` + `aiAssistant` only. No `readFile` / `writeFile` / path / DB handle exposure. |
| V4 / V5 / V6 | Process-local. Restart destroys `PreparedAction`, `ApprovalDecision`, `ExecuteGrant`, `AgentRun`, and `AutonomousTask`. |

No existing persistence stack is suitable to reuse. V7 introduces a **new main-only store** with a single storage boundary.

ADR-007’s V7 placeholder mentioned “disk / schedule / webhook / DB” and “may resume.” This ADR **refines** that placeholder without reopening ADR-007:

- Initial V7 persists definitions, triggers, queue, and history — not live V6/V4 handles.
- “Resume” means recover durable workflow state and launch **fresh** runtime authority.
- Webhooks, cloud schedulers, and a database are **not** initial V7.

No contradiction requires reopening ADR-004, ADR-005, ADR-006, or ADR-007.

## Decision

Introduce a **trusted-main DurableWorkflow** that owns **durable intent, trigger, queue state, and run history**. It does **not** own browser authority.

```text
DurableWorkflow owns durable intent, trigger, queue state, and run history.

It does NOT own browser authority.
```

```text
Persistence may survive process restart.

Browser authority may not.
```

```text
DurableWorkflow ≠ serialized AutonomousTask
```

A workflow restart must never restore a stale target, observation, document revision, approval, grant, `AgentRun`, AutonomousTask generation, or browser tab identity as executable authority.

---

## 1. V6 vs V7

```text
V6 AutonomousTask
- session scoped
- one explicit Delegate objective
- task-owned tabs
- bounded planner
- sequential V5 child runs
- disappears when runtime/process disappears
```

```text
V7 DurableWorkflow
- persisted definition
- persisted trigger
- persisted occurrence queue/history
- survives application restart
- may launch fresh V6 AutonomousTask executions
- may run from schedules while AI Browser is open
```

| | V6 | V7 |
|---|----|-----|
| Owner | `AutonomousTaskCoordinator` | `DurableWorkflowCoordinator` + `WorkflowStore` |
| Lifetime | current AI runtime / process | disk under `userData`, recovered on next launch |
| Trigger | explicit Delegate | manual + structured schedule |
| Browser workspace | adopt current tab / task-owned tabs | fresh trusted background tab + durable entry URL |
| Execution | one AutonomousTask | each live run is a **new** AutonomousTask |
| Approval | existing V4, process-local | existing V4, still process-local |
| After restart | gone | definition/queue/history remain; live authority is new |
| App closed | no work | no work (no daemon) |

V7 does **not** replace Ask, Act, or Delegate. Persistent workflows live on a separate product surface (`Workflows`). A workflow may launch Delegate internally; the user knows it is a persistent workflow.

### Forbidden architecture

Explicitly rejected:

```text
serialize AutonomousTaskSnapshot
serialize taskId/generation
serialize AgentRunRef
serialize tabId
serialize targetId
serialize observationId
serialize documentRevision
serialize approvalId
serialize PreparedAction
serialize ExecuteGrant

restart
deserialize
continue execution
```

A restart means **fresh runtime authority**.

---

## 2. Core invariant and inherited authority

V7 does not replace or weaken V3, V4, V5, or V6.

Every browser mutation still passes the frozen chain. Workflow orchestration does not classify semantic effect, mint grants, approve actions, or call interaction primitives.

`workflowId` and `occurrenceId` are correlation and durable identity. They are **not** substitutes for `InteractionGrant`, `ApprovalDecision`, `ExecuteGrant`, `AgentRunRef`, or `AutonomousTaskRef`.

Do not place `workflowId` or `occurrenceId` on:

```text
InteractionGrant
PreparedAction
ApprovalDecision
ExecuteGrant
```

Scheduling a workflow does **not** pre-approve future side effects. If a scheduled run reaches `PREPARE_ACTION`, existing V4 approval remains mandatory. If the user is not available, the occurrence waits inside the live V6/V4 path. There is no auto-approve, remembered approval, workflow-wide approval, or schedule-wide approval.

Free-text remains non-authoritative. `"yes"`, `"approve it"`, and `"continue"` are not approval. Only V4 `approvalId` + approve/reject may approve a consequential action.

---

## 3. Durable identity

```ts
type DurableWorkflowId = string;
type WorkflowOccurrenceId = string;
```

Both are:

```text
main-generated
opaque
correlation only
not browser authority
```

Neither grants tab ownership, target ownership, approval, or execution. The model does not choose these IDs. The renderer cannot use them to execute browser actions, select targets, approve actions, or change schedules.

---

## 4. Durable workflow definition

Keep definition separate from live execution state.

Conceptual shape (exact TypeScript names may differ in implementation):

```ts
interface DurableWorkflowDefinition {
  readonly workflowId: DurableWorkflowId;
  readonly definitionRevision: number;

  readonly name: string;
  readonly objective: string;

  readonly entryPoint: WorkflowEntryPoint;
  readonly trigger: WorkflowTrigger;

  readonly enabled: boolean;
  readonly reviewRequired: boolean;

  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Rules:

- `name` and `objective` are bounded trusted-product strings (not page text).
- `enabled` is the user on/off switch for future scheduling.
- `reviewRequired` suspends automatic starts until explicit user review.
- `definitionRevision` is monotonic per `workflowId`, incremented on every committed definition change (name, objective, entry point, trigger, enable/disable counted as definition commits that future occurrences must observe).
- An occurrence records the revision it was created from and a **frozen snapshot** of objective + entry point + trigger used for that run.
- Edits affect **future** occurrences only. They do not mutate an active or already-queued occurrence’s frozen snapshot.

---

## 5. Durable entry point

A scheduled workflow cannot depend on an old `tabId`.

```ts
interface WorkflowEntryPoint {
  readonly kind: 'url';
  readonly url: string;
}
```

Initial V7 supports **URL entry only**.

Validation (trusted main, at create/edit — not at model output time):

```text
http: or https: only
normal navigation policy applies
bounded length (2048 characters)
no javascript:
no file:
no data:
no blob:
no about: (including about:blank)
no chrome: / chrome-extension:
no arbitrary protocols
reject URLs whose parsed userinfo contains a username or password
  (username:password@, or username@)
```

Do **not** persist:

```text
tabId
WebContents ID
observationId
targetId
```

### URL credentials

Entry points containing `username:password@` (or any URL userinfo) are **rejected**. They must never be written to the store.

### Query-string privacy

Query strings may contain tokens, emails, or other sensitive parameters. V7 does **not** invent automatic query stripping: silent rewrite could change workflow semantics (wrong page, missing resource id).

If the user saves an entry URL that includes a query string, **workflow creation explicitly persists that local URL** as typed after protocol/userinfo/length validation. The URL remains on the local machine in the workflow store. It is not synced to the cloud in V7. Product copy should make persistence of the exact local URL explicit at create/edit time.

### Adjacent V0 session persistence (not V7 authority)

`persist:website` may keep cookies and cache across launches. A fresh tab navigating the entry URL may therefore land on an already-authenticated site. That is existing V0 website-session behavior. It is **not** restored V6/V4 authority: the occurrence still creates a new tab, new observation, new targets, new task, and new approvals. V7 must not persist cookies, passwords, OTP, or card data as workflow fields.

### Occurrence startup (trusted main only)

```text
trusted main
→ create fresh background browser tab
→ navigate to the frozen entry URL
→ create fresh V6 AutonomousTask on that trusted tab
```

No renderer-selected execution tab. The Workflows UI may request `run now`; main still creates the tab.

---

## 6. Triggers

```ts
type WorkflowTrigger =
  | { readonly kind: 'manual' }
  | { readonly kind: 'schedule'; readonly schedule: WorkflowSchedule };

type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // Monday=1 … Sunday=7

type WorkflowSchedule =
  | {
      readonly kind: 'one-time';
      readonly runAtUtc: string; // ISO-8601 instant with Z
    }
  | {
      readonly kind: 'recurring-daily';
      readonly timeZone: string; // IANA, e.g. "Europe/Stockholm"
      readonly hour: number; // 0–23 local
      readonly minute: number; // 0–59 local
    }
  | {
      readonly kind: 'recurring-weekly';
      readonly timeZone: string;
      readonly hour: number;
      readonly minute: number;
      readonly daysOfWeek: readonly IsoWeekday[]; // unique, non-empty, sorted
    };
```

Initial V7 supports **manual** and **scheduled**. Scheduled is a **small strict contract**, not a free-form cron string and not model-supplied cron.

Rejected for initial V7:

```text
arbitrary cron strings
every-N-minutes / sub-daily recurrence
RRULE blobs
model-authored schedule text
public webhook listener
external HTTP server
cloud scheduler
OS daemon / background service
```

A future `WorkflowTriggerPort` may be reserved for trusted event providers. External webhook execution is deferred (V8+ / separate integration). Planner output cannot alter workflow definition or trigger.

`manual` workflows still persist. They run only on trusted `run now` (or equivalent). They have no due-time scheduler work.

---

## 7. Time and timezone

- Persist **due timestamps** (`scheduledFor`, `runAtUtc`, `createdAt`, `startedAt`, `finishedAt`) as UTC ISO-8601 instants with `Z`.
- For recurring wall-clock schedules, **also persist the explicit IANA time zone** on the definition. Do not assume the computer’s future local timezone remains unchanged.
- Do not use model interpretation at execution time to decide schedule semantics.
- Timers (`setTimeout`) are **wake-up hints only**. Authority is `persisted due timestamp + trusted system clock at evaluation`.
- On startup, resume from sleep, clock change, and store commits: **recompute** what is due. Do not assume one long timer remained accurate.
- Prefer **one next-due timer + recompute on startup / wake / store changes** over constant tight polling.

### DST

Recurring schedules mean “that local wall-clock time in the persisted IANA zone.”

| Case | Rule |
|------|------|
| Spring-forward gap (local time does not exist) | Skip that local instant. Next occurrence is the next valid scheduled local time. |
| Fall-back overlap (local time occurs twice) | Use the **earlier** offset (first occurrence of that local time). |
| Zone renamed / unknown IANA id at evaluation | Fail closed for **that workflow’s** automatic starts: do not guess. Surface a schedule-error / review-required. Do not enqueue. |

The occurrence’s `scheduledFor` is the computed UTC instant after applying the rules above. Idempotency keys use that UTC instant.

---

## 8. App closed means zero execution

```text
AI Browser closed
→ no browser actions
→ no model calls
→ no workflow execution
```

V7 persistence is **not** an OS daemon, login item, or self-wake. Schedules become eligible only while the AI Browser process is running **and** holds the single-instance writer lock.

On next launch, after store validation and recovery, the scheduler evaluates persisted due times.

---

## 9. Missed schedule (misfire) policy

Deterministic, no catch-up storm.

### Recurring

If the app was closed through several recurring local times:

```text
do NOT enqueue one occurrence per missed slot
```

On evaluation (startup or wake):

1. Compute the most recent missed local occurrence instant `T_missed` that is `<= now` and has no durable occurrence with that trigger key.
2. If the workflow is eligible (`enabled && !reviewRequired`) and `T_missed` exists, enqueue **at most one** catch-up occurrence with `scheduledFor = T_missed`.
3. Compute the next **future** occurrence after `now` and arm the next-due timer. Do not enqueue the future one until it is due.

If a record already exists for `T_missed` (queued, running, or terminal), do not enqueue another.

### One-time

If `runAtUtc <= now` and no occurrence exists for that trigger key, enqueue **once**. Never duplicate.

### Ineligible workflows

Disabled, `reviewRequired`, storage-error, or non-writer instance: enqueue nothing, including no catch-up.

---

## 10. Idempotent occurrence keys

Every scheduled occurrence has a durable unique trigger key:

```text
scheduled triggerKey = workflowId + ":" + scheduledForUtc
```

Invariant:

```text
same scheduled occurrence → at most one durable queue/history record
```

Restart, clock recomputation, or scheduler rerun must not duplicate that key.

Manual `run now` uses a generated `occurrenceId` and trigger key:

```text
manual triggerKey = "manual:" + occurrenceId
```

Each trusted run-now is a distinct occurrence. Manual runs are not coalesced with scheduled keys.

---

## 11. Occurrence vs definition

A workflow definition is reusable. Each trigger creates a new `occurrenceId` with an independent terminal result. Completing a recurring occurrence does **not** complete or delete the definition.

Suggested occurrence states:

```text
queued
running
completed
blocked
failed
cancelled
execution-state-unknown
interrupted
```

Do **not** persist V6’s live state machine (`planning`, `running-subgoal`, `awaiting-approval`, …) as the durable run state.

| Durable state | Meaning |
|---------------|---------|
| `queued` | Durable record exists; not started in this runtime |
| `running` | This runtime session started a live V6 task for it |
| `completed` | Live V6 task completed with a final answer |
| `blocked` | Terminal user/policy stop: V3 DENY, V4 reject/expiry/stale, user stop mapped as blocked, etc. |
| `failed` | Terminal execution failure (including V4 failed) |
| `cancelled` | Trusted cancel of a queued (not started) occurrence, or explicit cancel before start |
| `execution-state-unknown` | Live V6 task ended `execution-state-unknown` |
| `interrupted` | Store said `running` for a **previous** `runtimeSessionId` |

`queued` and `running` are nonterminal. All others are terminal.

---

## 12. Runtime session identity and crash recovery

Introduce a fresh `runtimeSessionId` per AI Browser process (main-generated, opaque). Persist it **only** as crash/recovery metadata on an occurrence that is `running`.

On startup, after lock + validated load:

```text
occurrence.state == running
AND occurrence.ownerRuntimeSessionId != current runtimeSessionId
→ state = interrupted
→ workflow.reviewRequired = true
```

Never treat the old runtime session as live. Never automatically continue that occurrence.

### `interrupted` is required

The old process may have died at any point around browser execution — including after an external side effect. Blind replay is forbidden.

```text
old occurrence = interrupted
→ zero automatic V6 continuation
→ zero automatic browser action
→ zero automatic approval recreation
```

### Graceful quit vs crash

A future implementation may attempt to pause/drain on `before-quit` / `will-quit`. Durable correctness **must not** depend on those hooks succeeding.

On next start, a persisted prior-session `running` occurrence is always recoverable as `interrupted`, even if no shutdown hook ran.

Graceful shutdown that successfully records a terminal occurrence state (completed/blocked/failed/cancelled/unknown) is honored. Only leftover `running` rows from another session become `interrupted`.

---

## 13. Review-required suspends automation

If any occurrence of a workflow finishes `execution-state-unknown` **or** is recovered as `interrupted`:

```text
workflow.reviewRequired = true
future scheduled occurrences are not started
catch-up is not enqueued
```

until an explicit trusted user review action such as:

```text
acknowledge interrupted run
mark reviewed
```

Review is **not** Retry.

It must **not**:

```text
retry the old ExecuteGrant
resume old AgentRun
reuse old approval
replay the exact browser action automatically
```

If the user starts work again:

```text
fresh WorkflowOccurrence
fresh V6 task
fresh observation
fresh V4 approvals
```

Acknowledging review re-enables future scheduling **only if** `enabled` is still true. It does not start the interrupted occurrence.

---

## 14. Approval after restart

Pending V4 approval is process-local. Never persist it as resumable approval authority.

If the application exits while a workflow occurrence is awaiting approval:

```text
old approval is gone
on restart: occurrence → interrupted; workflow → review-required
```

Do not reconstruct `approvalId`, `PreparedAction`, or `ExecuteGrant`.

---

## 15. Fresh V6 task per live execution

```text
DurableWorkflowCoordinator
        │
        ▼
WorkflowOccurrenceRunner
        │
        ▼
fresh trusted background tab
        │
        ▼
AutonomousTaskController / V6
        │
        ▼
V5 child runs
        │
        ▼
V3 / V4
```

V7 does not bypass V6. Workflow orchestration must **not** call:

```text
click
type
select
scroll
ExecuteExecutor
InteractionExecutor
```

Allowed trusted browser activity for occurrence **startup** only:

```text
create fresh tab
navigate to trusted persisted entry URL
```

Actual task interaction continues through V6 → V5 → V3/V4.

Module ownership:

| Module | Owns | Must not |
|--------|------|----------|
| `WorkflowStore` | atomic load/commit, schema, revision | Browser, approval, model |
| `DurableWorkflowCoordinator` | definitions, occurrence state, durable queue, review state | Mint grants; call interaction primitives; parse cron |
| `WorkflowScheduler` | due calculation, misfire coalesce, next-due timer | Import `BrowserAdapter` interaction methods, `ApprovalManager`, `ExecuteExecutor`, `InteractionExecutor` |
| `WorkflowOccurrenceRunner` | start fresh tab + URL + V6 task; map terminal V6 result to occurrence | Restore stale handles; approve; bypass V6 |

`WorkflowScheduler` determines **due occurrence identity only**. It does not start browser work.

---

## 16. Concurrency

Initial V7 is intentionally serialized:

```text
maximum one active DurableWorkflow occurrence
maximum one active V6 AutonomousTask
```

Queued scheduled occurrences may exist durably (FIFO / deterministic ordering). The model does not select queue priority. Any future priority is trusted product configuration.

Do not add parallel workflows, parallel V6 tasks, or parallel browser mutation chains in initial V7. One browser mutation chain remains the V3–V6 rule.

### Manual Delegate vs scheduled occurrence

| Situation | Rule |
|-----------|------|
| Ordinary V6 Delegate is active | Due workflow occurrence becomes **queued**. Do not supersede the user’s current task. |
| Workflow occurrence owns the V6 slot | New manual Delegate **fails busy** (or requires explicit Pause/Stop first). |
| Either side | Do **not** silently cancel the other. |

Queued FIFO: when the V6 slot becomes free, the oldest eligible queued occurrence may start, subject to `enabled && !reviewRequired` and store health.

### Manual Act

Preserve V6 behavior:

```text
manual Act on workflow/task-owned tab → require Pause/Stop
manual Act on unrelated tab          → allowed
```

Do not globally freeze the browser because a scheduled workflow is running.

---

## 17. Durable queue

Trusted main-only queue:

```text
durable
FIFO / deterministic ordering
one active occurrence
idempotent trigger insertion
no model access
```

Enqueue is a store transaction. Duplicate `triggerKey` is a no-op (return the existing record).

---

## 18. Persistence abstraction

One storage boundary. Workflow modules must not call arbitrary filesystem APIs throughout the codebase.

```ts
interface WorkflowStore {
  load(): Promise<WorkflowStoreSnapshot>;
  commit(
    expectedStoreRevision: number,
    mutation: WorkflowStoreMutation,
  ): Promise<WorkflowStoreSnapshot>;
}
```

Requirements:

```text
atomic state updates
schema version
monotonic store revision
single writer (in-process serial queue + single-instance lock)
strict validation after serialize and after load
bounded file size
```

`commit` fails if `expectedStoreRevision` does not match. Callers retry by loading the latest snapshot. This is the transaction boundary for edit/enqueue/delete races.

---

## 19. Initial storage backend

**Accepted: main-process atomic JSON file** under Electron `app.getPath('userData')`.

Conceptual path:

```text
<userData>/workflows-v1.json
```

| Option | Verdict | Reason |
|--------|---------|--------|
| Atomic JSON under `userData` | **Accepted** | No DB dependency exists; workflow volume is bounded; single writer; fail-closed schema validation is straightforward; Electron rebuild of native sqlite is unjustified for this scope |
| SQLite / `better-sqlite3` | Rejected for initial V7 | Adds native dependency and rebuild surface; no current product need for concurrent queries or large history |
| Renderer `localStorage` / IndexedDB | Rejected | Untrusted renderer must not own durable workflow authority |
| Multiple ad-hoc files | Rejected | Breaks atomic definition+queue commits |

This architecture task does **not** install dependencies.

Tests and acceptance **must** point the store at a temporary directory. Never write acceptance state into the developer’s real Electron `userData`.

---

## 20. Atomic file requirements

Never mutate the canonical file in-place.

```text
single writer queue
write temporary file in the same directory
flush (fsync) the temp file
atomic rename/replace onto the canonical name
best-effort directory flush where supported
schema validation of the bytes that were written
bounded file size
```

Windows: Node `fs.rename` does not overwrite an existing destination. Implementation must use an explicit replace that is correct on Windows **under the single-writer lock** (for example: fsync temp, then replace canonical). A brief dest-missing window is acceptable only because a second process must not hold the writer lock.

**Last-known-good backup:** after a successful commit, keep the previous canonical bytes as `workflows-v1.last-known-good.json` (or equivalent). Backup is **not** auto-promoted into execution (see corruption).

---

## 21. Corruption handling

Fail closed.

If the canonical store cannot be validated:

```text
DO NOT execute scheduled workflows
DO NOT silently reset to empty store
product state = workflow-storage-error
```

Never guess missing workflow fields. Unknown properties that are not in the schema fail closed (or are rejected as extra, consistent with existing strict parsers).

If a last-known-good backup exists and validates, it still must **not** be auto-restored. Auto-restore could hide intervening commits or mask data loss. A later trusted product action may offer explicit restore-from-backup. Until then: no automatic starts.

---

## 22. Schema version

Persist:

```text
schemaVersion
storeRevision
```

Initial `schemaVersion = 1`. `storeRevision` is monotonic across successful commits.

Unknown **newer** schema: refuse execution (storage-error). Do not downgrade or heuristically parse.

Future migrations (not implemented in this architecture phase) must:

```text
backup first
migrate explicitly
validate output
```

---

## 23. Single writer / single instance

Persistent scheduling must not have two app processes independently executing the same due occurrence.

Adopt:

```text
Electron app.requestSingleInstanceLock()
```

The process that **fails** to acquire the lock:

```text
must not load WorkflowStore for execution
must not run WorkflowScheduler
must not run WorkflowOccurrenceRunner
```

Typical product behavior: focus the first instance’s window and exit the second. Do not depend only on file timing.

In-process, all store commits go through one serial write queue.

---

## 24. Persisted data allowlist

Persist only what V7 needs, all bounded:

```text
schemaVersion, storeRevision

workflowId, name, objective
entry URL
trigger/schedule (structured)
enabled, reviewRequired
definitionRevision
createdAt, updatedAt

occurrenceId, workflowId, definitionRevision
triggerKey, scheduledFor
frozen objective + entry URL snapshot
createdAt, startedAt, finishedAt
terminal state + bounded reason code
bounded final answer / result summary
ownerRuntimeSessionId (running/interrupted recovery only)
```

History is a product requirement: persist **objective, bounded final answer, terminal status, timestamps** — not every internal model step.

Recommended bound: final answer truncated to the existing conversation/answer budget used by V6 (implementation names the constant). Child subgoal prose, raw page content, and planner chain-of-thought must not become a durable transcript.

Occurrence history retention: keep all nonterminal occurrences plus the most recent **50** terminal occurrences per workflow. Prune oldest terminal history only. Never prune `queued` / `running` / `interrupted` / `execution-state-unknown` awaiting review.

---

## 25. Persisted data denylist

Never persist as resumable workflow state:

```text
tabId
WebContents ID

taskId / AutonomousTaskRef generation
AgentRunRef / runId

targetId
observationId
documentRevision
backendDOMNodeId
frameId

approvalId
preparedActionId
executionId

InteractionGrant
ExecuteGrant

CDP session identity
screen coordinates

cookies
passwords
OTP
card data

screenshots
raw DOM snapshots
full PageObservation
raw planner reasoning
chain-of-thought
```

If any audit field is persisted, **metadata only** (event type, timestamps, ids that are correlation-only). Audit must not gate authority.

---

## 26. Failure, rejection, unknown — no auto retry

| Live / durable outcome | Durable occurrence | Workflow automation | Next scheduled occurrence |
|------------------------|--------------------|---------------------|---------------------------|
| V6 completed | `completed` | unchanged | eligible if enabled |
| V3 DENY | `blocked` | unchanged | eligible if enabled; **this** occurrence is not retried |
| V4 reject | `blocked` (`APPROVAL_REJECTED`) | unchanged | eligible if enabled; rejection is **not** workflow-wide policy |
| V4 expired / stale | `blocked` | unchanged | eligible if enabled |
| V4 failed | `failed` | unchanged | eligible if enabled |
| V4 / V6 `execution-state-unknown` | `execution-state-unknown` | `reviewRequired = true` | **not** started until review |
| Process death while `running` | `interrupted` | `reviewRequired = true` | **not** started until review |
| Workflow execution failure | `failed` | unchanged | eligible if enabled |
| User cancel of queued item | `cancelled` | unchanged | n/a for that occurrence |

No automatic retries for V3 DENY, V4 reject/expired/stale/failed/unknown, or workflow execution failure.

A **future scheduled occurrence** is distinct from retrying the same occurrence. Do not collapse those concepts.

---

## 27. Product controls

Trusted lifecycle (main-only; renderer sends typed requests):

```text
create workflow
edit workflow
enable
disable
run now
cancel queued occurrence
stop active occurrence
view history
delete workflow
review interrupted/unknown occurrence
```

No renderer direct execution primitive. No generic filesystem IPC. No `executeCronString(...)`.

Website pages and remote models cannot create/change schedules, enable workflows, clear review-required, or change due times unless a trusted user product action explicitly requests it.

Page text such as “Run this every five minutes” has **zero** authority. V6 child models remain inside the current occurrence only.

---

## 28. Edit, queue, and delete races

### Edit while queued or running

The active or already-queued occurrence keeps its frozen definition snapshot. New edits increment `definitionRevision` and apply to **later** enqueues.

### Queue / edit race

If a schedule fires in the same commit window as an edit:

```text
one occurrence captures exactly one committed definition revision
```

No mixed objective from revision N and entry URL from N+1. The store transaction is the authority.

### Disable / delete vs enqueue

If a due occurrence is being enqueued while the workflow is disabled or deleted, `storeRevision` / the same `commit` decides one winner:

- Successful disable/delete: no new ghost occurrence after that commit. Idempotent enqueue of a deleted workflow is a no-op.
- Successful enqueue then disable: the queued occurrence remains until cancelled or started according to disable rules below.

### Delete behavior

Deleting a workflow must:

```text
disable future scheduling immediately
remove queued not-yet-started occurrences (mark cancelled or delete the records)
```

If an occurrence is currently **active** (`running`):

```text
require Stop first
```

or perform an explicit trusted Stop (cancel live V6 task) **before** deletion in the same user action. Do not silently delete authority bookkeeping while browser work continues.

After successful delete: definition, queued rows, and history for that `workflowId` are removed from the store (bounded; no lingering schedule keys). Interrupted/unknown rows cannot be deleted without Stop/acknowledge as required so review cannot be erased while a live task still runs. If already terminal `interrupted` / `unknown` and no live task, delete may remove them with the workflow.

---

## 29. UI boundaries

Future UI may show:

```text
workflow name
enabled/disabled
review required
next run
last result
run history
```

Do not expose persistence internals (`userData` path, schema bytes) or browser authority handles.

Renderer receives `workflowId` / `occurrenceId` as correlation only.

---

## 30. Startup order

```text
acquire single-instance writer lock
load + validate WorkflowStore
create new runtimeSessionId
recover stale active occurrences → interrupted
mark affected workflows review-required
initialize scheduler
evaluate due occurrences
enqueue eligible occurrences (idempotent, misfire coalesce)
only then allow automatic workflow execution
```

Corruption/recovery happens **before** scheduler execution. Non-writer instances never reach scheduler init.

---

## 31. Future safe checkpoints (reserved, not initial V7)

Initial V7 uses:

```text
interrupted + explicit fresh run after review
```

for active-process loss.

A future cross-restart continuation checkpoint, if ever added, may only be taken when:

```text
no planner call active
no child AgentRun active
no V4 approval pending/executing
no browser mutation unresolved
```

It would still create **fresh** runtime authority after restart (new tab, new observation, new task). Serializing live V6 state is **not** the checkpoint mechanism. Initial V7 must not implement checkpoints.

---

## 32. V8 boundary

Keep out of initial V7:

```text
multi-agent orchestration
OS-wide computer control
native desktop app control
cloud execution
mobile remote control
cross-device sync
voice assistant
long-term semantic memory
email/calendar connectors
general MCP automation
public webhooks
sub-daily high-frequency schedules
parallel workflow execution
```

---

## 33. Explicit decision record

| Question | Decision |
|----------|----------|
| What exactly is durable? | Workflow definition (name, objective, entry URL, structured trigger, enabled/reviewRequired, definitionRevision), occurrence queue/history (ids, triggerKey, scheduledFor, frozen snapshot, terminal state, bounded final answer, timestamps, ownerRuntimeSessionId for recovery), schemaVersion, storeRevision |
| What is explicitly never durable? | tab/WebContents ids; task/run/generation; targets/observations/documentRevision/CDP; approval/prepared/execute grants; cookies/secrets; screenshots/DOM/planner traces; V6 live state machine |
| What is a Workflow vs an Occurrence? | Workflow = reusable persisted definition + automation flags. Occurrence = one triggered attempt with independent terminal result |
| What is the workflow state machine? | Definition: enabled + reviewRequired. Occurrence: queued → running → terminal {completed, blocked, failed, cancelled, execution-state-unknown, interrupted} |
| What happens after crash? | Next launch: running rows of other runtimeSessionId → interrupted; reviewRequired; no auto replay |
| What happens after graceful restart? | Same recovery if any occurrence still `running`. Terminal rows recorded before exit are honored. Scheduler then evaluates due work for eligible workflows |
| Does an interrupted run auto-resume? | **No.** Never |
| What does review-required mean? | Automatic starts and catch-up are suspended until trusted acknowledge/mark-reviewed. Not a retry |
| What happens to pending V4 approval after restart? | Gone. Occurrence interrupted. Do not reconstruct grants |
| Can a scheduled action execute while app is closed? | **No.** Zero browser/model/workflow execution |
| How are missed schedules handled? | Recurring: at most one catch-up (latest missed instant). One-time overdue: enqueue once. No storm |
| How are schedule occurrences deduplicated? | `workflowId + scheduledForUtc` unique triggerKey |
| How are time zones handled? | Due instants UTC. Recurring wall-clock + required IANA zone. DST skip-gap / earlier-offset overlap. Unknown zone fails closed |
| How many workflows can execute simultaneously? | One active occurrence; one V6 task |
| How does manual Delegate interact with scheduled workflow execution? | Delegate active → workflow queues. Workflow active → Delegate busy. No silent cancel. Act on unrelated tabs still allowed |
| How does a workflow create fresh browser workspace? | Main creates background tab, navigates frozen http(s) entry URL, starts fresh V6 task on that tab |
| Can planner/page content alter schedule? | **No.** Zero authority |
| What persistence backend is used? | Atomic JSON under `app.getPath('userData')` (`workflows-v1.json`). No new DB dependency |
| How are writes atomic? | Temp file, fsync, Windows-correct replace, last-known-good backup, serial writer queue |
| What happens on corrupt storage? | Fail closed; workflow-storage-error; no schedule execution; no silent empty reset; no auto backup promotion |
| How are schema versions/migrations handled? | schemaVersion required; unknown newer refuses execution; migrations later = backup + explicit migrate + validate |
| How is single-writer ownership enforced? | `requestSingleInstanceLock` + in-process serial commit queue. Loser must not run scheduler |
| What fields are forbidden from disk? | See denylist §25 |
| What makes workflowId/occurrenceId non-authoritative? | Opaque main-generated correlation; not on grants; cannot execute/approve/own tabs |
| What happens after V4 unknown? | Occurrence `execution-state-unknown`; workflow reviewRequired; no future auto starts until review |
| Can failed/rejected occurrence auto-retry? | **No.** Future schedule is a new occurrence, not a retry |
| How do edits affect already queued/running occurrences? | Frozen snapshot at enqueue/start; edits bump definitionRevision for future only |
| What happens on delete? | Immediate no future schedule; drop queued; Stop required if running; then remove definition+history |
| What remains V8+? | Webhooks, cloud/OS daemons, parallel workflows, multi-agent, connectors, checkpoints-as-continuation, sub-daily cron, DB unless later justified |

No unanswered TODOs on authority or recovery semantics.

---

## 34. Security invariants

```text
[ ] Workflow IDs are correlation only
[ ] No persisted target authority
[ ] No persisted approval/grant authority
[ ] No persisted AgentRun/AutonomousTask authority
[ ] Restart creates fresh browser authority
[ ] Interrupted run is never auto-replayed
[ ] Unknown suspends automation
[ ] Every consequential action still requires fresh V4 approval
[ ] No workflow-wide approval
[ ] Model/page cannot modify workflow schedule
[ ] One active occurrence initially
[ ] One browser mutation chain remains enforced
[ ] Occurrence enqueue is idempotent
[ ] Store corruption fails closed
[ ] Second app process cannot run a second scheduler
[ ] App closed means zero execution
[ ] No automatic browser-action retry
[ ] No external webhook/cloud daemon in initial V7
[ ] V3/V4/V5/V6 authority remains unchanged
```

---

## Consequences

- V7 sits above V6 without a parallel browser stack and without deserializing live authority.
- Implementation is specified in `docs/plans/V7-persistent-workflows.md`. This ADR does **not** start implementation.
- Ask, Act, and Delegate remain. Workflows is a separate explicit product surface.
- V8 remains the home for AI-native browser expansion (connectors, multi-agent, cloud, OS control).

V7 architecture is locked by this ADR. Implementation is **not** started by accepting this ADR.

```text
ADR-008 Status: Accepted
V7 implementation: NOT STARTED
V6 remains COMPLETE / CLOSED
```
