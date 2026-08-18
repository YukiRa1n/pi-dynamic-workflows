# Changelog

All notable changes to `@quintinshaw/pi-dynamic-workflows` are documented here.

## [Unreleased]

### Added

- Added `get_workflow_output`, an interruptible one-shot lifecycle wait for an exact current-session run ID. It returns bounded terminal output and replaces repeated `list_active_workflows` plus shell-sleep polling. Esc cancels only the wait; the workflow continues in the background.

### Fixed

- Fixed concurrent SharedStore rollback so failed interleaved writers cannot restore another failed writer's value or diverge from the durable journal.
- Fixed run deletion ordering so a primary-record unlink failure preserves its backup and live lease; worktree startup reaping now preserves a healthy checkout even when stale-marker cleanup fails.
- Hardened IPv6 SSRF filtering with binary longest-prefix matching for special-purpose, translated, tunneled, deprecated site-local, and non-global address space.
- Corrected the executable capability contract and generated authoring reference to describe worktree isolation as fail-closed.
- Hardened model/provider trust boundaries with bounded output, credential and path redaction, terminal-control sanitization, provider-safe tool-call IDs, and explicit untrusted-content labels for workflow and web results.
- Added fail-closed validation for workflow inputs, model routing, persisted toolsets, and scheduler limits; replaced workflow managers now detach delivery listeners and release lifecycle resources.

### Verification

- `npm test` release gate passed with 1,431 tests and zero release-gate warnings.

## [3.5.1-yuki.4] - 2026-08-19

This fork-only patch release hardens background workflow delivery against interactive aborts and provider round-trips. All changes are extension-side in `extensions/workflow.ts`; no host modifications.

### Fixed

- **Esc recovery preserves custom role and payload.** Pressing Esc no longer downgrades queued workflow deliveries to plain `role:"user"` text. An input interceptor matches Esc-restored editor text by content fingerprint and restores the original `custom` message with its `customType`, `details`, and `deliveryId` intact. (ff9ad8c)
- **Stopped the Esc resend storm.** Previously a provider-error abort followed by Esc created a settled→auto-drain→abort loop that resent the same delivery on every keystroke. Settled-side fencing now classifies evidence into three buckets — seen-and-discarded (never resend), silently-dropped (recover but never auto-wake), already-projected (leave to watchdog) — and `agent_settled` no longer auto-drains. (557a05d)
- **Batched queued deliveries into one custom message.** Multiple pending workflow completions now merge into a single `custom` batch with per-item `[run / kind / seq N]` partitions, occupying one turn instead of N. Members restore individually on abort. (557a05d)
- **Hardened delivery across output waits and aborts.** (02a056f)
- **Split transport ack from context consumption.** A provider `2xx` now only stops outbox resends; it no longer implies the model consumed the body. Consumption requires an actual assistant `stop` with text. (8cad36d)
- **Removed speculative consumption.** The `stop+text` heuristic that permanently dropped delivery bodies from projection (so a model answering "the count is 6" erased the underlying findings) is gone. Bodies now project until host compaction; there is no "semantically consumed" state. (c7e9869)
- **Gated wake behind a single safe entry with abort-epoch fencing.** One UI-only hidden marker (`customType:"workflows"`, empty content, `triggerTurn:true`) is the only automatic wake. A stable per-delivery ordinal plus an Esc abort-epoch cutoff prevent fenced IDs from waking, while still letting them project on later legitimate requests. Settle-attribution tokens stop a real run's `agent_settled` from releasing a marker's in-flight latch. Provider-consumed bodies that fail durable ack park for reconcile instead of re-waking. (a78ccc6)

### Verification

- `npm test` release gate passed with 1,431 tests and zero release-gate warnings.

## [3.5.1-yuki.3] - 2026-08-16

### Added

