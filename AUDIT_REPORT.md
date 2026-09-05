# Prioritized Audit Report: Pi Dynamic Workflows vs OMP `workflowz`

## Executive summary

This audit cross-validates the current Pi Dynamic Workflows worktree at commit `882ab62` against the installed OMP package `@oh-my-pi/pi-coding-agent` `18.0.6`.

The targeted Pi workflow/runtime and manager tests passed:

```text
214 tests passed
0 failed
```

No source changes were made as part of this audit. The most important conclusions are:

1. OMP `workflowz` is prompt guidance that routes the model toward `eval`; it is not a durable workflow runtime.
2. OMP does not provide Pi-equivalent durable checkpoint/replay for an eval/task workflow run.
3. Pi's `node:vm` execution must not be treated as a hostile-code security sandbox.
4. OMP eval fan-out and output handling have resource/backpressure gaps: total inputs are materialized without a unified cap, and output is truncated only after raw accumulation.
5. Pi and OMP `pipeline()` have materially different execution semantics and are not interchangeable.
6. Pi permits an undefined final workflow result when a script omits an explicit return; the contract should be made explicit.

The audit also corrects several over-broad claims. OMP does have persistence in adjacent systems, task concurrency is per `TaskTool`/session instance rather than universally process-global, and OMP does have final-output caps.

## Scope and evidence

| System | Revision/version | Scope |
|---|---|---|
| Pi Dynamic Workflows | `C:\Users\29594\Documents\pi-dynamic-workflows-public`, HEAD `882ab62` | Current dirty worktree, including modified `src`, `dist`, tests, docs, and configuration |
| OMP | `@oh-my-pi/pi-coding-agent` `18.0.6` | Installed package, including `workflowz`, eval, task, async, and provider-concurrency paths |

Validation performed:

```bash
node --import tsx --test --experimental-test-isolation=none \
  tests/workflow-runtime.test.ts tests/workflow-manager.test.ts
```

The OMP `workflowz` detector was also directly exercised with Bun.

## Priority-ranked findings

### P0 — Establish and enforce the script trust boundary

**Finding F-01: Pi's `node:vm` is not a security sandbox.**  
**Status:** Confirmed.

Pi's workflow scripts execute in the host process with the user's permissions. The VM supplies execution and determinism controls, but it does not isolate malicious or hostile code. This is explicitly documented in `src/workflow.ts:798-807`, `docs/workflow-authoring.md:46`, and `src/workflow-script-gate.ts:7`.

**Risk:** If untrusted workflow source can reach the runtime, VM escape is not the relevant threat model—the script already has host-process authority. Mislabeling the VM as a sandbox can lead to unsafe deployment and review decisions.

**Actionable recommendations:**

- Rename security-facing documentation to `VM execution isolation` or equivalent; reserve `sandbox` for a separately enforced boundary.
- Add a prominent runtime warning and an explicit trust precondition to the workflow authoring and API documentation.
- If hostile or multi-tenant scripts are a requirement, execute them in a separate OS/container/worker boundary with least-privilege credentials, filesystem/network policy, resource limits, and an independently enforced timeout.
- Add a release-gate check that rejects security claims describing `node:vm` as a security boundary.

**Acceptance evidence:** A documentation review confirms the trust model, and an untrusted-script deployment test demonstrates that execution occurs outside the host process before the feature is advertised for hostile input.

### P1 — Define the durability boundary for OMP eval/task workflows

**Finding F-02: OMP lacks Pi-equivalent durable workflow-run checkpoint and replay.**  
**Status:** Confirmed narrowly.

OMP persists sessions/conversations, parked-agent revival state, Vibe worker-session lifecycle, and artifacts. Those systems do not persist and replay an eval program's materialized task graph, stage checkpoints, batch cursor, or workflow-level journal equivalent to Pi's `runWorkflow()` / `WorkflowManager`. `AsyncJobManager` stores live jobs and deliveries in process-local `Map` instances (`src/async/job-manager.ts:137-157`), so process restart loses that live registry and delivery state.

