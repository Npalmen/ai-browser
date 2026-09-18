# ADR-006: Agent loop orchestration

**Status:** Accepted  
**Date:** 2026-09-18  
**Supersedes:** none  
**Extends:** ADR-003, ADR-004, ADR-005  
**Does not reopen:** V0 shell, V1 observation, V2 read-only agent, V3 INTERACT authority, V4 PREPARE / APPROVAL / EXECUTE authority  
**See also:** `docs/architecture/browser-architecture.md`; `docs/plans/V5-agent-loop.md`; `docs/plans/V4-prepare-approval-execute.md`; `.cursor/rules/browser-agent-safety.mdc`

## Context

V0–V4 are complete and frozen. Current product Act mode is a **single** observe → reason → one V3 action or one V4 prepared approval per explicit user request (`InteractiveAgent.interact()`).

The implemented authority chain is unchanged from ADR-004 / ADR-005:

```text
model structured proposal
→ strict schema validation
→ trusted local binding
→ deterministic InteractionPolicy
```

Then:

```text
ALLOW_INTERACT / ALLOW_NAVIGATE
→ InteractionGrant
→ InteractionExecutor
→ BrowserAdapter
```

or:

```text
DEFER_EXECUTE supported click
→ PreparedAction
→ explicit human approval
→ ExecuteGrant
→ ExecuteExecutor
→ BrowserAdapter
```

or:

```text
DENY
→ no action
```

V4 is one prepared consequential click, one approval, one single-use `ExecuteGrant`. It is not a loop. ADR-005 explicitly defers multi-step observe→act orchestration to V5.

Users need one explicit instruction such as “Open account settings and enable dark mode” to continue through several **safe** V3 steps, and a consequential instruction such as “Book this appointment” to pause for **per-action** V4 approval, then resume.

This ADR locks that orchestration. It does **not** give the model browser authority, mint grants, approve actions, or replace V3/V4 executors.

### Current-contract findings this ADR must respect

- `InteractiveAgent` is one bounded step per `interact()` call. Each call bumps a per-tab generation token and aborts the previous in-flight call. Repeated `interact()` cannot be the V5 loop as implemented.
- `InteractiveAgent` commits `ConversationStore` turns for non-approval results. Looping that would invent artificial user turns and collide with revision-bound history (`ConversationStore` clears when `documentRevision` changes).
- Model contract remains ADR-003/004 structured output: `answer` **or** one `ModelInteractionProposal`. Provider fallback (`MAX_MODEL_ATTEMPTS = 2`) is inside one logical generation.
- V3/V4 already return a mandatory fresh `PageObservation` after successful mutation.
- `ApprovalWorkflowController.decide` claims then executes, then emits renderer-safe outcomes. V4 grants stay tab/action scoped. They do not know about tasks.
- Trusted chrome navigation already calls `invalidateApprovalTab`. Adapter `onTabInvalidated('navigation')` fires for main-frame navigations, including agent-caused ones. V4 already ignores post-dispatch navigation while `executing`.
- `ReadOnlyAgent` is the Ask path. V5 must not silently give Ask mode action capability.

No contradiction requires reopening ADR-004 or ADR-005. V5 sequences existing one-step primitives. It does not change `InteractionGrant`, `PreparedAction`, `ApprovalDecision`, or `ExecuteGrant`.

## Decision

Introduce a **trusted-main AgentRun** and **AgentRunCoordinator** that own **task progression**, not browser authority.

```text
The agent loop owns task progression, not browser authority.
```

The loop may decide:

```text
observe again
ask the model again
stop
wait for approval
resume after a successful approved execution
```

The loop may **not**:

```text
mint InteractionGrant
mint ExecuteGrant
approve an action
override DENY
reuse a stale target
retry EXECUTE automatically
call BrowserAdapter directly
```

V5 is:

```text
one foreground user-initiated task
+ bounded sequential steps
+ one browser action at a time
+ explicit approval for every consequential action
```

V5 is **not**:

```text
background agents
scheduled tasks
persistent workflows
parallel browser actions
multi-agent delegation
always-approve
approval memory
cross-session task recovery
```

Those remain V6/V7+.

---

## 1. Core invariant and inherited authority

V5 does not replace or weaken V3 or V4.

Every browser mutation still passes the frozen chain. `AgentRunCoordinator` interprets executor **status**. It does not classify semantic effect. There is no `agentLoopPolicy` that can override `InteractionPolicy`.

