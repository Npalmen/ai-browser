# Plan: V3 — Permissioned INTERACT foundation

**Status:** draft  
**Explicit reference:** Implementation tasks must cite `docs/plans/V3-interact-foundation.md` to treat this file as authoritative.

Authoritative architecture:

```text
docs/architecture/browser-architecture.md
docs/architecture/ADR-001-browser-runtime.md
docs/architecture/ADR-002-page-observation.md
docs/architecture/ADR-003-model-runtime-routing.md
docs/architecture/ADR-004-interaction-authority.md
docs/plans/V0-browser-shell.md
docs/plans/V1-page-observation.md
docs/plans/V2-model-runtime-readonly-agent.md
AGENTS.md
.cursor/rules/execution.mdc
.cursor/rules/browser-agent-safety.mdc
```

V0 (shell), V1 (observation), and V2 (read-only agent) are **complete**. V2 remains the default safe path and must not be regressed.

---

## Objective

Deliver **one model-proposed safe browser interaction per user request**:

```text
User request (interaction mode)
→ fresh observePage
→ model structured output (answer OR single InteractionProposal)
→ proposal validation
→ semantic policy (INTERACT or NAVIGATE for scroll)
→ grant
→ executor → BrowserAdapter primitive
→ fresh observePage
→ InteractionResult to trusted app UI
```

Supported primitives:

| Primitive | Authority level |
|-----------|-----------------|
| `click` | INTERACT |
| `type` | INTERACT |
| `select` (native `<select>`) | INTERACT |
| `scroll` | NAVIGATE |

**Milestone boundary (locked):** includes full single-step loop above. **Excludes** autonomous multi-step observe→act loops, PREPARE_ACTION, APPROVAL, and EXECUTE.

---

## Out of scope

Do not implement in V3:

```text
PREPARE_ACTION, APPROVAL, EXECUTE
purchase / send / submit consequential forms / publish / book / delete / pay / transfer
autonomous agent loops (multiple actions per request)
AI SDK tool-calling as the proposal mechanism
window.aiAssistant.click/type/select/scroll IPC
website preload action hooks
executeJavaScript / Runtime.evaluate / generic CDP API
credential vault / OS keychain
fuzzy retargeting / selector fallback
custom combobox one-shot select (multi-step deferred)
model-driven typing into sensitive fields
production audit persistence
paid model calls in deterministic acceptance tests
live internet sites in acceptance harness
```

---

## Locked architecture (ADR-004 summary)

| Topic | Decision |
|-------|----------|
| Authority boundary | Model → validator → policy → grant → executor → `BrowserAdapter` |
| Proposal mechanism | Structured output union (`answer` \| `interaction`); not tool-calling |
| Target identity | `tabId` + `observationId` + `documentRevision` + `targetId`; internal `backendNodeId`/`frameId` |
| Stale targets | Fail closed; no retargeting |
| Policy | Conservative metadata classifier; uncertain → deny |
| Sensitive fields | Deny all model-driven typing |
| Scroll | NAVIGATE authority |
| Post-action | Mandatory fresh `observePage` after successful mutation |
| Agent | New `InteractiveAgent`; `ReadOnlyAgent` unchanged |
| Audit | In-memory metadata-only sink |

---

## Execution controls

```yaml
execution:
  model: composer-2.5
  stronger_model_allowed: false
  subagents: false

verification:
  mode: targeted

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
  deployment_verification: false
  live_effects: false
```

Each implementation prompt must grant `commit` / `push` explicitly. Composer 2.5 is the default implementation model. Do not use subagents. Do not watch CI. Do not make paid model calls in deterministic tests.

Optional live gateway smoke stays in `src/v3-live/` (or reuse `src/v2-live/` pattern) — separate npm script, `SKIPPED_NO_KEY` without API key.

---

## Phase overview

