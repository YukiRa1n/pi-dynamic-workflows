# Workflow authoring

Workflows are JavaScript orchestration programs executed by the `workflow` tool. The table below is generated from the extension's executable capability contract, so its names, signatures, options, and defaults match the installed runtime.

Use the packaged `workflow-authoring` skill for pattern selection, lifecycle rules, review and debugging guidance, and adaptable examples. Those explanations remain hand-written. Configured model routes and agent types are dynamic references; obtain their names and purposes from the active user or project context rather than this static page.

See [Workflow prompt guidance rationale](workflow-prompt-guidance-rationale.md) for the decision-by-decision record of prompt insertions, removals, and compactions. See [Workflow authoring evidence](workflow-authoring-evidence.md) for context measurements and the non-gating model-comprehension comparison.

## Supported capabilities

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

## Logical lifecycle deadline

Each workflow frame has a finite wall-clock deadline: 30 minutes by default, configurable up to 24 hours with the workflow tool's `workflowTimeoutMs` input. The deadline races the complete script frame, closes admission to new orchestration work, and aborts provider attempts that honor `AbortSignal`. A Promise race cannot interrupt a pending Promise or a microtask-starved event loop; abandoned provider promises remain observed and bounded drain cleanup is best effort. `node:vm` provides deterministic execution controls, not a hostile-code security boundary.

`deliver()` is explicit safe-point steering, not an inline or follow-up channel. Each run admits at most 32 explicit deliveries, 256 KiB total UTF-8 payload, and 8 deliveries per 10-second window; a budget rejection is observable to the workflow. Terminal lifecycle delivery has reserved priority. Accepted messages are persisted in a stable-ID outbox before submission, replayed across reloads, and retained after uncertain sends. `before_provider_request` acknowledges projection/inclusion only; provider transport acknowledgement is best effort, so the contract is durable at-least-once delivery with stable-ID projection deduplication, not provider-side exactly-once processing.

Finite resource defaults also bound fan-out (10,000 items per `parallel()`/`pipeline()` call), provider prompts (512 KiB), logs (10,000 entries/2 MiB), shared-store state (2,048 keys/4 MiB), team boards/inboxes, and durable run records (16 MiB). Admission rejects excess data before provider submission or durable publication; it never truncates complete results. Paused snapshots evicted from memory remain resumable from their persisted journal.
