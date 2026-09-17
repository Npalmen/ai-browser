# Model Strategy

## Default

**Composer** is the normal execution model for this repository.

A stronger or external model is an **exception**, not a routine escalation path when work is difficult or a check fails.

## When escalation is valid

Use a stronger model only when the current prompt or authoritative active plan explicitly allows it, with a bounded reason. Valid categories include:

- Difficult authentication or permission architecture
- Concurrency or idempotency reasoning
- Security review
- Destructive migration design
- Unusually difficult architectural work

## Escalation requirements

Every escalation should have:

1. **A bounded problem** — specific question or decision, not open-ended ownership
2. **A concrete reason** — why Composer is insufficient for this slice
3. **A limited scope** — time-boxed to the authorized work unit

## Discouraged patterns

Do not use automatic:

- Model routing
- Fallback chains
- Model panels or parallel opinions
- Best-of-N selection
- Reviewer models on every change
- Repeated review/fix/review loops

Do not hard-code vendor-specific fallback chains in repository configuration.

A failed command, failed test, or imperfect first attempt does **not** justify escalation by itself.