Mandatory:

```text
DENY ≠ DEFER_EXECUTE
```

The loop cannot convert a denial into an approval prompt because “the model really needs this.”

`runId` is correlation and state identity. It is **not** a substitute for `InteractionGrant`, `ApprovalDecision`, or `ExecuteGrant`.

---

## 2. Ownership and module split

| Module | Owns | Must not |
|--------|------|----------|
| `AgentRunCoordinator` (trusted main) | `AgentRun` lifecycle, budgets, pause/resume, supersede, late-result rejection, run-local progress | Mint grants; classify INTERACT vs EXECUTE; call `BrowserAdapter`; persist runs |
| One-step agent (`InteractiveStepAgent`, extracted from `InteractiveAgent`) | One observe → model → validate → bind → policy → at most one V3 execute or V4 prepare | Loop; raise budgets; commit intermediate conversation turns; own approval decisions |
| V4 approval workflow | `PreparedAction` → `ApprovalDecision` → `ExecuteGrant` → `ExecuteExecutor` | Know task policy; resume cancelled runs; retry EXECUTE |
| `AiRequestController` | Renderer-safe ask/run events, abort plumbing, composing coordinator + workflow | Contain the loop; mint grants |
| `ReadOnlyAgent` | Ask / read-only Q&A | Mutate pages; participate in AgentRuns |

Trusted main owns run lifecycle. Renderer state is never authoritative.

Exact class names may differ in implementation. The split must not stuff the loop into `AiRequestController` or put V4 grant logic into the coordinator.

`ReadOnlyAgent` stays unchanged.

---

## 3. Per-tab task ownership

```text
maximum one active AgentRun per tab
```

Different tabs may have independent runs. No cross-tab leakage of approval, cancellation, budgets, or target identity.

Starting another Act task on the same tab:

```text
1. mark old run cancelled/superseded
2. abort active model generation
3. invalidate unresolved same-tab approval owned by the old run
4. prevent waiter resume
5. start the new run
```

The previous run can never resume. Late completions from the old run are ignored (see §16).

---

## 4. AgentRun record

Trusted in-memory record, conceptually:

```ts
type AgentRunId = string;

type AgentRunState =
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'cancelled'
  | 'blocked'
  | 'failed'
  | 'execution-state-unknown';

interface AgentRun {
  readonly runId: AgentRunId;
  readonly tabId: TabId;
  readonly instruction: string;
  readonly startedAt: number;
  state: AgentRunState;
  modelStepCount: number;
  actionAttemptCount: number;
  approvalCount: number;
}
```

Exact fields may add generation, instruction snapshot, last trusted observation handle, last success fingerprint, and internal waiter identity. Implementation must **not** put browser execution handles (`backendNodeId`, `frameId`, grants, CDP session) on renderer-facing run DTOs.

`runId` is main-generated, opaque, and local. The model does not choose it. If the renderer sees `runId`, it is correlation only, never authority.

Process restart: the run is gone. Unresolved V4 approvals are gone through the existing V4 runtime lifecycle. No database. No resume-after-restart. V7 owns persistent workflows.

---

## 5. State machine

```text
running
  ├─ model answer                         → completed
  ├─ safe V3 action succeeded             → running
  ├─ DEFER_EXECUTE prepared               → awaiting-approval
  ├─ denial / unsupported / budget /
  │  stale / no-progress / reject /
  │  expiry                               → blocked
  ├─ mechanical / model failure           → failed
  ├─ V4 unknown after dispatch            → execution-state-unknown
  └─ user cancel / supersede /
     tab close / renderer crash /
     trusted chrome navigation            → cancelled

awaiting-approval
  ├─ reject                               → blocked
  ├─ expired                              → blocked
  ├─ V4 stale before/at dispatch          → blocked
  ├─ approve + executed                   → running
  ├─ approve + pre-dispatch failed        → failed
  ├─ approve + unknown                    → execution-state-unknown
  └─ cancel / supersede / tab close /
     renderer crash / trusted chrome nav  → cancelled
```

Terminal states:

```text
completed
cancelled
blocked
failed
execution-state-unknown
```

No transition out of a terminal state. A new user instruction creates a **new** `runId`.

---

## 6. Hard budgets

Local constants. The model cannot raise them. The renderer cannot raise them.

