# Plan: V5 — Bounded agent loop

**Status:** complete  
**Implementation:** complete (Phases 1–6)  
**Explicit reference:** Implementation tasks must cite `docs/plans/V5-agent-loop.md` to treat this file as authoritative.

Authoritative architecture:

```text
docs/architecture/ADR-006-agent-loop-orchestration.md
docs/architecture/ADR-005-approval-execute-authority.md
docs/architecture/ADR-004-interaction-authority.md
docs/architecture/ADR-003-model-runtime-routing.md
docs/architecture/browser-architecture.md
docs/plans/V4-prepare-approval-execute.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
```

```text
V5 bounded agent loop — COMPLETE
Phases 1–6 implemented and accepted
```

V0 (shell), V1 (observation), V2 (read-only agent), V3 (permissioned INTERACT), and V4 (PREPARE / APPROVAL / EXECUTE) are **complete and frozen**. V5 must not reopen already-green V3/V4 authority.

This plan implements ADR-006. It does not start V6 autonomous tasks or V7 persistent workflows.

---

## Objective

Deliver a **bounded multi-step observe → reason → safe interact / approved execute** loop for **one explicit user Act task**:

```text
one foreground AgentRun per tab
→ sequential one-step decisions
→ V3 InteractionGrant path for safe actions
→ V4 PreparedAction + explicit approval + ExecuteGrant for consequential clicks
→ fresh observation after each mutation
→ final model answer completes the run
```

```text
The agent loop owns task progression, not browser authority.
```

V5 orchestrates existing V3 and V4. It does not replace them, mint grants, approve actions, or call `BrowserAdapter` from the loop.

## Out of scope

Do not implement in V5:

```text
background / scheduled agents
persistent workflows / resume-after-restart
parallel browser actions
multi-agent delegation
always-approve / approval memory / approve-all
model schema expansion
provider tool-calling as the browser-control path
putting runId into ExecuteGrant / PreparedAction / ApprovalDecision
automatic EXECUTE retry
automatic reprepare after reject / expiry / stale
converting DENY into approval
Ask/read-mode actions
password / card / OTP filling
native select EXECUTE
new BrowserAdapter primitives for the loop
V6 autonomous tasks
V7 persistent workflows
```

Do not mark V5 complete in this architecture-only task. No phase in this file is complete until an implementation task finishes it.

## Model policy

```yaml
model:
  default: composer-2.5
  escalation_allowed: true
  escalation_model: grok-4.6
  escalation_reason: |
    Use Grok 4.6 only for:
    - AgentRun state machine authority
    - pause/resume concurrency
    - approval-vs-supersede races
    - cancel-after-dispatch semantics
    - major architecture correction
    Do not escalate because a test failed, a command failed, or more
    confidence would be convenient.
```

Composer 2.5 is the default implementation model for every phase.

## Subagents

```yaml
subagents:
  allowed: false
```

No subagents by default. Ordinary mapping, implementation, debugging, and verification stay in the executing agent.

## Verification

```yaml
verification:
  mode: targeted
```

Each phase: **targeted tests only** until V5 closure.

Do not run every legacy suite after every small phase.

Full:

```text
V2 acceptance
V3 acceptance
V4 acceptance
V5 acceptance
```

only at V5 closure, or after a change that genuinely affects shared V2/V3/V4 authority primitives.

No live / paid model calls. Acceptance uses recording / fake model runtime only.

## Permissions

Implementation phases grant permissions in their own prompts. This locked plan does **not** by itself authorize commit, push, CI, or deploy for production code.

Architecture-lock task (this document’s creation) is docs-only.

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

## Locked constants

```text
MAX_AGENT_LOOP_MODEL_STEPS = 8
MAX_AGENT_LOOP_ACTION_ATTEMPTS = 6
MAX_AGENT_LOOP_APPROVALS = 2
```

Counting, exhaustion, and no-progress fingerprint are specified in ADR-006 §§6–7. Implementation must not expose these as model- or renderer-writable settings.

---

## Product behavior (once implemented)

Act / interact mode starts one `AgentRun` for the explicit user instruction.

Ask / read mode remains `ReadOnlyAgent` (single-shot, no actions).

Conceptual safe task:

```text
User: "Open account settings and enable dark mode"

observe → model proposes safe navigation/click → V3 executes → fresh observation
→ model proposes another safe interaction → V3 executes → fresh observation
→ model produces final answer → completed
```

Conceptual consequential task:

```text
User: "Book this appointment"

observe → safe navigation → observe → safe interaction → observe
→ consequential click → V4 PreparedAction → explicit approval
→ V4 ExecuteGrant → exact execution → fresh observation
→ loop resumes → final answer
```

A one-step Act request is a short run, not a separate product path.

---

## Chapters / phases

