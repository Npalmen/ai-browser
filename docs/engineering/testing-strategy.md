# Testing Strategy

## Default objective

The default is **not** "run every available check."

The default is to validate **the specific change** with the **narrowest useful verification**, then inspect the diff and stop.

## Targeted verification

```yaml
verification:
  mode: targeted
```

| Change size | Verification |
|-------------|--------------|
| Small fix or tweak | Smallest relevant check for the affected area |
| Normal feature | Relevant targeted checks per active task/plan |
| Large planned chapter | Broader checks only if the authoritative plan explicitly authorizes them |
| Release / closure | Full gates only if the active plan explicitly defines them |

## What not to run by default

Unless required by the active prompt/plan or necessary to validate the affected area:

- Full repository test suites
- Full lint suites
- Full builds
- Docker builds or integration environments
- E2E tests
- CI workflow execution
- Broad regression suites

## Failed checks

A failed targeted check does **not** automatically authorize:

- Running the full suite
- Model escalation
- Subagents
- Autonomous fix loops

Diagnose with the narrowest useful step first. Broader validation requires explicit authorization in the prompt or active plan.

## Relationship to permissions

Running CI, watching CI, fixing CI, and post-merge verification are separate permissions — not implied by implementation or commit work. See `ai-development-operating-system.md` and `execution.mdc`.