```text
MAX_AGENT_LOOP_MODEL_STEPS = 8
MAX_AGENT_LOOP_ACTION_ATTEMPTS = 6
MAX_AGENT_LOOP_APPROVALS = 2
```

Rationale: V3 is one action and V4 is one execute. A settings-style task is typically 2–3 model steps. Eight model steps, six action attempts, and two independent approvals are conservative headroom for one foreground task without unbounded looping.

### 6.1 modelStepCount

Increment **once** per completed logical model generation that yields a valid:

```text
answer
or
one ModelInteractionProposal
```

Existing provider fallback (`MODEL_UNAVAILABLE`, `MODEL_RATE_LIMITED`, `MODEL_TIMEOUT`, `MODEL_OUTPUT_INVALID`, `MAX_MODEL_ATTEMPTS = 2`) remains **inside** that one logical generation. Fallback retries are not V5 steps.

Observation retries (`PAGE_CHANGED_DURING_OBSERVATION`) are not model steps and not action attempts.

If every fallback attempt fails: `AgentRun → failed`. Do not ask the model again. Do not execute a browser action.

Check `modelStepCount >= MAX_AGENT_LOOP_MODEL_STEPS` **before** starting the next model generation. After the 8th valid generation, the coordinator may still take the single resulting action if action/approval budgets remain; the following iteration stops without another model call (`STEP_LIMIT_REACHED` if no final answer was produced).

### 6.2 actionAttemptCount

Increment when a trusted browser action path is **entered**:

```text
V3 InteractionExecutor action
or
V4 ExecuteExecutor execution attempt
```

Preparation and approval presentation are not browser actions.

### 6.3 approvalCount

Increment when a new V4 approval is **presented** for that run. No invisible approval retries.

### 6.4 Budget checks before authority

Check budgets **before** creating authority that cannot be used:

- No remaining model budget → do not call the model.
- No remaining action budget → do not enter `InteractionExecutor` and do not create a `PreparedAction`.
- No remaining approval budget → do not create a `PreparedAction` and do not show an approval.

This avoids dead approvals that cannot later execute.

When a budget is exhausted:

```text
stop the run
do not ask the model again
do not execute another browser action
```

Renderer-safe result: `STEP_LIMIT_REACHED` (blocked). No automatic continuation. The user must start a new task.

---

## 7. No-progress guard

In addition to numerical budgets, detect an immediately repeated exact proposal against the same document authority.

Fingerprint:

```text
documentRevision
+ proposal kind
+ targetId / optionTargetId / bounded primitive payload
```

If the loop proposes the same effective action again on the same `documentRevision` **immediately after that action already succeeded**:

```text
→ stop as AGENT_LOOP_NO_PROGRESS (blocked)
```

No fuzzy comparison. No model-judged “progress.” Do not click the same control indefinitely.

---

## 8. Model contract

**Do not expand the model authority schema.**

Each model call still returns the current V3/V4 structured output:

```text
answer
or
one ModelInteractionProposal
```

V5 obtains multiple actions by making multiple bounded model calls. Do not introduce provider tool-calling to implement the loop. Do not convert V5 into “model tool call → automatic browser tool execution.”

Do not expose to the model:

```text
runId
approvalId
preparedActionId
executionId
InteractionGrant
ExecuteGrant
browser authority
loop limits
target/backend handles
```

Structured-output remains the boundary:

```text
ModelRuntime structured output
→ project validator
→ binder
→ policy
```

The model cannot say “continue indefinitely,” “I need 30 more steps,” or “ignore the limit.” Termination is main-owned deterministic logic.

---

## 9. Fresh observation and target lifetime

Each new model decision must be based on a fresh local observation.

```text
observe / reuse trusted post-action observation
→ build model context
→ model decision
→ validate / bind
→ trusted action
→ fresh post-action state
→ next iteration
```

**Reuse rule.** The loop may reuse a proven fresh executor observation as the next inference observation **only if**:

1. it is exactly the trusted post-action `PageObservation` returned by `InteractionExecutor` or `ExecuteExecutor` for this run’s last successful mutation, and
2. no intervening navigation, observation, tab invalidation, or user chrome action has occurred since that observation was produced.

Otherwise call `observePage()` again.