| Phase | Scope | Stop condition |
|-------|-------|----------------|
| 1 | Shared interaction types, errors, validator skeleton | Types compile; validator unit tests pass |
| 2 | Target resolution, interaction CDP client, `BrowserAdapter` primitives | Executor unit tests + adapter tests with fixtures |
| 3 | Policy classifier, grants, audit sink | Policy adversarial tests pass |
| 4 | `InteractiveAgent` + structured model output | Agent unit tests with recording runtime |
| 5 | Main controller, IPC events, minimal UI | Integration tests; manual smoke |
| 6 | Fixtures, acceptance harness, milestone closure | `test:v3-acceptance` green; plan → complete |

---

## Phase 1 — Shared types, errors, validator

### Scope

- Add `src/shared/interaction-types.ts` — proposals, grants, results, authority levels, bounds constants.
- Add `src/shared/interaction-errors.ts` — `InteractionErrorCode`, `InteractionError` class.
- Add `src/interaction/proposal-validator.ts` — schema validation, identity field presence, text/scroll bounds.
- Add `src/interaction/action-level.ts` — map primitive → `INTERACT` | `NAVIGATE`.

### Files likely touched

```text
src/shared/interaction-types.ts          (new)
src/shared/interaction-errors.ts         (new)
src/interaction/proposal-validator.ts    (new)
src/interaction/action-level.ts          (new)
src/interaction/proposal-validator.test.ts (new)
```

### Tests

- Valid/invalid proposals per kind.
- Missing `observationId` / `documentRevision` rejected.
- Text length over max rejected.
- Scroll amount over max rejected.

### Non-goals

- No CDP, no adapter methods, no policy rules, no model calls.

### Stop condition

`npm run typecheck` and targeted tests for validator pass.

### Model

Composer 2.5.

---

## Phase 2 — Target resolution, CDP client, BrowserAdapter primitives

### Scope

- Add `src/interaction/target-resolver.ts` — wraps `TargetRegistry` + observation node lookup + revision preflight interface.
- Add `src/observation/interaction-cdp-client.ts` — closed V3 allowlist per ADR-004 §12.
- Add `src/browser/interaction-primitives.ts` — internal click/type/select/scroll implementation used by adapter.
- Extend `src/browser/browser-adapter.ts` + `src/browser/electron-adapter.ts` with four primitive methods (executor-only callers).
- Extend `TargetRegistry` if needed (e.g. `getCurrentDocumentRevision` helper on tab) — minimal additive API only.

### Files likely touched

```text
src/interaction/target-resolver.ts
src/interaction/target-resolver.test.ts
src/observation/interaction-cdp-client.ts
src/browser/interaction-primitives.ts
src/browser/browser-adapter.ts
src/browser/electron-adapter.ts
src/browser/interaction-primitives.test.ts
```

### Tests

- Resolver: happy path, stale `observationId`, missing target, cross-tab rejection.
- CDP client: allowlist rejects unknown methods (mock debugger).
- Primitives: mock CDP; verify center-click coordinates, `insertText` sequence, bounded scroll delta.

### Non-goals

- No policy classifier, no agent, no IPC.

### Stop condition

Adapter primitive unit tests pass; resolver tests pass; typecheck clean.

### Model

Composer 2.5.

---

## Phase 3 — Policy, grants, audit, executor

### Scope

- Add `src/interaction/interaction-policy.ts` — conservative classifier using `ObservationNode` metadata.
- Add `src/interaction/interaction-grant.ts` — immutable grant record tied to `actionId`.
- Add `src/interaction/interaction-audit.ts` — in-memory sink + `AuditEvent` types.
- Add `src/interaction/interaction-executor.ts` — orchestrates resolve → policy → grant → adapter → re-observe.
- Wire executor to `BrowserAdapter.observePage` for post-action observation.

### Files likely touched

```text
src/interaction/interaction-policy.ts
src/interaction/interaction-policy.test.ts
src/interaction/interaction-grant.ts
src/interaction/interaction-audit.ts
src/interaction/interaction-audit.test.ts
src/interaction/interaction-executor.ts
src/interaction/interaction-executor.test.ts
```

### Tests

**Policy denial (adversarial):**

```text
submit / Buy now / Delete / Send / Pay
password / secret / cc-number fields (type)
malicious injection strings in node name (still deny consequential controls)
```