| Phase | Scope | Verification | Status |
|-------|-------|--------------|--------|
| 1 | AgentRun types, state machine, budgets, idempotency; no model/browser integration | targeted unit tests | complete (`caafb84`) |
| 2 | One-step agent refactor + ephemeral run progress context; preserve existing single-step behavior | targeted agent/conversation tests | complete (`baf0a0d`) |
| 3 | AgentRunCoordinator safe V3 multi-step loop (safe actions only) | targeted coordinator tests | complete (`fc8f4ad`) |
| 4 | Approval pause/resume correlation; successful V4 EXECUTE resumes; reject/stale/failed/unknown terminate | targeted approval-loop tests | complete (`44cb0e5`) |
| 5 | Main controller + cancellation/supersede/lifecycle; renderer run progress UI | targeted main + UI tests | complete (`5a53674`) |
| 6 | Deterministic fixtures + Electron V5 acceptance + closure | V2/V3/V4/V5 acceptance | complete (see Closure evidence) |

Each phase must remain independently reviewable. Do not collapse later phases into earlier ones.

---

## Phase 1 — AgentRun core (no model, no browser)

Deliver trusted-main types and a coordinator core that can be unit-tested without `ModelRuntime` or `BrowserAdapter`.

Include:

- `AgentRun` / `AgentRunId` / terminal and non-terminal states
- hard budget constants and increment rules
- budget checks **before** hypothetical authority creation
- no-progress fingerprint helper
- generation / late-result rejection
- `approvalId → runId` map (empty until Phase 4)
- in-memory only; clear on tab close API
- observational audit record shape (no page text)

Do **not** wire InteractiveAgent, approval workflow, IPC, or UI.

**Targeted verification:** state-machine transitions, budget exhaustion (`STEP_LIMIT_REACHED`), no-progress, generation mismatch ignores late resume, no transition out of terminal states.

---

## Phase 2 — One-step primitive + conversation split

Extract one-step reasoning from `InteractiveAgent` **without** changing V3/V4 schema or authority.

Required current-contract fix before any loop:

```text
InteractiveAgent currently commitTurn()s non-approval results,
including synthetic “[interaction … succeeded]” answers.
Looping that would invent user turns and collide with
revision-bound ConversationStore (cleared on navigation).
```

Deliver:

- `InteractiveStepAgent` (name may differ): one observe/model/bind/policy/(optional V3 execute or V4 prepare) decision
- no per-call tab generation bump that would abort a parent run
- no ConversationStore commit inside the step primitive
- ephemeral trusted progress summary builder (bounded, no grants/IDs/page-history dump)
- existing `InteractiveAgent.interact()` facade still preserves today’s **single-step** product behavior and tests until Phase 5 switches Act mode to the coordinator
- `ReadOnlyAgent` unchanged

Reuse a proven executor post-observation only under ADR-006 §9. Otherwise `observePage()`.

**Targeted verification:** existing V3 interact unit tests remain green via the facade; step primitive does not commit intermediate turns; progress summaries omit forbidden fields; provider fallback still counts as one logical generation.

---

## Phase 3 — Safe V3 multi-step loop

`AgentRunCoordinator` drives sequential steps for **safe** `ALLOW_INTERACT` / `ALLOW_NAVIGATE` only.

Include:

- fresh observation / reuse rule
- continue after V3 `succeeded`
- stop on V3 DENY / TARGET_SENSITIVE / unsupported / mechanical failure
- stop on `DEFER_EXECUTE` in this phase **or** hand a prepare-ready result without presenting approval yet (Phase 4 owns pause/resume). Prefer failing closed: if the step returns DEFER_EXECUTE, terminate as blocked/unsupported until Phase 4.
- model answer → `completed`
- model-step and action-attempt budgets
- no-progress guard
- one action at a time
- agent-caused navigation continues after executor observation
- do not treat executor-caused navigation as cancellation

**Targeted verification:** two sequential safe actions then answer; navigation then safe action; DENY terminates; sensitive type terminates; repeated identical proposal terminates; step/action limits; invalid model output fails the run without a browser action.

---

## Phase 4 — V4 pause / resume

Wire existing approval workflow without changing grant schemas.

Include:

- prepare only when action **and** approval budgets remain
- present approval → `awaiting-approval`
- workflow calls `notifyApprovalOutcome(approvalId, trustedOutcome)`
- Approve + `executed` → `running` with trusted fresh observation
- Reject / expiry / stale → `blocked`
- pre-dispatch failed → `failed`
- unknown → `execution-state-unknown` and terminate
- second independent consequential click requires a second approval
- approval budget exhaustion stops **before** another `PreparedAction`
- no automatic EXECUTE retry
- no `runId` on `ExecuteGrant`

**Targeted verification:** resume after executed; two separate approvals; reject/expiry/stale/failed/unknown; DENY still cannot become approval; deferred select still cannot become approval; superseded waiter does not resume.

Grok 4.6 is authorized for this phase’s pause/resume and approval-vs-supersede race design if needed. Composer 2.5 remains default for routine wiring.

---

## Phase 5 — Product integration

Main + renderer:

- Act submit creates an `AgentRun` via coordinator (not a raw loop inside `AiRequestController`)
- renderer-safe run events from ADR-006 §18
- reuse V4 approval card; no second approval UI
- Stop cancels the whole run, including `awaiting-approval`
- same-tab new explicit Act submit supersedes (order in ADR-006 §3)
- prevent accidental Enter-supersede while the approval card has focus
- trusted chrome navigation cancels the run (in addition to existing approval invalidation)
- tab close / renderer crash cancel and clear
- late old-run model results ignored
- approve vs new-task race per ADR-006 §15.4
- cancel after dispatch: no further steps; do not lie about cancellation
- different tabs independent
- final answer UI; blocked reasons; unknown copy with **no** Retry CTA
- Ask mode unchanged

`runId` may be included on events as correlation only.

**Targeted verification:** controller/lifecycle unit tests for cancel, supersede, tab close, crash, chrome navigation, late results; UI state tests for progress/waiting/terminal copy.

---

## Phase 6 — Acceptance and closure

Add dedicated:

```text
src/v5-acceptance/
test:v5-acceptance
```

Do **not** change existing V2/V3/V4 acceptance suites except if a genuine shared-primitive bug is found — in that case stop and report; do not silently weaken frozen gates.

Recording / fake model runtime only. No paid model calls.

### Minimum acceptance scenarios

```text
two safe sequential actions → final answer

safe navigation → new page → safe action → final answer

safe action → consequential action
→ approval → execute
→ loop resumes → final answer

two separate consequential actions
→ two separate approvals

Reject → run stops

approval expiry → run stops

EXECUTE stale → run stops

EXECUTE failed pre-dispatch → run stops

EXECUTE unknown → run stops permanently

V3 DENY → run stops

sensitive typing → no approval, run blocked

deferred select → no approval, run blocked

repeated identical proposal → no-progress stop

model-step limit
action limit
approval limit

user Stop during model generation

user Stop while awaiting approval

same-tab new task supersedes old run

late model result from old run ignored

approve vs supersede race

cancel after dispatch
→ no further steps, execution reaches safe terminal state

different-tab independent runs
```

### Security acceptance (must prove)

```text
model cannot raise loop budget
model cannot self-approve
model cannot create grants
model cannot resume a cancelled run
renderer cannot execute an action
renderer cannot inject target/proposal
runId does not grant browser authority
approval remains exact-action-specific
DENY cannot become approval
no automatic EXECUTE retry
unknown terminates loop
no parallel browser actions
no stale target reuse across steps
```

### Closure gates

```text
npm run typecheck
targeted V5 unit tests added in phases 1–5
npm run test:v2-acceptance
npm run test:v3-acceptance
npm run test:v4-acceptance
npm run test:v5-acceptance
```

Do not reopen V4 authority to make V5 green.

---

## Implementation notes (binding, not optional)

1. **Do not invent a parallel browser-control stack.** Bind, policy, grants, executors, and adapter stay where V3/V4 put them.
2. **Check budgets before PreparedAction / InteractionGrant paths** so the UI never shows an approval that cannot execute.
3. **Reuse executor observation** only when it is the trusted post-action observation and nothing invalidated it.
4. **ConversationStore** is not the loop log. Refactor before looping.
5. **Agent-caused navigation continues; trusted chrome navigation cancels.**
6. **Unknown is terminal.** No retry, no automatic replacement action.
7. **Audit is observational** and must not gate authority.
8. **No production code in the architecture-lock task** that created this plan.

---

## Completion criteria

V5 is complete only when Phase 6 closure gates are green and this plan’s status is updated to `complete` by a later implementation task.

---

## Closure evidence

**Phase 1–5 implementation commits**

```text
caafb84 Implement V5 AgentRun state core
baf0a0d Extract V5 interactive step primitive
fc8f4ad Implement V5 safe multi-step agent loop
44cb0e5 Implement V5 approval-aware agent pause and resume
5a53674 Wire V5 bounded agent runs into product
```

**Phase 6 acceptance** — `dad7e76` (`Add V5 bounded agent loop acceptance`; see `docs/acceptance/V5-acceptance.md`).

**Closure matrix (all PASS on acceptance candidate, `AI_GATEWAY_API_KEY` unset):**

```text
npm run typecheck
npm run test:ai                            (220 tests)
npm run test:observation                   (40 tests)
npm run test:fixture                       (7 tests)
npm run test:v2-acceptance                 (29 tests + [v2-electron-observation] PASS)
npm run test:v3-acceptance                 (29 tests + [v3-electron-interaction] PASS)
npm run test:v4-acceptance                 (46 tests + [v4-electron-approval] PASS)
npm run test:v5-acceptance                 (31 tests + [v5-electron-agent-loop] PASS)
```

**No-live confirmation:** `AiSdkGatewayRuntime` not used by V5 acceptance; `test:v2-catalog-live` and `smoke:v2-gateway` not run.

V6 autonomous tasks and V7 persistent workflows were not started.

No implementation phase in this file is complete.