Do **not** rebind old targets into a new observation. After every successful mutation, previous `targetId`, `optionTargetId`, `backendNodeId`, and `documentRevision` are dead as executable authority. The next proposal binds only against the observation used for that next model call.

Stale V3/V4 protections remain authoritative if the page changes while a model step is reasoning or before its proposal executes. Initial V5 behavior: a stale action result **terminates/blocks** the current run. No silent unbounded replan. The user may start a fresh task.

Do **not** automatically recreate or re-approve V4 EXECUTE after stale.

---

## 10. Navigation

Agent-caused safe navigation or approved consequential navigation **must** be allowed to continue the run after the mandatory fresh observation. Do not treat every navigation as run cancellation.

```text
agent clicks a safe Next link
→ page navigates
→ executor observes the new page
→ loop continues
```

```text
approved Buy now navigates
→ V4 remains executing after dispatch
→ fresh observation
→ executed
→ V5 may continue
```

**Trusted chrome navigation** (existing IPC `navigate` / back / forward / reload) while a run is active:

```text
cancel/supersede the AgentRun
invalidate unresolved approval
```

That is explicit user steering of the tab, not the agent’s action.

**Website or in-page user navigation** while `running` and **not** inside an in-flight V3/V4 executor: cancel the run. Do not execute a proposal inferred against the previous page. If a V3 stale result still occurs, terminate as blocked.

**Website navigation while `awaiting-approval`:** existing V4 stale path; run terminates as blocked/stale.

In-flight executor navigation follows V3/V4 rules, not a second coordinator policy.

Browser layer may signal `navigation`, `tab-close`, and `renderer-crash`. `AgentRunCoordinator` owns task state. The browser layer must never call model/run logic directly. Do not expand `BrowserAdapter` authority for V5.

---

## 11. Run-local model context and ConversationStore

### 11.1 Ephemeral progress

Individual internal V5 action steps are **not** committed as separate user conversation turns.

Maintain an ephemeral run-local step history. Only a **final completed answer** becomes the durable `ConversationStore` turn for the original user request.

Trusted progress is generated from executor outcomes, not model self-report. The next model call receives:

```text
original user instruction
+ small bounded trusted step summary
+ current PageObservation-derived model context
```

Old full pages are discarded. Do not append every prior observation.

### 11.2 Progress content

The model may know:

```text
previous requested primitive kind
whether it succeeded
that the page changed
that an approved action completed
```

It must not be told it has acquired broader permission.

Forbidden:

```text
The user approved purchases for this task.
```

Required style:

```text
The previously presented action was approved and executed.
```

Approval is action-specific and already consumed.

Do not include in model progress:

```text
approvalId
executionId
backendNodeId
frameId
grants
raw audit records
page text from previous observations
```

Page text in the **current** observation remains untrusted data. It must never alter loop limits, approval rules, policy results, authority, cancellation, or task ownership. Trusted progress/state instructions must be clearly separated from untrusted page content (existing prompt-injection envelope).

### 11.3 Step-history bound

Maximum trusted progress summaries = last `N` completed steps with `N ≤ MAX_AGENT_LOOP_MODEL_STEPS` (8). Each summary is a short local string. No unbounded concatenation. Existing export policy, redaction, context budget, and screenshot policy apply to every model call. V5 must not add a growing raw-page transcript or a new remote-export path merely because multiple steps exist.

### 11.4 ConversationStore refactor (required before looping)

Current `InteractiveAgent` calls `conversations.commitTurn()` on non-approval results, including successful interactions with a synthetic `[interaction … succeeded]` answer. `ConversationStore` is also revision-bound: navigation clears history.

Phase 1/2 implementation **must** stop using that per-action commit inside the loop. Preferred split:

```text
InteractiveStepAgent    — no ConversationStore commit
AgentRunCoordinator     — commits one turn only when the run completes with a model answer
existing InteractiveAgent facade — preserves today’s single-step product behavior until Act mode is switched to the coordinator
```

Do not silently accumulate artificial user turns. Do not reuse `ConversationStore` as the loop’s progress log; revision changes would wipe it.

Prior same-revision Ask turns may still be supplied to the **first** loop generation the same way V3 does today. Intermediate loop steps use run-local progress instead of extra committed turns.

---

## 12. Approval pause, correlation, and resume

When a V5 step reaches `DEFER_EXECUTE` for a supported click and budgets remain:

```text
PreparedAction
→ approval presented
→ AgentRun running → awaiting-approval
```

