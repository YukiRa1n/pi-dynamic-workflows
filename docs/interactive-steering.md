# Follow-up priority lifecycle

`extensions/follow-up-priority.ts` is a standalone Pi extension. The workflow runtime does not install or own it. The package manifest loads priority handling before `extensions/workflow.ts`, so its provider-context cleanup and receipts remain independent of workflow execution.

The extension observes interactive/RPC input submitted while Pi is streaming:

- Steering is an interruption. Pending steering items rank newest-first.
- Follow-up input keeps Pi's after-turn semantics and FIFO ordering.
- All pending user items rank ahead of unrelated background updates once Pi delivers them.
- A newer item changes priority but never cancels an older unfinished item unless the user explicitly says to replace, cancel, or ignore it.

| State | Transition | Provider behavior |
| --- | --- | --- |
| Queued | Pi accepts steering or follow-up input | Pi owns the real user queue; the footer shows the queue count. Affected 0.84.x/0.85.x hosts need the compatibility patch below before this ownership is lossless across compaction rollback. |
| Pending | Pi finalizes the user message | A UUID and delivery kind are persisted beside unchanged user content. |
| In request | Context projection ranks unresolved IDs | Provider-only notices label each item independently and publish the current priority ledger. |
| Completed | A final `stop` response emits that ID's hidden completion receipt | The marker is stripped and the assistant message persists the acknowledged ID. |

## Todo and completion contract

When more than one user item is pending, or one item requires multiple tool steps, the provider notice asks the model to use `todowrite` or an equivalent Todo tool. The model maintains one entry per follow-up ID, includes its current priority, preserves unfinished entries, and updates status as work progresses. A direct one-line answer does not need a ceremonial Todo item.

Each pending message stays independent. Later text must not be treated as the description of an earlier image, file, or question unless the user explicitly links them. Before stopping, the model must answer each item or state its blocker and keep it pending.

Unresolved follow-ups and required attachments must not be compacted, summarized away, or passed to `ctx_reduce`. They become eligible for context reduction only after their completion receipt is durable.

Completion is explicit and per item. The model appends `<!-- pi-follow-up-done:ID -->` only after fully resolving that ID. The extension removes this hidden marker before display/persistence and records `followUpPriorityAcknowledged`. Ordinary visible prose, acknowledgements, plans, tool-use progress, errors, truncation, and aborts do not retire an item. A response can retire several IDs only by emitting one valid receipt for each.

## Recovery

Priority projection is read-only. User text and attachments are never rewritten in session history. On reload or context pruning, the extension rebuilds unresolved state from durable user identities and assistant receipts on the active branch. Navigating to a branch before a receipt restores that branch's unanswered item; acknowledgements do not leak between branches or sessions.

Legacy `workflowSteeringId` and `workflowSteeringAcknowledged` fields remain readable. New entries use the neutral `followUpPriorityId`, `followUpPriorityKind`, and `followUpPriorityAcknowledged` fields.

The settled-boundary wake handles a real user message stranded after Pi's last queue poll. Its empty UI-only marker is removed before provider conversion. Explicit abort, compaction, prompt preflight, and session navigation fence that wake.

### Host admission boundary

Semantic receipts start only after Pi emits the finalized user message. During compaction, Pi 0.84.x/0.85.x first stores editor input in its private `compactionQueuedMessages` array, before extension `input` or `message_end` hooks can assign a follow-up ID. The affected host's rollback clears unrelated live queues and replaces the current compaction queue with an obsolete snapshot. No prompt projection or completion receipt can recover an item erased at that earlier boundary.

Run `npm run patch:pi-compaction` from the repository to apply the fail-closed compatibility patch to the global Pi installation. It changes the dispatch commit point to prompt preflight acceptance, restores only the failed and undispatched suffix, prepends that suffix to concurrent compaction input, and never calls `session.clearQueue()` from this local rollback. Fully restart Pi afterwards.

## Verification and activation

`tests/workflow-steering-continuity.test.ts` covers dynamic ranking, Todo guidance, per-ID receipts, repeated text, failures, queue recovery, legacy fields, branch navigation, and hidden marker removal. `tests/workflow-steering-session.test.ts` uses real `createAgentSession`, Pi's actual queue/session persistence, and a deterministic local faux provider. It verifies that tool-use progress does not retire a follow-up and that only the final explicit receipt does.

Restart Pi once after updating a checkout that previously embedded this behavior in `extensions/workflow.ts`. Normal later `/reload` operations load both extension resources from the package manifest.

## Design references

- [Pi agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts): steering is drained at response boundaries, with a separate follow-up queue.
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts): identify suspended work explicitly, persist state, and make replayed side effects idempotent.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): keep active context focused; priority instructions are temporary projections rather than permanent changes to user text.