**Risk:** A process interruption can require re-running or manually reconstructing an eval batch. Session revival is not equivalent to replaying completed stages and delivery decisions.

**Actionable recommendations:**

- Document OMP `workflowz` as a best-effort orchestration path unless durable run recovery is added.
- Define a durable run model with a stable run ID, immutable input/stage definitions, materialized item IDs, stage checkpoints, batch cursor, attempt state, output/artifact references, and terminal status.
- Persist idempotency keys and completion records before acknowledging stage results; use an outbox or equivalent for delivery side effects.
- On startup, reconcile non-terminal runs and resume only from the longest verified unchanged prefix; quarantine ambiguous or partially delivered work for review.
- Add crash/restart tests during fan-out, between pipeline stages, during delivery, and during nested-agent execution.

**Acceptance evidence:** A killed-process test resumes an interrupted batch without duplicating completed side effects, and the run record identifies the last durable checkpoint and all replay decisions.

### P1 — Add bounded admission and streaming backpressure to eval fan-out

**Finding F-03: OMP materializes all eval inputs without a unified total-item cap.**  
**Status:** Confirmed.

The eval prelude starts with `Array.from(items ?? [])` (`src/eval/js/shared/prelude.txt:141-145`). Active workers are limited by `task.maxConcurrency`, but `parallel()` and `pipeline()` have no corresponding unified maximum materialized-item limit. Pi explicitly caps fan-out items, agents per run, and concurrency (`src/config.ts:5-8,52-53`; `src/workflow.ts:2137-2140,2192-2197`).

**Risk:** Large or adversarial iterables can cause high memory use before worker concurrency limits take effect. A finite worker count does not bound the input array or associated metadata.

**Actionable recommendations:**

- Introduce a single configurable maximum total item count, enforced before or during iteration; fail closed with a clear diagnostic when exceeded.
- Prefer bounded/streaming iteration over `Array.from` where the API allows it.
- Apply the limit consistently to `parallel`, `pipeline`, nested task fan-out, and retries; define whether retries consume item budget.
- Expose admission counters: accepted, rejected, active, completed, retried, and peak buffered items.
- Add tests for oversized arrays, lazy infinite iterables, nested fan-out, and simultaneous sessions.

**Acceptance evidence:** Peak buffered-item count remains within the configured bound under large and lazy inputs, and an over-limit run stops admission without creating unbounded pending work.

### P1 — Make output caps true resource controls, not only presentation limits

**Finding F-04: OMP truncates output after raw accumulation.**  
**Status:** Confirmed.

OMP defines `MAX_OUTPUT_BYTES = 500_000` and `MAX_OUTPUT_LINES = 5,000` (`src/task/types.ts:41-56`). The executor accumulates output in arrays (`src/task/executor.ts:1069-1071,1617-1618`) and applies `truncateTail()` only at finalization (`src/task/executor.ts:2220-2225`). Artifacts are written from `rawOutput` (`src/task/executor.ts:2237-2245`).

**Risk:** Final returned output is capped, but peak memory, raw artifact size, and intermediate growth are not. High-volume tasks can therefore exhaust resources before final truncation.

**Actionable recommendations:**

- Enforce byte/line limits while receiving output, not only at finalization.
- Stream output to bounded buffers or spill files with quotas; discard or summarize excess data according to an explicit policy.
- Apply the same cap to artifact writes and intermediate merge buffers; never write uncapped `rawOutput` by default.
- Preserve metadata indicating truncation, discarded byte/line counts, and artifact policy.
- Add tests with output exceeding each cap during long-running execution and verify bounded peak memory and artifact size.

**Acceptance evidence:** Instrumented runs show bounded in-memory and artifact growth, and consumers can distinguish complete output from capped output.

### P1 — Treat `pipeline()` as a compatibility contract

**Finding F-05: Pi and OMP `pipeline()` semantics differ materially.**  
**Status:** Confirmed.

Pi processes each item through all stages serially while items run concurrently:

```text
item 1: stage A -> stage B -> stage C
item 2: stage A -> stage B -> stage C
```