While awaiting approval:

```text
no model call
no V3 action
no V4 execution
```

until a trusted human decision arrives. The model must not reason several steps ahead of an uncommitted effect.

### 12.1 Correlation (chosen)

Compare:

| Approach | Verdict |
|----------|---------|
| A. Local promise/deferred waiter keyed by `approvalId` | Necessary internally; not sufficient alone as the workflow contract |
| B. Event subscription on renderer-safe approval UI events | Rejected. UI events must not drive authority |
| C. Explicit coordinator method invoked by the approval workflow after a trusted outcome | Chosen public contract |

**Decision:** `ApprovalWorkflowController` (or the existing main compose point that already sees claim/execute/reject/expiry/stale) calls:

```text
AgentRunCoordinator.notifyApprovalOutcome(approvalId, trustedOutcome)
```

The coordinator maps `approvalId → runId` from trusted main state and resolves a **generation-checked deferred** for that run (approach A internally). No polling timers. No renderer-owned resume token.

Do **not** put `runId` into `ExecuteGrant`, `PreparedAction`, or `ApprovalDecision`. Task correlation stays outside frozen V4 authority records.

If the map has no live run, or the run is not `awaiting-approval`, or the generation does not match: ignore resume. V4 still finished according to V4 rules.

### 12.2 Each consequential action is a new approval

```text
approval of action A ≠ approval of action B
```

even in the same `AgentRun`. No “approve task,” “approve all,” remembered approval, or same-site blanket permission.

Two legitimate consequential clicks in one run require two independent V4 approvals, subject to `MAX_AGENT_LOOP_APPROVALS = 2`.

---

## 13. Approval and execution outcomes

| Trusted outcome | AgentRun |
|-----------------|----------|
| Approve → V4 `executed` | `awaiting-approval` → `running`; next iteration uses fresh trusted page state |
| User Reject | `blocked` (rejected). No replan around the rejection. User must issue a new instruction |
| Approval expires | `blocked` (expired). No automatic reprepare or new prompt |
| V4 result `stale` | `blocked` (stale). Do not prepare a semantically similar replacement. Exact-target approval meaning is preserved |
| V4 `failed` and `adapterPrimitiveInvoked = false` | `failed`. Grant already consumed. No new approval. No execution retry |
| `execution-attempted-state-unknown` | `execution-state-unknown` and **TERMINATE**. No further model calls, browser actions, or retry. UI must tell the user to inspect the page before acting again |

Reassert ADR-005: `ExecuteExecutor` is **never** automatically retried. `failed` / `stale` / `unknown` are not permission to issue another `ExecuteGrant` for the same action.

A future similar action would require a fresh observation, fresh model proposal, fresh policy, fresh `PreparedAction`, and fresh user approval. Initial V5 **terminates** instead of starting that replacement automatically.

---

## 14. V3 step outcomes

| Outcome | AgentRun |
|---------|----------|
| `InteractionResult.status = succeeded` | Continue (`running`) if budgets remain, run not cancelled, and result is not ambiguous. This is V5’s primary new behavior |
| Ordinary `DENY`, `TARGET_SENSITIVE`, `UNSUPPORTED_TARGET`, etc. | `blocked`. Do not ask the model to work around safety policy. Do not prompt “try to bypass the denial” |
| `DEFER_EXECUTE` native select (or any non-click deferred kind) | Remains denied. `blocked` as unsupported. Do not synthesize alternatives |
| Sensitive typing | Remains denied. No approval upgrade. `blocked` |
| Mechanical V3 `failed` | `failed`. No hidden primitive retry. Model-provider retry is not browser-action retry |
| Model `kind = answer` | `completed`. The answer is the final user-facing task result. No additional browser action |

---

## 15. Cancellation, supersede, and lifecycle

### 15.1 User Stop

Cancels the whole `AgentRun`.

Must:

```text
abort current model generation
prevent the next loop iteration
invalidate unresolved same-tab approval owned by the run
prevent a paused run from resuming later
```

Must not:

```text
undo already-dispatched browser input
turn unknown into failed
retry execution
```

Stop while `awaiting-approval`:

```text
AgentRun → cancelled
pending / approved-unclaimed PreparedAction → stale / invalidate
```

A later stale renderer Approve must fail safely (existing V4). No resume.

### 15.2 Cancel after dispatch