**Policy allow:**

```text
expand/collapse, benign button, non-sensitive textbox, native select metadata
```

**Executor:**

```text
denied proposal never calls adapter
granted click calls adapter once
successful action triggers re-observe
stale target fails before adapter
```

### Non-goals

- No model integration, no UI.

### Stop condition

Policy + executor unit tests pass; audit asserts no secret payloads.

### Model

Composer 2.5.

---

## Phase 4 — Interactive agent + model output schema

### Scope

- Add `src/ai/interactive-agent.ts` — composes observation, export policy, context builder, `ModelRuntime`, executor.
- Add `src/ai/interaction-output-schema.ts` — Zod/JSON schema for `answer | interaction` union (match existing V2 schema style).
- Extend `src/ai/system-prompt.ts` (or add interaction prompt module) — instruct model about proposals, stale targets, denied actions; reinforce prompt-injection envelope.
- Recording/fixture model runtime for tests (extend `src/v2-acceptance/recording-model-runtime.ts` pattern).

### Files likely touched

```text
src/ai/interactive-agent.ts
src/ai/interactive-agent.test.ts
src/ai/interaction-output-schema.ts
src/ai/interaction-output-schema.test.ts
src/ai/system-prompt.ts
src/v3-acceptance/recording-interaction-runtime.ts (new, optional location)
```

### Behavior

- One proposal per request; if model returns `answer`, no execution (same as V2-style response).
- If model returns `interaction`, run validator → executor once.
- Tab lock / cancel semantics aligned with `ReadOnlyAgent`.
- `ReadOnlyAgent` file remains unchanged.

### Tests

- Recording runtime returns proposal → executor invoked (mock).
- Model returns answer → executor not invoked.
- Invalid model output → safe error, no adapter call.
- Cancel mid-flight → `REQUEST_CANCELLED`.

### Non-goals

- No IPC/UI changes yet.

### Stop condition

Interactive agent unit tests pass with recording runtime.

### Model

Composer 2.5.

---

## Phase 5 — Main controller, IPC, minimal UI

### Scope

- Extend `src/main/ai-runtime.ts` to construct `InteractiveAgent` + executor dependencies.
- Extend `src/main/ai-request-controller.ts` (or add `AiInteractionController`) with explicit interaction mode — **no silent upgrade from read-only ask**.
- Extend `src/shared/ai-types.ts` + `src/shared/ipc-contract.ts` + `src/main/ipc.ts` + `src/main/ipc-security.ts` for:
  - interaction mode flag on ask (or separate channel)
  - events: `interaction-started`, `interaction-denied`, `interaction-completed`, `interaction-failed`
  - **no** raw primitive exposure on preload
- Minimal `src/app-ui/` updates: show interaction outcome, re-use Stop/cancel.

### Files likely touched

```text
src/main/ai-runtime.ts
src/main/ai-request-controller.ts
src/main/ipc.ts
src/main/ipc-security.ts
src/shared/ai-types.ts
src/shared/ipc-contract.ts
src/preload/app-preload.ts
src/app-ui/AiSidePanel.tsx
src/app-ui/ai-ui-state.ts
src/v2-acceptance/ipc-input.test.ts (extend or parallel v3 IPC tests)
```

### Tests

- IPC allowlist: no new website-exposed channels.
- Renderer cannot invoke primitives.
- Interaction events shape snapshots.

### Non-goals

- No approval UI, no action history persistence, no polish beyond showing result status.

### Stop condition

Targeted IPC security tests pass; manual smoke: one safe fixture interaction end-to-end.

### Model

Composer 2.5.

---

## Phase 6 — Fixtures, acceptance harness, closure

### Scope

- Add `fixtures/interaction/` HTML fixtures:
  - `safe-interact.html` — expand button, text field, native select
  - `policy-deny.html` — Buy now, Submit, Delete, Send
  - `sensitive-fields.html` — password, cc autocomplete
  - `stale-target.html` — controls to invalidate observation between steps (harness-driven)
  - `prompt-injection.html` — malicious instructions in page text
