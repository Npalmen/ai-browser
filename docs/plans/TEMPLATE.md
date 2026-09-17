# Plan: [Title]

**Status:** draft | active | locked | complete  
**Explicit reference:** Tasks must cite this file by path to treat it as authoritative.

Copy this template for new plans. Delete sections that do not apply.

---

## Objective

What this plan delivers. Bounded scope statement.

## Out of scope

What this plan explicitly does not cover.

## Model policy

```yaml
model:
  default: composer
  escalation_allowed: false
  # escalation_reason: <required if escalation_allowed is true>
```

## Subagents

```yaml
subagents:
  allowed: false
  # justification: <required if allowed is true>
```

## Verification

```yaml
verification:
  mode: targeted  # targeted | extended | release
  # checks: <list explicit checks if mode is extended or release>
```

## Permissions

Grant only what this plan authorizes. Absent fields are `false`.

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

## Chapters / phases

| Phase | Scope | Verification | Notes |
|-------|-------|--------------|-------|
| 1 | | targeted | |
| 2 | | | |

## Completion criteria

How to know this plan (or a phase) is done.