If Stop arrives after `adapterPrimitiveInvoked = true`:

```text
mark cancellation requested
do not start future steps
let V4 (or V3) reach executed / unknown
terminate the old run afterwards
```

Do not claim the browser action was cancelled. If the result is unknown, the run’s terminal state is `execution-state-unknown`, not a lie that nothing happened.

### 15.3 Same-tab new task

Order in §3. Do not let both runs reason or act concurrently on one tab.

Preferred product rule: one same-tab run at a time; a new **explicit** Act submit supersedes. Phase 5 UI must avoid accidental supersede via Enter while the V4 approval card has focus.

### 15.4 Approve vs supersede race

One winner, fail-safe:

- If the approval has **not** claimed yet and the run is superseded → invalidate/stale; **no** execution; old run does not resume.
- If `ExecuteGrant` is claimed and dispatch has **not** started → existing V4 invalidation may stale; old run does not resume.
- If input dispatch **has** started → cannot cancel the external effect. V4 finishes as `executed` or `unknown`. The **old** `AgentRun` must not resume further steps (already cancelled/superseded).

### 15.5 Tab close

```text
cancel AgentRun
invalidate approval
abort model call
clear ephemeral run state
```

No persistence. No resume.

### 15.6 Renderer crash

```text
terminate/cancel the run for that tab
invalidate approval
```

Do not recover an autonomous run against the replacement renderer. The user may issue a new task after recovery.

### 15.7 Process restart / app close

Runs are gone. No background continuation. No further model calls.

---

## 16. Generation tokens and late results

Reuse the existing per-tab generation pattern. `AgentRunCoordinator` owns a run generation (or `runId` plus monotonic generation) for each tab.

Every model result and every approval-resume signal must still belong to the **current** run. A late completion from an old model call or old waiter is ignored.

Do not trust promise timing alone.

---

## 17. Concurrency inside one run

```text
one model call
then at most one action
then the next model call
```

No parallel proposals. No `Promise.all` of browser mutations. No speculative clicks. Approval does not run in parallel with model reasoning.

No child `AgentRun`s. No spawn/delegate/hidden/parallel subtask.

V5 applies only to explicit **interact / Act** tasks. Ask / read mode remains current single-shot `ReadOnlyAgent` behavior.

Every run originates from one explicit user instruction. The model may decompose that instruction into steps. It may not invent an unrelated task after completion. Final answer ends the run.

If the application is closed, the tab is closed, the run is cancelled, or the run is terminal: no continued model calls. Foreground orchestration only.

---

## 18. Renderer-safe events and UI

High-level events (names may match existing AI event style):

```text
agent-run-started
agent-run-progress
agent-run-awaiting-approval
agent-run-completed
agent-run-cancelled
agent-run-blocked
agent-run-failed
agent-run-execution-state-unknown
```

Do not expose:

```text
targetId
observationId
documentRevision
backendNodeId
frameId
InteractionGrant
ExecuteGrant
approval internals
```

`runId` **may** be renderer-visible as correlation (like `askId`). It never grants browser authority. The renderer cannot choose the next target, inject a proposal, mint a grant, or execute an action.

Reuse the **existing V4 approval card**. V5 must not create a second approval mechanism. The run may show “Waiting for your approval.” The decision remains:

```text
approvalId + approve|reject
```

through existing trusted approval IPC.

While awaiting approval: Stop remains available; Approve/Reject remain explicit; automatic next model step is forbidden.

Final UI:

- `completed` — show the model’s final answer.
- `blocked` — safe reason (not allowed; expired; page changed; step limit; no progress; rejected).
- `execution-state-unknown` — the last approved action **may** have occurred; the task was stopped to avoid repeating it. **No** automatic Retry CTA for unknown.

---

## 19. Audit

V5 introduces a **separate observational AgentRun audit**, not an overload of V3 interaction or V4 approval events.

Possible metadata:

```text
runId
tabId
event
modelStepCount
actionAttemptCount
approvalCount
timestamp
terminalReason
```

No page text. No user prompt required (avoid durable content persistence). No target/backend handles required.

Audit failure must never grant authority, retry browser actions, or make an EXECUTE reusable. Run progression must not depend on audit-sink availability.

---

## 20. One-step agent extraction

Preferred architecture:

```text
extract / refactor one-step reasoning
without changing V3/V4 schema or authority
```

