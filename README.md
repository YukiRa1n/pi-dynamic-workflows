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
- One bounded background workflow result is delivered to the main session using Pi's safe-point steering queue; an active provider request is not cancelled. Routine per-subagent finals stay in the run journal/pager instead of consuming parent context.

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

Workflow tool runs are always backgrounded, so Pi remains usable while subagents run. Use `/workflows` or `workflow_control` to inspect them.

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

<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
| agent | runtime-global | `agent(prompt, options?) => Promise<string \| structured value \| null>` | `label`: string (optional; default: derived from phase and call count)<br>`phase`: string (optional; default: current phase)<br>`schema`: plain JSON Schema (optional)<br>`model`: string (optional)<br>`tier`: string (optional)<br>`isolation`: "worktree" (optional)<br>`agentType`: string (optional)<br>`timeoutMs`: number \| null (optional; default: run timeout; null disables)<br>`retries`: number (optional; default: run retry count) |
| parallel | runtime-global | `parallel(thunks) => Promise<Array<unknown \| null>>` | — |
| pipeline | runtime-global | `pipeline(items, ...stages) => Promise<Array<unknown \| null>>` | — |
| createTeam | runtime-global | `createTeam(name, options?) => AgentTeam` | — |
| workflow | runtime-global | `workflow(savedName, childArgs?) => Promise<unknown>` | — |
| verify | runtime-global | `verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string \| string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>` | `reviewers`: number (optional; default: 2)<br>`threshold`: number (optional; default: 0.5)<br>`lens`: string \| string[] (optional) |
| judgePanel | runtime-global | `judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } \| undefined>` | `judges`: number (optional; default: 3)<br>`rubric`: string (optional; default: "overall quality and correctness") |
| loopUntilDry | runtime-global | `loopUntilDry(options: { round: (roundIndex: number) => unknown[] \| Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<unknown[]>` | `round`: (roundIndex: number) => unknown[] \| Promise<unknown[]> (required)<br>`key`: (item: unknown) => string (optional; default: JSON.stringify)<br>`consecutiveEmpty`: number (optional; default: 2)<br>`maxRounds`: number (optional; default: 50) |
| completenessCheck | runtime-global | `completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } \| null>` | — |
| retry | runtime-global | `retry(thunk: (attempt: number) => unknown \| Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>` | `attempts`: number (optional; default: 3)<br>`until`: (result: unknown) => boolean (optional; default: accept first result when omitted) |
| gate | runtime-global | `gate(thunk: (feedback: string \| undefined, attempt: number) => unknown \| Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } \| Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>` | `attempts`: number (optional; default: 3) |
| checkpoint | runtime-global | `checkpoint(prompt, options?) => Promise<unknown>` | `default`: unknown (optional; default: true when no UI and omitted)<br>`headless`: "default" \| "abort" (optional; default: "default")<br>`kind`: "confirm" \| "input" \| "select" (optional; default: "confirm")<br>`choices`: string[] (optional)<br>`timeoutMs`: number (optional) |
| log | runtime-global | `log(message) => void` | — |
| deliver | runtime-global | `deliver(message) => Promise<void>` | — |
| phase | runtime-global | `phase(title, options?) => void` | `budget`: number (optional) |
| args | runtime-global | `args: unknown` | — |
| cwd | runtime-global | `cwd: string` | — |
| process | runtime-global | `process: { cwd(): string }` | — |
| budget | runtime-global | `budget: { total, spent(), remaining() }` | — |
| script | workflow-tool-input | `script?: string` | — |
| name | workflow-tool-input | `name?: string` | — |
| args | workflow-tool-input | `args?: Record<string, unknown>` | — |
| maxAgents | workflow-tool-input | `maxAgents?: number = 1000` | — |
| concurrency | workflow-tool-input | `concurrency?: number` | — |
| agentRetries | workflow-tool-input | `agentRetries?: number = configured value or 0` | — |
| agentTimeoutMs | workflow-tool-input | `agentTimeoutMs?: number = configured default or no per-agent limit` | — |
| workflowTimeoutMs | workflow-tool-input | `workflowTimeoutMs?: number = 30 minute default, up to 24 hours` | — |
| tokenBudget | workflow-tool-input | `tokenBudget?: number = configured default or unlimited` | — |
| resumeFromRunId | workflow-tool-input | `resumeFromRunId?: string` | — |
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->

