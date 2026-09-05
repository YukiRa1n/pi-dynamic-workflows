# Pi Dynamic Workflows

> A hardened Pi package for running deterministic JavaScript workflows across parallel subagents, with model routing, background execution, resume journals, team coordination, result delivery, and an interactive run UI.

![Workflow overview](./assets/readme/workflow.png)

## What this package provides

After installation, Pi gains:

- `start_workflow` — a stable, start-only tool for a generated script or curated built-in preset.
- `list_active_workflows` — a stable, current-session list of exact cancellation handles.
- `get_workflow_output` — an interruptible, deadline-free event wait for one current-session run; completed subagent and terminal results arrive through the durable main-session delivery lane.
- `stop_workflow` — a stable, exact-ID cancellation handle limited to runs owned by the current Pi session.
- `Alt+↓` — open the interactive workflow navigator; then use arrows and Enter (`/workflows` remains the fallback).
- `/workflows status|watch|pause|resume|stop|steer` — explicit lifecycle and existing-run commands.
- `/workflows-models` — configure `small`, `medium`, and `big` model tiers.
- `/deep-research`, `/code-review`, `/codebase-audit`, `/adversarial-review`, and `/multi-perspective`.
- Workflow-scoped Agent Teams with peer messages, inboxes, and a shared task board.
- Completed background subagents and the terminal workflow result are delivered to the main session as durable passive custom-history entries (they never enter Pi's Steering queue, and an active provider request is not cancelled); a single empty UI-only `workflows` marker wakes the model at a verified safe point.

The extension uses the stock Pi extension API and keeps compact start, active-list, output-wait, and exact-ID stop definitions registered. Its provider-visible prefix therefore stays stable for prompt caching; there is no per-turn tool lease or dynamic `setActiveTools` rewrite. The list returns only current-session running/paused handles. `get_workflow_output` is an event wait, not a status check: it waits without its own deadline for a durable subagent message, explicit message, terminal result, Esc, or queued user input. A steer/follow-up releases the tool at Pi's normal post-tool boundary so the user message can enter the ongoing agent loop; it does not stop the background workflow. Stop requires one exact ID. Other existing-run actions stay under `/workflows`; a new requirement is never routed into an unrelated run.

### Interjecting while work continues

A message entered with Pi's steering mode takes temporary priority over background updates. The footer shows `User message queued`, then `Replying to user`. The assistant answers the question or applies the correction before continuing unfinished work. A successful response containing visible text ends this temporary priority and clears the footer status; the user's requirements remain part of the conversation. Tool-only notifications, failed responses, and Esc do not count as an answer. Follow-up mode keeps Pi's normal after-the-current-turn behavior.

Each interjection has a session-persisted identity and its reply records an acknowledgement. Reloading the extension or pruning the provider context cannot re-arm an acknowledged interjection. The wait tool also shows how to interject or cancel; Esc cancels that wait without stopping the background run. See [the steering lifecycle design](docs/interactive-steering.md) for recovery and integration details.

## Requirements

- Node.js 22.19.0 or newer is recommended (matching the installed Pi's `engines` requirement).
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) version `0.84.2` or newer.
- The extension uses Pi's public extension API; no Pi core patch or fork is required.
- At least one authenticated model/provider configured in Pi.
- Git is optional, but required when a workflow requests `isolation: "worktree"`.

## Install from GitHub

Install globally for the current Pi user:

```bash
pi install git:github.com/YukiRa1n/pi-dynamic-workflows
```

For a reproducible installation, pin a release tag once tags are available:

```bash
pi install git:github.com/YukiRa1n/pi-dynamic-workflows@v3.5.1-yuki.5
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

Inside Pi, press `Alt+↓`, then navigate with `↑`/`↓` and `Enter`. The command fallback is:

```text
/workflows
```

Agent details use progressive disclosure: the first screen shows only status, model, task/current activity, errors, usage, and the final result. Press `Enter` to open Activity. Tool calls and their matching results are folded into one transaction block, while model output remains a separate block. In Activity, `↑`/`↓` moves by semantic block instead of wrapped text line; `Enter` expands or collapses the selected block, and `Esc` returns to the compact summary.

The live progress panel defaults to `compact` mode and the Unicode `auto` glyph skin. Use `/workflows-progress detailed` for phase/agent rows, `/workflows-progress max <1-1000>` to cap agents shown per phase (default 8), and `/workflows-progress icons ascii` when a terminal cannot reliably display Unicode tree glyphs. `/workflows-demo` (or `/workflows-demo live`) starts a real main-session demonstration: read a fixed sample, show an expected failed check, start two real subagents, receive their purple reports, and summarize. It consumes model tokens, leaves normal conversation/run history, and requires an idle main session; ordinary user interjections work during the demo. The sample does not modify project files. `/workflows-demo preview` retains the offline panel-only overlay without model calls. The panel is informational and non-capturing; `Alt+↓` opens the navigator, while ordinary arrow keys remain available to the editor.

The compact `start_workflow`, `list_active_workflows`, `get_workflow_output`, and `stop_workflow` tools are stable across turns. Start accepts a custom `script` or curated `preset`; list returns only current-session running/paused handles; output performs an event-driven next-output wait for an exact ID instead of polling; stop accepts one exact ID. Saved names, limits, replay, detailed inspection, pause, resume, and steering remain command/UI paths under `/workflows`.

#### Local request tracing

The local fork records workflow projection, final prepared provider payload, response status, and visible assistant output under `~/.pi/workflows/request-traces/`. `/workflow-trace status` shows this session's file and whether a final payload has been observed. `/workflow-trace off` disables collection until reload; `/workflow-trace on` enables it again. Tracing defaults to enabled in this diagnostic fork. Logs contain conversation and project text; credential fields, common bearer/API-key patterns, and opaque binary/reasoning blobs are omitted, but this is not a general secret scanner.

Each JSONL row carries a session ID, logger instance, request number, and stage. For `provider-request-prepared`, the `text` field contains the serialized request after all `before_provider_request` handlers. Parse that field as JSON when `truncated` is false. A projection record alone is not proof of final inclusion, and HTTP success is not proof that the model evaluated every report. Providers that bypass Pi's payload callback have no final-payload evidence and are reported as unobserved. Each session keeps one 16 MiB log and one rotation; payload text is capped at 8 MiB with an explicit truncation flag.

Final tracing requires the local Pi host patch in `scripts/patch-pi-request-trace.mjs`. Pass the installed `dist/core/extensions/runner.js` and the bundled chunk containing `emitBeforeProviderRequest` as explicit paths. The script retains adjacent `.request-trace-original` backups and rejects unknown method shapes. Package upgrades may replace the patch. Restart Pi after applying it; `/reload` alone cannot reload the bundled host. Wait for active workflows to finish before restarting.

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

Workflow tool runs are always backgrounded, so Pi remains usable while subagents run. Terminal results return automatically through the durable safe-point delivery queue; users can inspect progress with `/workflows`.

## Built-in workflow patterns

| Pattern | Example |
| --- | --- |
| Deep research | `/deep-research Compare two libraries using primary sources.` |
| Code review | `/code-review HEAD~3..HEAD` |
| Codebase audit | `/codebase-audit src "unsafe input handling" "missing error boundaries"` |
| Adversarial review | `/adversarial-review Check this migration plan for hidden failure modes.` |
| Multiple perspectives | `/multi-perspective "Should this service be split?" security operations architecture` |

The same patterns can be invoked through the `start_workflow` tool with `preset` and `args`.

## Writing a workflow

A workflow is constrained JavaScript orchestration code. Its first statement exports metadata and it must call `agent()` at least once:

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
| parallel | runtime-global | `parallel(thunks[] \| ...thunks) => Promise<Array<unknown \| null>>` | — |
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
| deliver | runtime-global | `deliver({ kind, message }) => Promise<void>` | `kind`: "blocker" \| "critical_finding" \| "finding" \| "decision" (required)<br>`message`: string (required) |
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
<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->

The generated table describes the full workflow authoring/library contract. The model-facing `start_workflow` surface is intentionally smaller: `script`, `preset`, and `args`. Programmatic embedders can opt into saved names, resource controls, and the separate `resumeFromRunId` compatibility path with `createWorkflowTool({ allowResume: true })`; the Pi extension never exposes those fields.

See the [workflow authoring guide](docs/workflow-authoring.md) for the generated capability contract and the packaged skill for detailed authoring instructions and examples:

```text
skills/workflow-authoring/
skills/workflow-patterns/
```

## Runtime behavior

- Workflow tool invocations always start in the background. Each live subagent final and the workflow terminal result normally return automatically through the durable safe-point delivery queue. `get_workflow_output` waits for the next delivery boundary and does not poll or replay earlier output. If a blocking wait already returned the terminal `completed` value, the duplicate automatic terminal notification is suppressed. Use the returned run ID with `/workflows status|watch|pause|resume|stop|steer <id>` for explicit inspection and lifecycle actions. A new user requirement starts in the main session or a fresh workflow; it is never sent to an existing unrelated run.
- `concurrency` is bounded by the runtime maximum.
- `maxAgents`, retry counts, per-agent timeouts, and optional token budgets can be set per run. Every workflow also has a finite logical wall-clock deadline (30 minutes by default, configurable up to 24 hours with `workflowTimeoutMs`).
- A deadline races the complete script frame, closes admission, and aborts cooperative provider attempts. It cannot interrupt a pending Promise or a microtask-starved event loop; late provider settlement is observed and bounded drain cleanup is best effort.
- Replay identity is run-scoped: provider context such as `cwd`, instructions, tools, and session is hashed once and included in each call key. Nested and retried calls cannot collide on a bare call index. A resumed workflow replays the unchanged completed prefix and runs changed/new calls live.
- Anthropic-compatible, non-worktree fan-out uses a short cache-warm gate: one compatible request leads, and followers are released when its first assistant response starts. Set `PI_CACHE_RETENTION=none` to disable the gate; `short` is the default and `long` keeps the warm window longer.
- `isolation: "worktree"` is fail-closed: if a Git worktree cannot be created, that agent does not silently edit the shared checkout.
- Completed subagent results, explicit child-to-parent `deliver({ kind, message })` messages, and the terminal workflow result are written as passive custom-history entries with `triggerTurn: false`; the only `triggerTurn: true` send is the single empty UI-only `workflows` marker fired at a verified safe point. Explicit messages use `finding`, `blocker`, `critical_finding`, or `decision`. Use `finding` for substantive intermediate evidence, applicability, uncertainty, or changed assumptions; it need not be urgent or require a visible user reply. Include the actual finding and its supporting context, not a receipt that a report exists. Receipt-only and unchanged progress messages belong in logs. Delivery does not abort an already-running provider request. A wait/status call alone does not retire the temporary report-review notice; a later reply or substantive tool action crosses that boundary. This is a processing heuristic, not proof of understanding.
- Explicit delivery admission is finite per run: at most 32 messages, 256 KiB of UTF-8 payload, and 8 messages per 10-second window. A rejected delivery reports `DELIVERY_BUDGET_EXCEEDED`; terminal lifecycle delivery is reserved and is never downgraded or displaced by an explicit burst.
- Automatic per-subagent finals are bounded, marked `[UNTRUSTED]`, and persisted to the same replayable delivery outbox used by terminal workflow results before their purple `workflow-agent-completed` message enters main-session history. They are enabled by default; set `streamAgentResults: false` to keep the legacy on-demand tool path. The notification and `get_workflow_output` share one reload-safe fingerprint cursor, so one result is never injected through both paths. Execution order is not used to guess that the last agent is the final product; the workflow's explicit return remains the terminal result.
- The workflow's explicit return value is the semantic terminal product. Its provider projection prioritizes conventional `report`, `synthesis`, `summary`, or `answer` fields and is bounded to 12,000 UTF-8 bytes by default (configurable via the `deliveredResultMaxChars` setting); omitted content remains in the persisted run.
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

Full subagent transcripts are in memory by default. Enabling `persistAgentSessions` stores full child sessions in Pi's session directory and may retain sensitive source or prompt material. Enable it only when that retention is desired. `PI_CACHE_RETENTION=none` is separate: it disables the Anthropic cache-warm gate, not durable workflow journals.

Accepted explicit deliveries and terminal notifications are written to the run's durable at-least-once outbox before safe-point submission. Delivery IDs remain stable across reloads and retries; provider-context projection is acknowledged at `before_provider_request`, while transport confirmation is best effort after the provider response. This provides stable-ID projection deduplication and durable at-least-once delivery, not provider-side or end-to-end exactly-once processing. Outbox records are removed after the generation-fenced acknowledgement on the normal provider-projection path; a terminal record already carried by a `completed` `get_workflow_output` result may be discarded explicitly instead. Uncertain sends remain replayable from the persisted run.

Resource admission is finite by default: each run allows at most 1,000 logical agents and 16 concurrent agents, each `parallel()`/`pipeline()` fan-out is capped at 10,000 items, logs are capped at 10,000 entries/2 MiB, provider prompts at 512 KiB, shared-store state at 2,048 keys/4 MiB, and one durable run record at 16 MiB. Team members/tasks/messages and paused in-memory snapshots also have bounded defaults. These are admission/retention failures, not truncation: complete durable results are either committed as native JSON or publication fails observably. Paused runs evicted from memory remain resumable from disk.

Before sharing run-state files or session files, inspect them separately. They are deliberately not part of this Git repository.

## Security notes

Pi packages execute with the current user's system permissions. Review extension source before installing any third-party package.

Additional boundaries:

- Workflow orchestration uses Node's `vm` for determinism and synchronous execution limits, **not as a hostile-code security sandbox**. Host-provided arguments are copied into the VM realm without host constructors, and injected bridge functions are wrapped in vm-realm closures so their `.constructor` chain and return values stay in-realm. Because these are best-effort guards rather than a proof, model-authored custom scripts passed to `start_workflow` are additionally statically audited before execution: the audit rejects constructs that defeat the in-realm guards (dynamic code execution via `eval`/`Function`, computed member access and `for...in` string-keyed reflection, literal `.constructor`/`.prototype`/`__proto__` member access, `__proto__` object keys, `import`, `with`, `globalThis`/`Reflect`/`Proxy`/`Object.*` cross-realm reflection, and free references to host-reachable globals), and blocks the tool call with a fix list. Audited scripts run without user confirmation; curated built-in `preset`s are not gated.
- The orchestration script cannot directly call `require`, import modules, or use nondeterministic `Date.now()`/`Math.random()` globals, but subagents can use whatever tools the host grants them. The static audit narrows script structure; it does not bound model behaviour, so run resource limits (agent count, concurrency, token budget) remain the cost guardrails.
- Built-in web fetch tools restrict protocols, credentials, redirects, private/local IP ranges, timeout, and response size. These controls reduce risk but do not make arbitrary web content trustworthy.
- Worktree isolation requires a Git repository and does not automatically merge changes.
- Review workflow prompts and model output before applying destructive changes.

## Commands

| Command | Purpose |
| --- | --- |
| `Alt+↓` | Open the run navigator; use arrows and Enter to inspect runs, phases, and agents. |
| `/workflows` | Command fallback for opening the run navigator (same as `/workflows ui`). |
| `/workflows list` | Print a text list of runs. |
| `/workflows run <prompt>` | Start a workflow explicitly. |
| `/workflows status <id>` | Inspect one run from the command/UI path. |
| `/workflows watch <id>` | Watch one run from the command/UI path. |
| `/workflows pause <id>` | Pause and journal a run. |
| `/workflows resume <id>` | Resume a paused/failed run. |
| `/workflows stop <id>` | Stop a run. |
| `/workflows rm <id>` | Delete a run record. |
| `/workflows steer <id> [kind] <message>` | Send an explicit same-task update to one exact run. |
| `/workflows save <name>` | Save the latest workflow as a reusable command. |
| `/workflows-models` | Configure model tiers. |
| `/workflows-progress compact\|detailed\|status` / `/workflows-progress max <1-1000>` / `/workflows-progress icons auto\|ascii` | Configure the live panel mode, per-phase agent cap, and tree glyph set. |
| `/effort off\|high\|ultra` | Set effort guidance for an explicitly requested workflow; it does not take over ordinary messages. |
| `/ultracode [off]` | Turn maximal-effort (ultracode) mode on, or off with `off`; alias for `/effort ultra`. |

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

This repository includes synchronized `src` and `dist` runtime surfaces together with its tests, generation scripts, and release checks. The current snapshot passes `npm run release:check`: TypeScript build, generated capability documentation, context-surface verification, the full unit suite, and publishable-package validation.

Provider-backed routing samples and authenticated end-to-end smoke tests remain environment-dependent and are reported separately from the deterministic release gate. Passing the local gate does not claim that every provider, operating system, or cross-process stress scenario has been certified.

## Attribution

This is a modified distribution based on [`QuintinShaw/pi-dynamic-workflows`](https://github.com/QuintinShaw/pi-dynamic-workflows), itself crediting Michael Livs' original project. The upstream code is distributed under the MIT License. This repository preserves the upstream copyright and license notices.

## License

MIT. See [LICENSE](./LICENSE).