(See `src/workflow.ts:2182-2229`.) OMP applies each stage to the whole batch before advancing to the next stage (`src/eval/js/shared/prelude.txt:175-181`):

```text
all items: stage A
barrier
all items: stage B
barrier
all items: stage C
```

**Risk:** Porting a workflow between systems can change ordering, visibility of side effects, latency, and failure/retry behavior. This is a behavioral incompatibility, not an implementation detail.

**Actionable recommendations:**

- Document the two contracts using distinct names or explicit execution-mode options.
- Do not claim OMP/Pi pipeline compatibility without selecting and testing a semantic target.
- Add conformance tests covering stage-side effects, item ordering, partial failure, retry, cancellation, and inter-item dependencies.
- If parity is required, implement an item-major mode or provide a migration adapter with explicit barriers and ordering guarantees.

**Acceptance evidence:** A shared fixture produces the documented event trace in each mode, and migration documentation lists any changed guarantees.

### P1 — Correctly classify OMP `workflowz`

**Finding F-06: OMP `workflowz` is guidance/routing, not an independent workflow runtime.**  
**Status:** Confirmed, with scope qualification.

`src/modes/workflow.ts` detects only the standalone lowercase prose keyword and appends hidden workflow guidance when both `task` and `eval` are active. The notice directs the model to orchestrate through `eval`; it does not create a Pi-style workflow object, run ID, manager, journal, or execution graph.

Observed detector behavior:

| Input | Detects |
|---|---:|
| `workflowz` | Yes |
| `please workflowz audit` | Yes |
| `Workflowz` | No |
| `workflowzed` | No |
| `workflowz.ts` | No |
| `` `workflowz` `` | No |
| `<x>workflowz</x>` | No |

The precise description is: **OMP's `workflowz` feature is a routing/guidance mechanism into model-generated eval code, not a durable workflow runtime.**

**Risk:** Users may infer lifecycle, isolation, persistence, replay, or capability guarantees from the keyword that are actually supplied by the separately configured task/eval executor.

**Actionable recommendations:**

- Replace runtime/product language implying that `workflowz` creates a workflow engine.
- Document the gating conditions (`task` and `eval`) and the exact detector contract, including case and token-boundary behavior.
- Present durable execution, isolation, and capability controls as separate properties that must be verified independently.
- Add user-visible diagnostics or tracing showing when guidance was injected and which runtime actually executed the eval.

**Acceptance evidence:** Documentation and UI distinguish guidance from execution, and tests cover detector boundaries plus inactive-tool gating.

### P2 — Clarify the final-result contract

**Finding F-07: Pi can complete with `result.result === undefined` when the script omits a return.**  
**Status:** Confirmed observable behavior; contract/documentation risk, not automatically a defect.

`tests/workflow-runtime.test.ts:298-325` executes `await agent('work')` without returning the value and asserts `result.result` is `undefined`. Pi drains un-awaited agents before completion, and those calls are journaled and replayed. The persistence validator rejects undefined journal-entry results (`src/run-persistence.ts:457-463`), but that does not establish that every final workflow result must be defined.

**Risk:** Callers may confuse successful completion with a missing result, or assume persistence rejects a script that has no explicit final value.

**Actionable recommendations:**

- Choose and document one contract: explicitly permit `undefined`, or require a defined return value.
- If undefined remains valid, expose completion status separately from result presence and add examples.
- If a defined result is required, validate at workflow completion and return a diagnostic naming the missing return.
- Add tests for explicit `undefined`, omitted return, falsy values, thrown errors, and replayed completion.

**Acceptance evidence:** API types, authoring docs, and runtime tests agree on the chosen contract.

## Deferred or targeted-test items

These items should remain qualified rather than being reported as confirmed defects:

