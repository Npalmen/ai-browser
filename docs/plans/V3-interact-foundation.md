# Plan: V3 — Permissioned INTERACT foundation

**Status:** complete  
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
→ model structured output (answer OR single ModelInteractionProposal)
→ schema validation (no execution identity from the model)
→ trusted local bind (tabId, observationId, documentRevision, exported-target allowlist)
→ BoundInteractionProposal
→ semantic policy (INTERACT or NAVIGATE by effect)
→ grant
→ executor → BrowserAdapter primitive
→ fresh observePage
→ InteractionResult to trusted app UI
```

Supported primitives:

| Primitive | Authority level |
|-----------|-----------------|
| `click` | INTERACT **or** NAVIGATE, by semantic effect |
| `type` | INTERACT |
| `select` (native `<select>` with bounded option catalog) | INTERACT |
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
executeJavaScript / Runtime.evaluate / DOM.resolveNode / generic CDP API
Target.setAutoAttach / Target.attachToTarget / implicit OOPIF session authority
model-supplied tabId / observationId / documentRevision as execution identity
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
| Authority boundary | Model → validator → **local binder** → policy → grant → executor → `BrowserAdapter` |
| Proposal mechanism | Structured output union (`answer` \| `interaction`); not tool-calling |
| Model proposal identity | `kind` + `targetId` / payload only; model must not supply `tabId` / `observationId` / `documentRevision` |
| Trusted local binding | Binder copies identity from the exact `PageObservation` used for that inference |
| Exported-target enforcement | Target IDs must be in that request’s `exportedTargetIds` |
| Stale targets | Fail closed; no retargeting; registry + revision + live preflight remain |
| Click classification | Same `click` primitive may be INTERACT or NAVIGATE |
| Policy | Conservative metadata classifier; uncertain → deny |
| Sensitive fields | Deny all model-driven typing |
| Scroll | NAVIGATE authority |
| CDP allowlist | `Page.getFrameTree`, `DOM.getBoxModel`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText` |
| Frames / OOPIF | Attached session only; unsupported/cross-process frames → `UNSUPPORTED_FRAME` |
| Native select | Bounded select-specific `nativeOptions` catalog; no HTML `value` assumption |
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
| 1 | Shared types, errors, model-proposal schema, trusted binder | Types compile; binding/validator unit tests pass |
| 2 | Target resolution, interaction CDP client, `BrowserAdapter` primitives | Executor unit tests + adapter tests with fixtures |
| 3 | Policy classifier, grants, audit sink | Policy adversarial tests pass |
| 4 | `InteractiveAgent` + structured model output | Agent unit tests with recording runtime |
| 5 | Main controller, IPC events, minimal UI | Integration tests; manual smoke |
| 6 | Fixtures, acceptance harness, milestone closure | `test:v3-acceptance` green; plan → complete |

---

## Phase 1 — Shared types, errors, model-proposal schema, trusted binding

### Scope

Phase 1 owns types and binding only. **No browser execution.**

- Add `src/shared/interaction-types.ts` distinguishing:
  - `ModelInteractionProposal` (model-visible; no execution identity)
  - `BoundInteractionIdentity` / `BoundInteractionProposal` (local bind result)
  - grants, results, authority levels, bounds constants
- Add `src/shared/interaction-errors.ts` — `InteractionErrorCode` including `UNSUPPORTED_FRAME` and `TARGET_NOT_EXPORTED`, `InteractionError` class.
- Add `src/interaction/proposal-validator.ts` — strict schema for **model** proposals: kinds, bounds, reject unknown fields.
- Add `src/interaction/proposal-binder.ts` — copy `tabId`, `observationId`, `documentRevision` from the actual `PageObservation`; enforce `exportedTargetIds`.
- Add `src/interaction/action-level.ts` — primitive defaults plus the rule that **click authority is not assumed INTERACT**.

### Files likely touched

```text
src/shared/interaction-types.ts            (new)
src/shared/interaction-errors.ts           (new)
src/interaction/proposal-validator.ts      (new)
src/interaction/proposal-binder.ts         (new)
src/interaction/action-level.ts            (new)
src/interaction/proposal-validator.test.ts (new)
src/interaction/proposal-binder.test.ts    (new)
```

### Tests

- Valid/invalid **model** proposals per kind.
- Model cannot supply `tabId` as authority (extra field rejected).
- Model cannot supply `observationId` as authority (extra field rejected).
- Model cannot supply `documentRevision` as authority (extra field rejected).
- Invented / non-exported `targetId` is rejected during binding.
- Binding copies identity from the actual `PageObservation` used for that inference.
- Text length over max rejected.
- Scroll amount over max rejected.

### Non-goals

- No CDP, no adapter methods, no policy rules, no model calls, no `nativeOptions` observation builder yet.

### Stop condition

`npm run typecheck` and targeted tests for validator + binder pass.

### Model

Composer 2.5.

---

## Phase 2 — Target resolution, CDP client, BrowserAdapter primitives

### Scope

