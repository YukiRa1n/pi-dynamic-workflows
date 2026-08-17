# Proposal: worker-process isolation for workflow scripts

**Status**: proposal, not scheduled. The current release ships the static
script audit (`src/workflow-script-gate.ts`) as the extension-level control;
this document scopes the end-state hardening for scripts that must be treated
as fully untrusted.

## Problem

Workflow scripts execute under `node:vm` in the host process. Two independent
gaps remain after the static audit:

1. **Prototype escape (host-realm code execution).** The audit removes every
   known static route to `fn.constructor` (computed member access, `for...in`,
   `__proto__`, dynamic code), and DETERMINISM_PRELUDE strips `.constructor`
   from injected globals at runtime. This is defence-in-depth, not a proof:
   a single missed exotic route (a future syntax addition, a parser
   discrepancy, a realm leak through a host object that reaches the VM
   through a path the bridge did not sanitize) reopens host-realm execution
   with the user's full permissions.
2. **Event-loop denial of service.** `runInContext`'s timeout bounds only the
   synchronous CPU segment. An async continuation that never yields
   (`while (true) {}` after an `await`) blocks the host's event loop until the
   run's wall-clock deadline kills the workflow — and because the workflow
   shares the process with the interactive session, the host UI freezes with
   it.

Process isolation removes both classes at once: a compromised or stuck
worker cannot touch host memory and cannot freeze the host loop.

## Non-goals

- Replacing the static audit. Audit stays as the first, cheap layer
  (sub-millisecond, structured fix lists for the model); the worker is the
  hard boundary behind it.
- Sandboxing subagents. `agent()` results already run under the host's own
  tool-permission system; this proposal isolates only the orchestration
  script.
- Supporting untrusted scripts in the library API surface. The worker is the
  extension's execution backend; embedders keep choosing their own policy.

## Design: whole-runtime worker with a single agent() bridge

The naive design — keep orchestration in the host and RPC each capability —
dies on the bridge surface. The runtime exposes 20 globals
(`WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings`), of which roughly
half are function-valued and several (`parallel`, `pipeline`) take thunks —
functions created *inside* the script that the host would have to call back
into. Crossing a process boundary with closures requires a full bidirectional
function-call protocol, which is the complexity this proposal exists to
avoid.

The workable shape inverts the ownership: **move the entire VM runtime —
script parsing, journal, replay, and orchestration loop — into the worker**,
and bridge exactly one primitive back to the host: `agent()`.

```
host process                          worker process
┌─────────────────────────┐  MessagePort  ┌──────────────────────────────┐
│ WorkflowManager         │◄─────────────►│ vm runtime (moved wholesale) │
│  - run lifecycle        │   length-      │  - parse/audit script        │
│  - model registry       │   prefixed     │  - journal + replay          │
│  - provider calls       │   frames       │  - parallel/pipeline/thunks  │
│  - agent() execution    │                │  - all capability globals    │
│  - token budgeting      │                │    except agent()            │
└─────────────────────────┘                └──────────────────────────────┘
```

- **Bridge surface**: one request/response channel
  (`{kind:"agent", prompt, options}` → `{kind:"result"|"error", ...}`),
  plus two control side-channels: `checkpoint` (journal bytes to persist in
  the host's run record) and `deliver` (explicit parent-facing messages).
  Everything else — args/cwd/process/console/log/phase — is closed-loop data
  that moves into the worker for free.
- **Thunks never cross**: `parallel([...])` thunks are created and invoked
  inside the worker; only the eventual `agent()` calls they make cross the
  channel.
- **DoS containment**: the host watchdogs the worker. Missed heartbeats or a
  wall-clock deadline → `worker.terminate()`; the host event loop is never
  at risk.
- **Escape containment**: a script that escapes the VM lands in a process
  whose only host capability is the MessagePort. It can forge agent requests
  — bounded by the host-side admission limits (agent count, concurrency,
  token budget) that are enforced per run regardless.

## Hard parts (cost drivers)

1. **Resume across processes.** The journal lives in the host's run record;
   the replay cache lives in the worker's orchestration loop. Resume must
   ship the prior journal into a fresh worker and guarantee the replayed
   prefix is byte-identical. The existing longest-unchanged-prefix semantics
   survive, but every cached entry's identity must round-trip through
   structured clone.
2. **Cancellation propagation.** `AbortSignal` cannot cross a process
   boundary. Host abort → message → worker sets an in-realm flag checked by
   the orchestration loop; a wedged worker is terminated outright. The
   half-state (host believes aborted, worker still running) must be fenced
   with generation counters the same way provider callbacks are today.
3. **`createTeam` semantics.** Team state (members, mailbox, tasks) is shared
   mutable state with side effects that are not journaled — the capability
   contract already flags "team calls rerun live on resume". In the worker
   model, team state must live in the host (it outlives a worker crash), so
   `createTeam` becomes a second bridged primitive with its own
   request/response surface. This is the single largest bridge addition and
   the reason the bridge is "one primitive plus teams", not "one primitive".
4. **Determinism across versions.** The worker and host must agree on the
   DETERMINISM_PRELUDE behaviour and the audit rules; a version skew between
   a persisted journal and a newer worker must fail closed (same policy as
   extension reload today).

## Milestones

| # | Deliverable | Exit criterion |
|---|-------------|----------------|
| 1 | Worker skeleton: VM runtime moved, `agent()` bridge only, no resume | Existing non-team orchestration tests pass against the worker backend |
| 2 | Cancellation + watchdog | A `while(true){}` continuation after `await` is killed without freezing a mock host loop |
| 3 | Journal/checkpoint bridging + cross-process resume | Resume tests pass; replayed prefix byte-identical |
| 4 | `createTeam` host-side state + bridge | Team workflows run and resume; crash-mid-team fences correctly |
| 5 | Feature-flag rollout (`PI_WORKFLOW_EXECUTOR=worker|vm`, default vm) | Release gate passes with both backends; soak on real sessions |

Estimated scope: 1–2 weeks of focused work; milestone 3 (resume) is the
usual schedule risk.

## Relationship to the shipped audit

| Layer | Blocks | Cost |
|-------|--------|------|
| Static audit (shipped) | Known escape syntax; host-global references | sub-ms per call |
| Resource ceilings (shipped) | Token/CPU fan-out regardless of intent | already enforced |
| Worker isolation (this proposal) | Unknown escape routes; event-loop DoS | process per run |

The audit remains load-bearing even with the worker: it keeps the model's
output inside a subset where resume/replay semantics are well-defined, which
the worker's journal depends on.
