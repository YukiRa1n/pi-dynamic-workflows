---
name: workflow-authoring
description: Write, edit, review, or debug Workflow JavaScript; not for running an existing workflow.
metadata:
  version: "3.5.1-yuki.2"
---

# Workflow authoring

Load this skill only when workflow JavaScript changes. Do not load it for an ordinary user task or for an existing-run lifecycle command. Running, watching, pausing, resuming, stopping, or steering an existing workflow is handled explicitly by `/workflows`.

## Main-session routing

- The extension exposes one stable, start-only `start_workflow` tool. Use it only when the user explicitly requests a workflow, delegation, fan-out, or multi-agent orchestration.
- A new requirement must stay in the main session or start a fresh run. Never send it to an existing run because the wording happens to mention that run.
- `/effort` changes guidance only for an explicitly requested workflow. It does not take over ordinary messages.
- Use `deliver({ kind, message })` only for a concise `blocker`, `critical_finding`, or `decision`; keep routine progress and ordinary child finals in workflow state.

## Choose a branch

Read only what the task needs:

- **Write or edit:** start with [runtime](references/runtime.md). Add [pattern selection](references/pattern-selection.md) for topology, [lifecycle](references/lifecycle.md) for limits or resume, and [focused recipes](references/focused-recipes.md) for the matching concern.
- **Helper task:** read [quality helpers](references/quality-helpers.md) only for `verify` or `judgePanel`, the [retry helper](references/retry-helper.md) only for `retry`, and [specialized helpers](references/specialized-helpers.md) only for `completenessCheck`, `loopUntilDry`, `gate`, or `checkpoint`.
- **Review:** use the [review checklist](references/review.md), plus only the matching [quality](references/quality-helpers.md) or [specialized](references/specialized-helpers.md) helper contracts.
- **Debug:** use the [debugging map](references/debugging.md).
- **Routing:** read [registry ownership](references/registry-ownership.md) before using `model`, `tier`, phase models, or `agentType`; use environment-specific names only when context supplies them.
- **Exact lookup or portability:** start with the generated [capability index](references/capabilities.md). Follow its exhaustive-facts pointer only for constraints or support boundaries. Use [versions](references/versions.md) when moving scripts between installations.

## Invariants

- Start with literal `export const meta = { name, description }`; declare phases as an array of used `{ title }` objects and enter each named phase.
- Call `agent()` at least once, give every call a short unique `label`, and return plain JSON data explicitly.
- Pair ordered results with stable work IDs before filtering. When one agent consumes another's selected result, include both its stable ID and actual data in the downstream prompt. Treat recoverable `null` as missing coverage and report it.
- Bound fan-out, loops, retries, agents, and concurrency to the task. Treat invocation-level token and time caps as opt-in user constraints, not defaults.
- Use `log()` for new code; `console` is compatibility-only.
- Write plain JavaScript without imports or filesystem modules. Pass nondeterminism through `args`; `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable.