See the [workflow authoring guide](docs/workflow-authoring.md) for the generated capability contract and the packaged skill for detailed authoring instructions and examples:

```text
skills/workflow-authoring/
skills/workflow-patterns/
```

## Runtime behavior

- Workflow tool invocations always start in the background; use the returned run ID with `/workflows` or `workflow_control` to inspect, pause, resume, or stop them.
- `concurrency` is bounded by the runtime maximum.
- `maxAgents`, retry counts, per-agent timeouts, and optional token budgets can be set per run. Every workflow also has a finite logical wall-clock deadline (30 minutes by default, configurable up to 24 hours with `workflowTimeoutMs`).
- A deadline races the complete script frame, closes admission, and aborts cooperative provider attempts. It cannot interrupt a pending Promise or a microtask-starved event loop; late provider settlement is observed and bounded drain cleanup is best effort.
- Completed calls are journaled. A resumed workflow replays the unchanged completed prefix and runs changed/new calls live.
- `isolation: "worktree"` is fail-closed: if a Git worktree cannot be created, that agent does not silently edit the shared checkout.
- Explicit child-to-parent `deliver()` messages and the single terminal workflow result use `deliverAs: "steer"` with `triggerTurn: true`. They are queued for the next safe point and do not abort an already-running provider request.
- Explicit delivery admission is finite per run: at most 32 messages, 256 KiB of UTF-8 payload, and 8 messages per 10-second window. A rejected delivery reports `DELIVERY_BUDGET_EXCEEDED`; terminal lifecycle delivery is reserved and is never downgraded or displaced by an explicit burst.
- Automatic per-subagent final reports are retained in `/workflows` details and persisted run JSON, but are not injected into the parent model context by default. Execution order is not used to guess that the last agent is the final product.
- The workflow's explicit return value is the semantic terminal product. Its provider projection prioritizes conventional `report`, `synthesis`, `summary`, or `answer` fields and is bounded to 12,000 characters; omitted content remains in the persisted run.
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

Accepted explicit deliveries and terminal notifications are written to the run's durable at-least-once outbox before safe-point submission. Delivery IDs remain stable across reloads and retries; provider-context projection is acknowledged at `before_provider_request`, while transport confirmation is best effort after the provider response. This provides stable-ID projection deduplication and durable at-least-once delivery, not provider-side or end-to-end exactly-once processing. Outbox records are removed only after the generation-fenced acknowledgement; uncertain sends remain replayable from the persisted run.

Resource admission is finite by default: each run allows at most 1,000 logical agents and 16 concurrent agents, each `parallel()`/`pipeline()` fan-out is capped at 10,000 items, logs are capped at 10,000 entries/2 MiB, provider prompts at 512 KiB, shared-store state at 2,048 keys/4 MiB, and one durable run record at 16 MiB. Team members/tasks/messages and paused in-memory snapshots also have bounded defaults. These are admission/retention failures, not truncation: complete durable results are either committed as native JSON or publication fails observably. Paused runs evicted from memory remain resumable from disk.

Before sharing run-state files or session files, inspect them separately. They are deliberately not part of this Git repository.

## Security notes

Pi packages execute with the current user's system permissions. Review extension source before installing any third-party package.

Additional boundaries:

- Workflow orchestration uses Node's `vm` for determinism and synchronous execution limits, **not as a hostile-code security sandbox**. Run scripts only from trusted users or trusted model output. Host-provided arguments are copied into the VM realm without host constructors.
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