- Extend `scripts/observation-fixture-routes.ts` for interaction routes.
- Add `src/v3-acceptance/`:
  - `chain-acceptance.test.ts` — proposal → policy → executor → observe
  - `policy-adversarial.test.ts`
  - `stale-target.test.ts`
  - `security-gates.test.ts` — no CDP/JS/preload leaks
  - `electron-interaction-harness.ts` — reuse bundle pattern from V2
- Add `scripts/run-v3-electron-interaction.cjs`, `npm run test:v3-acceptance`.
- Optional `src/v3-live/interaction-gateway-smoke.ts` — skipped without key.

### Files likely touched

```text
fixtures/interaction/*.html
scripts/observation-fixture-routes.ts
scripts/observation-fixture-routes.test.ts
src/v3-acceptance/*
scripts/run-v3-electron-interaction.cjs
package.json (scripts only)
docs/plans/V3-interact-foundation.md (status → complete)
```

### Required acceptance categories

| Category | Examples |
|----------|----------|
| Positive INTERACT | expand, type non-sensitive, native select, bounded scroll |
| Stale target | superseded observation, revision change, navigation, cross-tab, removed node |
| Policy denial | submit, buy, delete, send, payment, sensitive type, injection page |
| Execution | grant before adapter; fresh observation after success |
| Security | no WebContents to renderer; no executeJavaScript; no website IPC; audit has no secrets |

### Non-goals

- Live website tests, paid model calls in CI script.

### Stop condition

```text
npm run typecheck
npm run test:ai          (existing — no regressions)
npm run test:v2-acceptance
npm run test:v3-acceptance
```

Plan status → `complete` with closure evidence in this file.

### Model

Composer 2.5 for harness/fixtures. **Grok 4.6 not required** for any V3 phase — interaction authority is deterministic; model only proposes within schema and is tested via recording runtime.

---

## Testing strategy summary

```text
Unit:        validator, policy, resolver, executor, agent (recording runtime)
Integration: main controller + IPC security
Electron:    localhost fixtures only via bundled harness
Live:        optional separate script; SKIPPED_NO_KEY default
```

Reuse V2 patterns:

- `scripts/bundle-and-run-electron.cjs`
- `src/v2-acceptance/electron-observation-harness.ts` as template
- `fixtures/observation/` route server

Do not add dependencies unless a phase truly requires it (none anticipated).

---

## Security gates (must pass before closure)

```text
[ ] Model cannot import BrowserAdapter interaction methods
[ ] Website preload unchanged (no action IPC)
[ ] ipc-security allowlist has no interaction primitives for websites
[ ] Interaction CDP allowlist is closed
[ ] No Runtime.evaluate / executeJavaScript path
[ ] Audit sink contains no secrets or full page text
[ ] ReadOnlyAgent tests still pass unchanged
[ ] V2 acceptance still passes
```

---

## Future milestone (V4+) — explicit handoff

Next milestone owns:

```text
PREPARE_ACTION — stage consequential action without executing
APPROVAL — human confirmation boundary
EXECUTE — granted external side effects
audit persistence
richer classifier with prepare/approve workflow
multi-step autonomous loops (separate plan)
```

V3 denial examples that become V4 candidates:

```text
click "Confirm order"
click "Send"
submit login with external session effect
type payment card number (even if user-approved later)
```

Document `DEFER_EXECUTE` policy outcome in V3 for clean V4 wiring.

---

## Completion criteria

V3 is complete when:

1. ADR-004 is implemented (not just written).
2. User can trigger **one** interaction-mode request that may produce a single safe `click`, `type`, `select`, or `scroll`.
3. Consequential controls are denied fail-closed.
4. Successful actions return fresh `PageObservation`.
5. `ReadOnlyAgent` path unchanged and regression-tested.
6. `test:v3-acceptance` is green locally without network or API key.
7. This plan’s status is `complete` with commit SHA noted below.

### Closure evidence

```text
(final commit SHA filled at Phase 6 closure)
```
