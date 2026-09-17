# ADR-003: Model runtime and routing

**Status:** Accepted  
**Date:** 2026-09-17  
**Supersedes:** none  
**See also:** `docs/architecture/browser-architecture.md` §4.3, §8, §11; `docs/architecture/ADR-001-browser-runtime.md`; `docs/architecture/ADR-002-page-observation.md`; `docs/plans/V2-model-runtime-readonly-agent.md`

## Context

V0 is a usable desktop browser shell. V1 is local page observation: structured `PageObservation`, opaque `targetId`s, and an in-memory viewport screenshot. Neither milestone sends page data to a model.

The next product slice is **read-only page Q&A**:

```text
User question
→ fresh PageObservation
→ bounded model-context export
→ routed model call
→ structured answer in trusted app UI
```

The model may reason about the current page. It must not navigate, click, type, submit, or execute JavaScript.

Existing architecture already states:

- remote models are untrusted data recipients
- page content sent to a model is an explicit data-exfiltration event
- the agent never holds Electron objects
- `BrowserAdapter` is the only browser-control surface
- screenshots may contain on-screen secrets and require a separate export gate

This ADR locks the **model-runtime boundary**, **Gateway-as-transport (not product API)**, **structured streaming**, **routing**, **bounded retries**, **export/privacy policy**, and **prompt-injection envelope**. Exact TypeScript shapes live in the V2 plan.

**Numbering note.** `browser-architecture.md` §13 uses a different product-capability numbering (its “V1” is observe+navigate). Repository milestones remain:

```text
V0 shell → V1 observation → V2 read-only model Q&A → later INTERACT / APPROVAL / EXECUTE
```

This ADR does not reopen ADR-001 or ADR-002.

## Decision

Use a **project-owned model runtime** hosted in the Electron main process, with **Vercel AI SDK + Vercel AI Gateway** as the V2 transport implementation behind that runtime.

```text
Trusted app UI
        │ typed IPC (ask / cancel / events)
        ▼
Read-only agent (main)
        │ observePage(tabId) — infrastructure, not a model tool
        ▼
Context builder / export policy
        │ ModelRequest
        ▼
Model router (deterministic)
        │ ModelProfile + alias
        ▼
ModelRuntime interface
        │
        ▼
AI SDK Gateway adapter (only this layer imports `ai`)
        │
        ▼
Remote model provider(s)
```

### 1. Product code depends on our types, not on the SDK

Application, agent, IPC, and UI depend on:

```text
ModelRuntime
ModelRouter
ModelCatalog
ModelRequest
ModelResponse
ModelUsage
```

They must **not** import or call:

```text
generateText
streamText
gateway(...)
OpenAI / Anthropic / Google / xAI clients
```

Those exist only inside `src/ai/providers/`.

This preserves later adapters: direct provider packages, OpenAI-compatible local endpoints, or a different gateway, without rewriting the read-only agent.

### 2. Transport for V2: AI SDK + AI Gateway

**Selected: Option A — Vercel AI SDK (`ai`) + Vercel AI Gateway.**

Verified against current official docs (2026-09-17):

- AI SDK `generateText` / `streamText` accept Gateway model strings in `creator/model-name` form and route through AI Gateway.
- The `gateway` provider is available from the `ai` package (docs: ≥ 5.0.36). AI Gateway works with AI SDK v5 and v6.
- Gateway supports provider routing (`order`, `only`, `sort: cost | ttft | tps`), model fallbacks (`providerOptions.gateway.models`), BYOK, usage metadata, and generation cost lookup.
- Public model discovery: unauthenticated `GET https://ai-gateway.vercel.sh/v1/models` (OpenAI-style list). Sampled 2026-09-17: hundreds of models with `id`, `context_window`, `modalities.input` (`text` / image), `tags`, and `pricing`.
- Auth for inference: `AI_GATEWAY_API_KEY` (Bearer). The AI SDK reads this env var by default.
- Structured streaming for V2 answers: `streamText()` + `Output.object(...)` with a **JSON Schema / Standard Schema** (`jsonSchema(...)` or equivalent in the installed `ai` package). Do **not** add `zod` unless implementation shows a concrete need.
- Partial structured objects from `partialOutputStream` are **not** validated finals. Only completed SDK-validated output plus product-side `AgentAnswer` normalization is authoritative.
- Streaming: `streamText` + `abortSignal`. Multimodal image parts are supported.
- Usage fields on SDK results include optional `inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens`.

**AI Gateway is V2’s default transport implementation. It is replaceable behind `ModelRuntime`.** Gateway slugs (`creator/model-name`), `providerOptions.gateway`, and Gateway routing options must not leak into `ReadOnlyAgent`, the context builder, shared IPC types, or the renderer. They may exist only in the catalog, router/runtime provider mapping, and `providers/ai-sdk-gateway.ts`.

