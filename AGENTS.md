# Agent Operating Principles

This repository uses explicit scope, minimal defaults, and separated permissions. Detailed guidance lives in `docs/engineering/` and `.cursor/rules/`.

## Precedence

When instructions conflict, apply this order:

1. **Non-overridable safety/security constraints** — always win.
2. **Explicit current user/task prompt** and any **explicitly referenced authoritative active/locked plan**.
3. **Applicable scoped repository rules** (`.cursor/rules/`).
4. **Minimal default behavior** described here and in `execution.mdc`.

An active plan is authoritative **only** when the current task explicitly references it or clearly designates it as the active execution plan. Do not scan historical plans and infer one.

## Defaults

- Work only on the requested scope.
- Prefer the smallest correct implementation.
- **Composer** is the normal model policy.
- No model escalation unless explicitly authorized or justified by the authoritative task/plan.
- No subagents unless explicitly justified.
- **Targeted verification** by default — not full suites, builds, CI, or E2E unless required.
- **No implicit Git/CI/deployment permissions** — absent permission means `false`.
- Inspect the resulting diff before considering the task complete.
- Stop when the requested scope and required verification are complete.

## Where to look

| Topic | Location |
|-------|----------|
| Execution contract | `.cursor/rules/execution.mdc` |
| Browser action boundaries | `.cursor/rules/browser-agent-safety.mdc` |
| Workflow & permissions | `docs/engineering/ai-development-operating-system.md` |
| Model escalation | `docs/engineering/model-strategy.md` |
| Verification philosophy | `docs/engineering/testing-strategy.md` |
| Plan template | `docs/plans/TEMPLATE.md` |