- Add `src/interaction/target-resolver.ts` — wraps `TargetRegistry` + observation node lookup + revision preflight interface. Resolver consumes **bound** identity, never model-supplied IDs.
- Add `src/observation/interaction-cdp-client.ts` — closed V3 allowlist per ADR-004 §12:
  `Page.getFrameTree`, `DOM.getBoxModel`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`.
  **Do not** add `DOM.resolveNode`, `Target.*`, or `Runtime.*`.
- Add `src/browser/interaction-primitives.ts` — internal click/type/select/scroll implementation used by adapter.
- Extend `src/browser/browser-adapter.ts` + `src/browser/electron-adapter.ts` with four primitive methods (executor-only callers).
- Frame rule: attached website debugger/session only. Main-frame baseline. Same-process iframe only if `DOM.getBoxModel` + `Input.*` succeed on that session. Otherwise `UNSUPPORTED_FRAME`.
- Native select: implement against the bounded `nativeOptions` catalog (observation enrichment as needed). Do not read HTML `value` from a widened attribute allowlist. Do not use `Runtime.evaluate`. Missing catalog → `UNSUPPORTED_TARGET`.
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
src/observation/observation-builder.ts     (select-only nativeOptions, if required)
src/shared/observation-types.ts            (optional nativeOptions field)
```

### Tests

- Resolver: happy path, stale `observationId`, missing target, cross-tab rejection.
- CDP client: allowlist rejects unknown methods including `DOM.resolveNode` and `Runtime.evaluate` (mock debugger).
- Primitives: mock CDP; verify center-click coordinates, `insertText` sequence, bounded scroll delta.
- Frames:
  - main-frame target succeeds
  - supported same-process iframe target succeeds where the bounded path can preflight it
  - unresolvable / cross-process / OOPIF target fails closed (`UNSUPPORTED_FRAME`); no coordinate fallback
- Select: option from `nativeOptions` catalog; missing/unassociated option → `UNSUPPORTED_TARGET`.

### Non-goals

- No policy classifier, no agent, no IPC, no `Target.*` child-session machinery.

### Stop condition

Adapter primitive unit tests pass; resolver tests pass; frame fail-closed tests pass; typecheck clean.

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
expand/collapse, benign button, non-sensitive textbox, native select catalog
safe navigational link (ALLOW_NAVIGATE, not INTERACT)
bounded scroll (ALLOW_NAVIGATE)
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
- If model returns `interaction`, run validator → **binder** → executor once.
- Tab lock / cancel semantics aligned with `ReadOnlyAgent`.
- `ReadOnlyAgent` file remains unchanged.

### Tests

- Recording runtime returns proposal → binder attaches local identity → executor invoked (mock).
- Model returns `tabId` / `observationId` / `documentRevision` → schema reject, no adapter call.
- Invented or non-exported `targetId` → binding reject, no adapter call.
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
| Positive INTERACT | expand, type non-sensitive, native select from catalog |
| Positive NAVIGATE | bounded scroll; safe non-consequential link classified as NAVIGATE |
| Stale target | superseded observation, revision change, navigation, cross-tab, removed node, non-exported targetId |
| Policy denial | submit, buy, delete, send, payment, sensitive type, injection page, suspicious href |
| Frames | main-frame success; supported iframe where applicable; OOPIF/unresolvable fail closed |
| Execution | grant before adapter; fresh observation after success |
| Security | no WebContents to renderer; no executeJavaScript; no website IPC; audit has no secrets; model cannot bind identity |

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
[x] Model cannot import BrowserAdapter interaction methods
[x] Model proposal schema rejects tabId / observationId / documentRevision
[x] Binding copies identity from the inference PageObservation
[x] Non-exported targetId cannot execute
[x] Website preload unchanged (no action IPC)
[x] ipc-security allowlist has no interaction primitives for websites
[x] Interaction CDP allowlist is closed (no DOM.resolveNode, Target.*, Runtime.*)
[x] No Runtime.evaluate / executeJavaScript path
[x] Unsupported frames fail closed
[x] Audit sink contains no secrets or full page text
[x] ReadOnlyAgent tests still pass unchanged
[x] V2 acceptance still passes
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
Architecture hardening:
616fd2bed34f096614471efd55f88036b44dd469

Phase 1:
1964fd250aeb3e159077a6a312791f94538bbb87

Phase 2:
d3e85974e080902544e45314932b4481f1b33899

Phase 2 hardening:
7de340404336479c0f0144d7c9db17e5f1f79103

Phase 3:
b261df93adbf4808c6f8132619f26cb91dee2adf

Phase 3 audit correction:
151b47e28b43fc31e375079990469dedc3f5ea8a

Phase 4:
c0e0943caf686926956db2c1670dcfa4f09c5540

Phase 4 hardening:
8d8d2462ed36744358c81043eb1123232496b034

Phase 5:
b8467b137d037e3f332876d51669fc6656e27a20

Phase 6 acceptance:
0e1899260951514fc2f545210ff787f19be69319

Post-closure native select exact-target hardening:
aaa8ceb7a087c5c5ccec44d8b853dc4f2c7a6270
```

### Closure verification (2026-09-18)

```text
npm run typecheck                          PASS
npm run test:ai                            PASS (202 tests)
npx tsx --test src/interaction/*.test.ts   PASS (87 tests)
npm run test:observation                   PASS (40 tests)
npm run test:fixture                       PASS (5 tests)
npm run test:v2-acceptance                 PASS (29 tests + [v2-electron-observation] PASS)
npm run test:v3-acceptance                 PASS (29 tests + [v3-electron-interaction] PASS)
```
