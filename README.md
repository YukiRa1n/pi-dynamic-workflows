# Pi Dynamic Workflows

> A hardened Pi package for running deterministic JavaScript workflows across parallel subagents, with model routing, background execution, resume journals, team coordination, result delivery, and an interactive run UI.

![Workflow overview](./assets/readme/workflow.png)

## What this package provides

After installation, Pi gains:

- `workflow` — run a generated script, a saved workflow, or one of the built-in patterns.
- `workflow_control` — list, inspect, pause, resume, and stop workflow runs.
- `workflow_send` — send follow-up instructions to a live workflow subagent.
- `/workflows` — interactive workflow navigator.
- `/workflows-models` — configure `small`, `medium`, and `big` model tiers.
- `/deep-research`, `/code-review`, `/codebase-audit`, `/adversarial-review`, and `/multi-perspective`.
- Workflow-scoped Agent Teams with peer messages, inboxes, and a shared task board.
- Background final reports delivered to the main session using Pi's safe-point steering queue; an active provider request is not cancelled.

## Requirements

- Node.js 20 or newer is recommended.
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) version `0.80.8` or newer.
- At least one authenticated model/provider configured in Pi.
- Git is optional, but required when a workflow requests `isolation: "worktree"`.

## Install from GitHub

Install globally for the current Pi user:

```bash
pi install git:github.com/YukiRa1n/pi-dynamic-workflows
```

For a reproducible installation, pin a release tag once tags are available:

```bash
pi install git:github.com/YukiRa1n/pi-dynamic-workflows@v3.5.1-yuki.1
```

Reload Pi after installation:

```text
/reload
```

To test the package for one Pi process without keeping it installed:

```bash
pi -e git:github.com/YukiRa1n/pi-dynamic-workflows
```

### Project-level installation

To record the package in a project's `.pi/settings.json` instead of user settings:

```bash
pi install -l git:github.com/YukiRa1n/pi-dynamic-workflows
```

Commit `.pi/settings.json` if the whole team should receive the same package declaration. Pi will install missing project packages after the user trusts the project.

## Update or uninstall

Update unpinned Git packages:

```bash
pi update --extensions
```

Move a pinned installation to another tag:

```bash
pi install git:github.com/YukiRa1n/pi-dynamic-workflows@NEW_TAG
```

Remove the package:

```bash
pi remove git:github.com/YukiRa1n/pi-dynamic-workflows
```

## First-use setup

### 1. Confirm that Pi loaded the package

```bash
pi list
```

Inside Pi, open:

```text
/workflows
```

The model should also have access to `workflow`, `workflow_control`, and `workflow_send`.

### 2. Configure model tiers

Run:

```text
/workflows-models
```

Map the available authenticated models to the `small`, `medium`, and `big` tiers. A workflow can also select an exact model with `model: "provider/modelId"`.

### 3. Run a simple workflow

Ask Pi naturally:

```text
Run a workflow with one subagent that replies "workflow installed successfully".
```

Or use the explicit command path:

```text
/workflows run Review the current project from three independent perspectives and synthesize the findings.
```

Workflow runs are backgrounded by default, so Pi remains usable while subagents run. Use `/workflows` or `workflow_control` to inspect them.

## Built-in workflow patterns

| Pattern | Example |
| --- | --- |
| Deep research | `/deep-research Compare two libraries using primary sources.` |
| Code review | `/code-review HEAD~3..HEAD` |
| Codebase audit | `/codebase-audit src "unsafe input handling" "missing error boundaries"` |
| Adversarial review | `/adversarial-review Check this migration plan for hidden failure modes.` |
| Multiple perspectives | `/multi-perspective "Should this service be split?" security operations architecture` |

The same patterns can be invoked through the `workflow` tool by name.

## Writing a workflow

A workflow is deterministic JavaScript. Its first statement exports metadata and it must call `agent()` at least once:

```js
export const meta = {
  name: "parallel_review",
  description: "Review a change from several independent perspectives",
  phases: [{ title: "Review" }, { title: "Synthesis" }],
};

phase("Review");
const findings = await parallel([
  () => agent("Review the current diff for correctness.", { label: "correctness" }),
  () => agent("Review the current diff for security.", { label: "security" }),
  () => agent("Review the current diff for maintainability.", { label: "maintenance" }),
]);

phase("Synthesis");
return await agent(
  "Deduplicate, verify, and prioritize these findings:\n\n" + findings.join("\n\n"),
  { tier: "big", label: "synthesis" },
);
```

Important globals include:

| Global | Purpose |
| --- | --- |
| `agent(prompt, options?)` | Run one isolated subagent session. |
| `parallel(thunks)` | Run independent async functions concurrently while preserving order. |
| `pipeline(items, ...stages)` | Run stages sequentially per item while items proceed concurrently. |
| `createTeam(name)` | Create a workflow-scoped team with peer messaging and a task board. |
| `phase(title, { budget? })` | Mark a named phase and optionally assign a soft token sub-budget. |
| `workflow(savedName, args?)` | Invoke a saved workflow inline. |
| `verify`, `judgePanel` | Cross-check findings or select a best candidate. |
| `loopUntilDry`, `completenessCheck` | Run bounded iterative discovery and completeness checks. |
| `retry`, `gate` | Run bounded semantic retries or feedback-driven validation. |
| `deliver(message)` | Send an important message to the parent Pi conversation. |
| `args`, `cwd`, `budget` | Read workflow arguments, working directory, and token counters. |

Detailed authoring instructions and examples ship with the package under:

```text
skills/workflow-authoring/
skills/workflow-patterns/
```

## Runtime behavior

- `background` defaults to `true`; pass `background: false` only when the caller must wait inline.
- `concurrency` is bounded by the runtime maximum.
- `maxAgents`, retry counts, timeouts, and optional token budgets can be set per run.
- Completed calls are journaled. A resumed workflow replays the unchanged completed prefix and runs changed/new calls live.
- `isolation: "worktree"` is fail-closed: if a Git worktree cannot be created, that agent does not silently edit the shared checkout.
- Final subagent reports and explicit child-to-parent messages use `deliverAs: "steer"`. They are queued for the next safe point and do not abort an already-running provider request.
- Workflow custom messages are converted to synthetic tool-call/tool-result semantics for normal provider context. Compaction and branch-summary preparation sanitizes workflow custom entries so they do not become user-authored text.

## Persistence and privacy

Runtime state is not stored in this repository. It is written under the user's Pi workflow directory, normally:

```text
~/.pi/workflows/
```

This can include:

- run scripts and arguments;
- journals and final results;
- compact agent history;
- token/cost accounting;
- saved workflows and model-tier configuration.

Full subagent transcripts are in memory by default. Enabling `persistAgentSessions` stores full child sessions in Pi's session directory and may retain sensitive source or prompt material. Enable it only when that retention is desired.

Before sharing run-state files or session files, inspect them separately. They are deliberately not part of this Git repository.

## Security notes

Pi packages execute with the current user's system permissions. Review extension source before installing any third-party package.

Additional boundaries:

- Workflow orchestration uses Node's `vm` for determinism and synchronous execution limits, **not as a hostile-code security sandbox**. Run scripts only from trusted users or trusted model output.
- The orchestration script cannot directly call `require`, import modules, or use nondeterministic `Date.now()`/`Math.random()` globals, but subagents can use whatever tools the host grants them.
- Built-in web fetch tools restrict protocols, credentials, redirects, private/local IP ranges, timeout, and response size. These controls reduce risk but do not make arbitrary web content trustworthy.
- Worktree isolation requires a Git repository and does not automatically merge changes.
- Review workflow prompts and model output before applying destructive changes.

## Commands

| Command | Purpose |
| --- | --- |
| `/workflows` | Open the run navigator. |
| `/workflows run <prompt>` | Explicitly arm a workflow request. |
| `/workflows status <id>` | Watch one run. |
| `/workflows pause <id>` | Pause and journal a run. |
| `/workflows resume <id>` | Resume a paused/failed run. |
| `/workflows stop <id>` | Stop a run. |
| `/workflows save <name>` | Save the latest workflow as a reusable command. |
| `/workflows-models` | Configure model tiers. |
| `/workflows-trigger on\|off\|status` | Configure keyword arming. |
| `/workflows-progress compact\|detailed` | Configure the live panel. |
| `/effort off\|high\|ultra` | Configure standing workflow effort. |

## Package layout

```text
extensions/workflow.ts       Pi extension entry point
src/                         TypeScript implementation
dist/                        Package-root JavaScript and declarations
skills/workflow-authoring/   Authoring guidance and examples
skills/workflow-patterns/    Built-in workflow invocation guidance
assets/readme/                README images
```

## Current verification status

This repository includes synchronized `src` and `dist` runtime surfaces. The current snapshot has passed JavaScript syntax checks, extension transpilation, source-to-dist transpile parity, package dry-run inspection, and a local injected-agent smoke test.

The installed snapshot from which this fork was prepared did not include the upstream development `tests/`, `scripts/`, documentation site, or reproducible build configuration. Consequently, those upstream full-suite/release checks cannot be reproduced from this repository alone. Treat this repository as a tested Pi package snapshot, not as a claim that every authenticated provider and cross-process stress scenario has been certified.

## Attribution

This is a modified distribution based on [`QuintinShaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows), itself crediting Michael Livs' original project. The upstream code is distributed under the MIT License. This repository preserves the upstream copyright and license notices.

## License

MIT. See [LICENSE](./LICENSE).