Then the V5 loop repeatedly invokes that primitive.

Keep `ReadOnlyAgent` unchanged.

Do not use today’s `InteractiveAgent.interact()` as the loop body: it would abort itself via generation, commit fake conversation turns, and fight tab-level cancellation.

---

## 21. Explicit answers (architecture questions)

| Question | Answer |
|----------|--------|
| What owns AgentRun state? | Trusted-main `AgentRunCoordinator`. In-memory only |
| How many active runs per tab? | At most one |
| Exact hard budgets? | 8 model steps, 6 action attempts, 2 approvals |
| What counts as a model step? | One logical generation that yields valid answer or proposal; provider fallback is inside it |
| What counts as an action attempt? | Entering V3 `InteractionExecutor` or V4 `ExecuteExecutor` |
| What counts as an approval step? | Presenting a new V4 approval for the run |
| How does the model get run progress? | Original instruction + bounded trusted summaries + current exported page context |
| How is ConversationStore used? | Not for internal steps. One durable turn on completed answer. Refactor before looping |
| How does approval pause the run? | State `awaiting-approval`; no model/V3/V4 until a trusted decision |
| How does workflow resume the right run? | `approvalId → runId` plus generation-checked deferred; workflow calls `notifyApprovalOutcome` |
| Reject? | Blocked; no circumvention replan |
| Expiry? | Blocked; no reprepare |
| V4 stale? | Blocked; no retarget |
| V4 failed pre-dispatch? | Failed; grant consumed; no retry |
| V4 unknown? | `execution-state-unknown`; terminate; no retry |
| V3 DENY? | Blocked; no workaround loop |
| Safe V3 mechanical failure? | Failed; no primitive retry |
| Stop? | Cancel run; abort model; invalidate approval; no undo of dispatch |
| Same-tab supersede? | Cancel old, then start new, per §3 |
| Tab close? | Cancel, invalidate, abort, clear |
| Renderer crash? | Cancel/terminate; invalidate; no autonomous recovery |
| User/manual chrome navigation? | Cancel the run |
| Agent action navigates? | Continue after trusted fresh observation |
| Late async model results? | Rejected unless current run generation matches |
| Duplicate proposals? | Exact fingerprint no-progress stop |
| Loop limits? | Local constants; checked before authority creation |
| Two approvals in one run? | Yes, max 2, each independent |
| Each requires a new explicit approval? | Yes |
| Can an approved action be retried? | No |
| Can the loop continue after unknown? | No |
| Can the renderer influence the next target? | No |
| Can the model influence budgets or authority? | No |

---

## 22. Explicit non-goals (V5)

```text
background / scheduled agents
persistent workflows / resume-after-restart
parallel actions or multi-agent delegation
always-approve / approval memory / approve-all
model schema expansion or tool-calling browser execution
putting runId into ExecuteGrant
automatic EXECUTE retry
automatic reprepare after reject / expiry / stale
converting DENY into approval
Ask/read-mode actions
password / card / OTP filling
native select EXECUTE
expanding BrowserAdapter for the loop
```

---

## 23. Security invariants

```text
[ ] Model cannot raise loop budgets
[ ] Model cannot self-approve or emit approval/execute/run authority fields
[ ] Model cannot mint InteractionGrant or ExecuteGrant
[ ] Model cannot resume a cancelled run
[ ] Renderer cannot execute an action or inject target/proposal
[ ] runId is correlation only, never authority
[ ] Approval remains exact-action-specific
[ ] DENY cannot become approval
[ ] No automatic EXECUTE retry
[ ] unknown terminates the loop
[ ] No parallel browser actions
[ ] No stale target reuse across steps
[ ] Page content cannot alter limits, policy, or cancellation
[ ] No persistence / background continuation
[ ] V3 and V4 authority records unchanged
```

## Consequences

- Act mode becomes a bounded foreground `AgentRun` once implemented. A one-step task is simply a short run.
- V3 `InteractiveAgent` becomes (or yields) a one-step primitive. Product looping waits on that extraction plus ConversationStore commit changes.
- V4 workflow gains a coordinator notification hook. Grant types stay frozen.
- Users get multi-step safe tasks and per-action consequential approvals without a second browser-control stack.

V5 architecture is locked by this ADR. Implementation is specified in `docs/plans/V5-agent-loop.md` and is **not** started by accepting this ADR.
