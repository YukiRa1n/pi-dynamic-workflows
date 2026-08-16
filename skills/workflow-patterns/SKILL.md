---
name: workflow-patterns
description: Arguments for five built-in workflows; load only after the user selects workflow execution.
metadata:
  version: "3.5.1-yuki.3"
---

# Built-in workflow patterns

pi-dynamic-workflows ships 5 curated, tested workflow patterns. Each is also a
slash command (`/deep-research`, `/adversarial-review`, `/code-review`,
`/multi-perspective`, `/codebase-audit`), but they are equally reachable from
the `start_workflow` tool directly: call it with `preset` set to the pattern name
below and `args` matching its shape, instead of writing an equivalent script
from scratch. Prefer this over authoring a new script whenever the request
fits one of these shapes and workflow execution is already authorized — the
curated version is reviewed and tested. Do not load this skill merely because
an ordinary direct request mentions research, review, analysis, or audit.

A project or user saved workflow of the same name always takes precedence
over a built-in of that name — on the slash command, too.

These 5 names are reachable only at the start-only `start_workflow` tool's top-level
`preset` input, not via the in-script `await workflow(savedName, childArgs)` helper
— that helper resolves saved workflows only. Calling `workflow('deep-research')`
from inside a script fails as an unknown saved workflow; use the top-level
`preset` input instead. This tool starts a new run; manage an existing run with
the explicit `/workflows status|watch|pause|resume|stop|steer` commands.

## Patterns

| `preset` | When to reach for it | `args` |
| --- | --- | --- |
| `deep-research` | Research a question across the web with cross-checked sources | `{ question: string, angles?: number, minSupport?: number }` — `angles` (default 4) is the number of distinct search queries; `minSupport` (default 2) is the minimum distinct sources required for a claim to survive cross-checking |
| `adversarial-review` | Investigate a task/claim, then cross-check each finding with skeptical reviewers | `{ task: string, reviewers?: number, threshold?: number }` |
| `code-review` | Multi-angle review of a diff (correctness, reuse, simplification, efficiency, altitude) | `{ diff: string, diffSource?: string }` — get `diff` yourself first (e.g. `git diff`, `gh pr diff <n>`); this path does not fetch it for you |
| `multi-perspective` | Analyze a topic from several independent perspectives in parallel, then synthesize | `{ topic: string, perspectives?: string[] }` — omit or give fewer than 2 to use the default set (technical, product, security, user experience, maintainability) |
| `codebase-audit` | Run parallel checks against a codebase scope, then cross-validate and report | `{ scope: string, checks: string[] }` |

## Example

```json
{ "preset": "deep-research", "args": { "question": "What are the tradeoffs of X vs Y?" } }
```

This is a `start_workflow` tool call, not a script — omit `script` entirely. The run
starts in the background exactly like the slash-command form. The start tool does
not accept per-call limits or existing-run IDs; use `/workflows` for lifecycle actions.

## Writing a new workflow instead

If the request doesn't fit one of these 5 shapes, author a script with
`script` as usual — see the workflow-authoring skill.