- **OMP `async.maxJobs`:** queued registrations do not consume an active slot until `markRunning()`. This confirms an admission-boundary design nuance, but not a proven running-job-limit breach. Add an integration test around the caller-managed gate before escalating.
- **Provider promises that ignore cancellation:** both systems propagate abort signals, but no available evidence demonstrates a permanent provider hang. Treat this as an architectural limitation and test with a deliberately non-cooperative provider.
- **Pi synchronous persistence performance:** caching, throttling, coalesced writes, and bounded-write tests are present. Benchmark under representative load before making a performance finding.
- **Pi source/dist consistency:** the worktree contains modified source and distribution artifacts, but that only proves a dirty release state. Build and compare generated output before reporting a mismatch.

## Claims explicitly excluded or narrowed

The following claims are not supported by the evidence and should not appear in the final audit:

- `workflowz` directly grants child-agent tools, isolation, or provider capabilities.
- OMP has no persistence whatsoever.
- OMP task concurrency is process-global.
- OMP provider concurrency is universally capped.
- Queued async registration definitely exceeds the running-job limit.
- Pi persistence rejects every undefined workflow result.
- OMP has no output cap.
- Pi's VM is a secure sandbox.

## Remediation sequence and feedback controls

### Phase 1: contain interpretation and security risk

1. Correct `workflowz` and VM terminology in user-facing documentation.
2. Add explicit trust-boundary warnings and release-gate checks.
3. Freeze claims of Pi/OMP semantic parity until the pipeline conformance fixture passes.

### Phase 2: bound resource use

1. Add total-item admission limits and streaming/bounded buffering to eval fan-out.
2. Enforce output limits during collection and artifact writing.
3. Instrument accepted/rejected/buffered items, peak output bytes/lines, artifact bytes, and cancellation duration.

### Phase 3: add durability where required

1. Decide whether OMP eval workflows require durable recovery or are explicitly best effort.
2. If required, implement the run/checkpoint/outbox model described in F-02.
3. Verify crash recovery, duplicate delivery, stale ownership, nested execution, and rollback while work is in flight.

### Control sheet

| Element | Audit recommendation |
|---|---|
| Boundary | Pi workflow runtime and OMP eval/task orchestration; adjacent OMP session/Vibe persistence is supporting context, not workflow-run durability |
| Controlled variables | Trusted execution, bounded memory/output, correct pipeline behavior, and recoverable workflow state |
| Reference | No hostile script runs in the host process; item/output buffers stay under configured caps; pipeline mode is explicit; non-terminal runs have durable checkpoints when durability is promised |
| Sensors | Detector traces, run/checkpoint records, accepted/active/buffered item counters, output/artifact byte and line counters, crash/restart and conformance test traces |
| Comparator | Any trust-boundary ambiguity, cap breach, undocumented semantic deviation, duplicate side effect after restart, or missing checkpoint is a release-blocking signal for the affected capability |
| Actuators | Documentation correction, admission rejection, bounded streaming/spill, explicit pipeline mode, checkpoint/replay, quarantine, or rollback |
| Disturbances | Hostile scripts, unbounded/lazy input, large output, process restart, provider delay, cancellation during cleanup, partial delivery, and nested fan-out |
| Containment | Disable untrusted-script use and durable-workflow claims; reject over-limit runs; stop rollout if conformance or restart tests fail |

## Verification plan

Before closing these findings, run the smallest tests that close the evidence gaps:

1. **Trust test:** attempt a host-sensitive operation from a workflow script and verify the documented execution boundary.
2. **Restart test:** kill the process at each checkpoint boundary and verify no duplicate committed side effects.
3. **Fan-out test:** feed an oversized and a lazy/infinite iterable; inspect peak buffered items and admission behavior.
4. **Output test:** exceed byte and line caps during execution; inspect peak memory, raw buffers, and artifact size.
5. **Pipeline test:** compare event traces for item-major and stage-major execution under side effects and partial failures.
6. **Cancellation test:** use a provider that ignores abort and record whether the system enters a bounded degraded state rather than claiming forced settlement.
7. **Async gate test:** register many queued jobs and measure actual simultaneous running jobs before making a breach claim.

Each test should record the observed value, configured threshold, decision, action, and correlation/run ID. Findings should be downgraded or closed only after the relevant measurement delay has elapsed and the result is reproducible.