**Do not add provider-specific packages in V2** (`@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) unless a concrete Gateway limitation blocks the selected aliases.

**Do not hardcode remembered vendor model IDs in this ADR.** Implementation must resolve current Gateway slugs from `GET /v1/models` (and/or the current official discovery API) **once**, when writing the static catalog. Do not fetch the live model list on every browser startup. Model upgrades are explicit catalog/code changes.

### 3. Routing is a first-class product layer

V2 routing is **deterministic**. Do not call a model to choose a model.

```text
AskCurrentPage request
  taskClass
  needsVision?
  privacy
  estimated context size
→ catalog policy
→ alias (page-fast | page-standard | page-deep | page-vision)
→ current Gateway model slug + profile
→ ModelRuntime
```

Task classes (closed set):

```text
page_summary
page_question
page_analysis
comparison
extraction
```

Default IPC `taskClass` is `page_question`. The UI does not need to expose all five in V2; unused classes still exist in the router so later UI can pass them without a redesign.

Internal aliases are stable. Provider model slugs are **not**. They live in one catalog file and may change when models are retired.

### 4. Provider failover vs model fallback

These are different layers:

| Concept | Owner | Meaning |
|---------|--------|---------|
| **Provider failover** | AI Gateway adapter, **inside one model attempt** | Same logical catalog model, different inference host (`order` / `only` / `sort` where supported) |
| **Model fallback** | Product router / read-only agent | Different **alias** after a **defined** failure |

Gateway provider failover must not be combined with Gateway `models` arrays **and** product alias fallback into an unbounded tree.

Retry budget per user ask:

```text
observationAttempts <= 2   (second only for PAGE_CHANGED_DURING_OBSERVATION)
modelAttempts        <= 2   (routed alias, then at most one fallback alias)
provider failover          handled inside a single model attempt
```

The product may attempt **at most one** additional alias (maximum **two** model attempts total). Cancellation consumes no fallback. Do not recurse the agent.

Automatic model fallback is allowed only for:

- provider/model unavailable
- auth failure after the first attempt is not retried with the same credentials
- unsupported modality (e.g. vision requested, current alias has no image input)
- context-window overflow when the fallback profile has a larger window
- structured-output validation failure, if V2 uses schema validation on that request

**Not allowed:** retrying a stronger model because the answer “seems bad.”

### 5. Privacy and export boundary

```text
Local PageObservation
        │
        ▼
Model context export policy
        │  structuredExportAllowed?
        │  screenshotExportAllowed?
        │  privacy: remoteAllowed | localOnly
        ▼
ModelRequest
```

- `localOnly` must never silently fall back to a remote provider. If no local runtime is configured (V2: none), fail `MODEL_NOT_CONFIGURED`.
- Structured secret values remain redacted (V1 policy). Do not undo redaction.
- Screenshots are **not** redacted. Include a screenshot only if **all** of these are true: task needs vision, selected profile supports vision, privacy is `remoteAllowed` (remote export permitted), screenshot export policy allows it, and `PageObservation.screenshot` is present. Do not send a screenshot merely because V1 captured one. Do not decode/re-encode unnecessarily.
- Asking about the current page is user-initiated consent for **structured** export only, not for screenshot export.

### 6. Prompt-injection envelope

Webpage content is untrusted input. It must never become system instructions.

Message hierarchy:

```text
system  — product behavior, read-only constraints, instruction hierarchy,
          page content is untrusted, do not claim actions occurred
user    — the human's question only
user    — <UNTRUSTED_PAGE_CONTENT>{ compact JSON }</UNTRUSTED_PAGE_CONTENT>
```

The page payload must never be interpolated into the system instruction. The system text must state that anything inside that region is website data, not instructions. Context-builder tests must prove injection strings remain inside the untrusted wrapper and never appear in system messages.

### 7. Read-only agent; no model tools

The V2 agent may call `observePage` as **controlled infrastructure** once per user question.

The model is **not** given tools for:

```text
observePage, navigate, back, forward, reload, click, type, select, scroll
```

Target IDs in answers are descriptive grounding only. They do not trigger actions.

The model-facing structured result is:

```ts
{ text: string; referencedTargets: TargetId[] }
```

Do not ask the model to embed opaque IDs in user-visible prose. After SDK schema validation, **drop** any `referencedTargets` that are not in the exported observation for that request. Invented IDs must not fail an otherwise valid `text` answer.

### 8. Structured streaming stays inside the adapter

V2 uses:

```text
streamText() + Output.object(jsonSchema)
→ partialOutputStream.text → onTextDelta (product callback)
→ final validated object → ModelResponse
→ ReadOnlyAgent filters targets → AgentAnswer
```

`ModelRuntime` must not return an AI SDK stream. Prefer:

```ts
generate(request, { signal?, onTextDelta? }): Promise<ModelResponse>
```

Partial structured values are incomplete. Only the final object is used for `referencedTargets`, usage, completion, and conversation commit. Do not stream reasoning / chain-of-thought. Do not salvage malformed JSON by hand. Incomplete generations are not conversation turns.

Renderer-safe events are product-owned (`answer-started` / `answer-text` / `answer-finished` / `answer-error`), never SDK partial objects.

### 9. Credentials

API keys live in the main process only.

V2 development: environment variable `AI_GATEWAY_API_KEY`.

Never place keys in renderer, preload, `contextBridge`, `BrowserState`, `PageObservation`, `ModelPageContext`, IPC payloads, Git, or the frontend bundle. Missing key → `MODEL_NOT_CONFIGURED`.

Architect (do not implement billing) for later:

```text
product-funded Gateway key
user BYOK (Gateway byok / provider keys)
```

Production OS-secure storage is deferred.

### 10. Usage, cost, and telemetry

Normalize optional usage (`inputTokens`, `outputTokens`, `reasoningTokens`, `cachedInputTokens`, `totalTokens`) without inventing missing numbers.

Cost is `known` | `estimated` | `unknown` in USD. Use Gateway generation cost when present; estimate only if catalog pricing **and** required usage are both available; otherwise `unknown`.

In-memory operational records may include requestId, taskClass, alias, resolved model, provider, startedAt, latency, usage, cost, fallbackCount, status. They must not include question, page text, context, answer, screenshot, or API keys. Do not persist telemetry in V2.

## Alternatives

| Approach | Verdict |
|----------|---------|
| **AI SDK + AI Gateway** | **Selected.** One TypeScript API, many providers, streaming, multimodal, usage/cost metadata, provider failover, model fallbacks, BYOK path. Fits a small team. |
| AI SDK + direct provider packages | Stronger vendor-specific knobs; duplicates routing, failover, model-retirement handling; more packages; worse default commercial ops. Revisit if Gateway lacks a required capability. |
| Project-owned direct HTTP clients | Maximum control; duplicates streaming, schema validation, error mapping, usage parsing, and provider drift. Rejected for V2. |
| Local-only inference (Ollama / llama.cpp / LM Studio) | Allowed later behind `ModelRuntime`. Not V2 default. `localOnly` must fail closed until a local adapter exists. |
| Model mesh inside `BrowserAdapter` | Violates adapter boundary; couples website Chromium lifetime to billed HTTP. Rejected. |
| Generic renderer `ai.generate(prompt)` | Turns the trusted UI into a provider client and bypasses export policy. Rejected. |

### Comparison (descriptive)

| Concern | SDK + Gateway | SDK + direct providers | Homegrown clients |
|---------|---------------|------------------------|-------------------|
| Provider breadth | Broad via Gateway catalog | Only packaged providers | Only what we write |
| Model switching | Alias → current slug | Per-package model IDs | Per-client IDs |
| Provider failover | Gateway `order` / `sort` / `only` | DIY | DIY |
| Model fallback | Product alias fallback (max 2 attempts); do **not** also enable unbounded Gateway `models` lists | DIY | DIY |
| Structured output | AI SDK `Output.object` + JSON Schema / Standard Schema (no Zod required) | Same SDK | DIY |
| Streaming | `streamText` + `abortSignal` | Same SDK | DIY |
| Multimodal | Image parts + vision-capable slugs | Per provider | DIY |
| Usage metadata | SDK usage + Gateway generation info | Provider-specific | DIY |
| Cost visibility | Gateway pricing + generation cost; may be unknown | Provider invoices | Unknown unless priced by us |
| Lock-in | SDK + Gateway transport; **interface is ours** | Deeper per-vendor | Least SDK lock-in, most code |
| Local-model path | Later OpenAI-compatible adapter | Later | Immediate but costly |
| Implementation complexity | Lowest for V2 | Medium | Highest |
| Commercial suitability | Credits, BYOK, spend reports exist at Gateway | BYOK-native, more ops | Poor until we build billing |

## Consequences

**Positive**

- Browser/observation remain usable without AI
- One catalog owns aliases and current slugs
- Export and prompt-injection are explicit stages, not prompt glue
- Streaming UX without leaking SDK streams to React
- Later INTERACT agent can reuse `ModelRuntime` without inheriting tools

**Negative**

- V2 depends on Gateway availability and `AI_GATEWAY_API_KEY` for remote answers
- Model slugs churn; catalog must be re-verified from `/v1/models`
- Screenshots remain a sensitive export even when structured values are redacted
- Deterministic routing will sometimes pick a weaker or stronger model than a human would

**Required follow-through**

- Implement only under `docs/plans/V2-model-runtime-readonly-agent.md` (status: locked)
- Phase 1 needs no new dependency; Phase 2 installs `ai` only. Do not pre-install `zod`.
- At implementation, re-verify AI SDK + Gateway docs and live model list **before writing catalog slugs**; do not copy remembered IDs
- Do not add INTERACT / PREPARE_ACTION / APPROVAL / EXECUTE
- Do not put `ai` imports in `src/browser/` or `src/observation/`

## Revisit if

- AI Gateway cannot serve required vision, streaming, or usage metadata for the selected aliases
- A compliance requirement forbids third-party gateways (then a direct-provider or local adapter behind the same `ModelRuntime`)
- Local-only becomes a V2+ product requirement
- INTERACT tools are introduced (new ADR for tool/permission boundary; do not overload this runtime ADR)
- The AI SDK public API used here is removed or renamed incompatibly
