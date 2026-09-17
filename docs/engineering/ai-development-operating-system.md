# AI Development Operating System

Practical workflow for this repository. Agents follow explicit prompt/plan authority with minimal defaults.

## Prompt and plan authority

The **current user prompt** defines scope. An **active plan** (`docs/plans/`) is authoritative only when the task explicitly references it or designates it as the locked execution plan.

Plans may increase or decrease verification depth and grant individual permissions. Do not infer plan authority from history or filenames alone.

## Minimal defaults

- Smallest correct implementation for the requested scope.
- Composer as the normal model.
- No subagents unless explicitly justified.
- Targeted verification — not "run everything available."
- No implicit Git, CI, deployment, or external-effect permissions.

See `.cursor/rules/execution.mdc` for the machine-readable contract.

## Permission separation

Git, CI, deployment, and live external effects are **independent** capabilities. Each defaults to `false`. Granting one does not grant others (e.g. `commit` does not imply `push`; `create_pr` does not imply `merge` or CI watching).

Stop before unauthorized operations rather than treating them as workflow continuations.

## Model cost discipline

Stronger models are exceptions with a bounded problem, concrete reason, and limited scope. See `model-strategy.md`.

## Subagents

Opt-in only. Use when explicitly authorized and parallelization has concrete benefit — not for routine mapping, implementation, debugging, or review.

## Workflows

### Small change

```text
Implement
→ minimum targeted check
→ diff review
→ complete
```

### Normal feature

```text
Implement
→ relevant targeted checks
→ diff review
→ complete according to active plan
```

### Large planned chapter

The authoritative plan may explicitly authorize broader tests, subagents, stronger models, commits, pushes, PR creation, CI waiting/watching, CI fix loops, merge, or post-merge validation. **Each permission must still be explicitly granted** where applicable.

### Release / closure

Full gates (broad suites, CI, deployment verification) apply only when the active plan explicitly defines them. Release-level behavior is not the default for ordinary tasks.