- Added the stable model-facing `start_workflow` tool. It starts a new background run from JavaScript or one of five curated presets.
- Added `list_active_workflows` and exact-ID `stop_workflow`. The list returns at most 64 running or paused handles owned by the current Pi session.
- Added `/workflows steer <id> [same_task_correction|blocker_answer|changed_fact] <message>` for explicit, classified updates to an existing run.
- Added bounded Anthropic-compatible fan-out cache warming. Use `PI_CACHE_RETENTION=none` to disable the warm gate without disabling durable replay.
- Extended `parallel()` to accept variadic thunks. Added public resource-coordination, routing-evidence, steering, and detailed worktree-cleanup APIs.

### Changed

- The default extension keeps the compact start, list, and stop tool definitions stable across turns. Keyword arming now adds a short request marker instead of changing Pi's active tool set.
- New requirements start fresh work or remain in the main session. Detailed inspection, watch, pause, resume, stop, and steering actions use `/workflows` with an exact run ID.
- Background completion and failure results use a durable safe-point delivery path. Delivery does not cancel an in-flight provider request, and routine subagent results remain in workflow state and the UI.
- Pause and resume retain each run's original execution settings. Model selection now uses a documented precedence order and rejects unavailable explicit selectors with `MODEL_NOT_FOUND`.
- Workflow subagents no longer load host extensions. They keep user and project skills plus workflow-supplied tools, while recursive orchestration tools remain unavailable.

### Fixed

- Hardened classified and terminal delivery across reloads, compaction, aborts, provider retries, session handoff, and persistence races. Failed durable transitions now requeue instead of reporting false success.
- Added run-scoped replay identity, nested execution boundaries, and generation fencing. Changed calls invalidate the remaining replay suffix, while unchanged completed calls can replay.
- Added bounded resource admission, atomic persistence, revision fencing, leases, paused-run retention, and late-attempt handling. Stale executions cannot overwrite or release resources owned by a replacement generation.
- Added owner- and generation-fenced worktree claims, reclaim markers, startup cleanup, and branch tombstones. Cleanup preserves recoverable state when it cannot prove ownership.
- Scoped usage-limit recovery to the owning Pi session. Fixed `/reload` compatibility when Pi retains a workflow manager created before the current session accessor existed.

### Compatibility and migration notes

- The default extension no longer registers the legacy model-facing `workflow`, `workflow_control`, or `workflow_send` tools. Use the three compact tools for new work and cancellation. Use `/workflows` for other lifecycle actions.
- The model-facing start schema accepts only `script`, `preset`, and `args`. Programmatic `createWorkflowTool()` callers retain saved names and advanced limits. Set `allowResume: true` to enable edited-script resume.
- `createWorkflowControlTool` now accepts only `pause`, `resume`, and `stop`, each with an exact `runId`. Use manager or persistence APIs for programmatic inspection.
- Change `deliver(message)` to `await deliver({ kind, message })`. Valid kinds are `blocker`, `critical_finding`, and `decision`. Replace `workflow_send_to_parent` with `workflow_alert_parent`.
- Pass required host extension tools, such as MCP or browser tools, to workflow subagents explicitly. Child sessions no longer inherit these tools.
- Worktree paths and branches now include deterministic hash suffixes. `removeWorktree()` returns `Promise<boolean>`. Use `removeWorktreeDetailed()` when cleanup status is required.
- Delivery is durable at-least-once, not end-to-end exactly-once. `stop_workflow` requests cooperative cancellation and does not guarantee immediate provider termination.

### Verification

- `npm run release:check` passed with 1,316 tests and zero release-gate warnings.

[Unreleased]: https://github.com/YukiRa1n/pi-dynamic-workflows/compare/v3.5.1-yuki.3...HEAD
[3.5.1-yuki.3]: https://github.com/YukiRa1n/pi-dynamic-workflows/compare/v3.5.1-yuki.2...v3.5.1-yuki.3
[3.5.1-yuki.2]: https://github.com/YukiRa1n/pi-dynamic-workflows/releases/tag/v3.5.1-yuki.2
