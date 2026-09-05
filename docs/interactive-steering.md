# Interjection priority lifecycle

User steering interrupts the conversation at Pi's next message boundary. It does not cancel a provider request or stop a background workflow. Follow-up input retains Pi's after-turn queue semantics.

| State | Transition | Provider behavior |
| --- | --- | --- |
| Queued | Interactive/RPC steering input is accepted | Pi owns the real user queue; the footer shows `User message queued`. |
| Pending | Pi finalizes that user message | A UUID is persisted alongside its unchanged text. |
| In request | Context projection selects the pending ID; the payload hook or assistant stream starts | A temporary notice asks the model to address the interjection before background updates. |
| Acknowledged | That request finishes a `stop` or `toolUse` response with visible text | The assistant message records the request's IDs. The notice and footer priority end. |

An acknowledgement means that a visible response was emitted, not that a semantic evaluator proved the question fully answered. Thinking-only responses, tool-only notifications, errors, truncation, and aborts do not acknowledge input. A response cannot acknowledge another interjection that arrived after its request started. Repeating the same text creates a new identity.

Requirements remain in ordinary user history after acknowledgement. The notice asks the assistant to continue only unfinished work and to avoid repeating completed answers. Fresh user prompts retire the previous task's temporary priority. Multiple pending interjections are addressed together, with the latest correction taking precedence where they conflict.

## Recovery

Priority projection is read-only. The receipt is persisted with the actual assistant reply through Pi's `message_end` replacement API. On reload or context pruning, the extension reads receipts from the active session branch, including entries omitted from the provider context. Navigating to a branch before a receipt restores that branch's unanswered input; acknowledgement does not leak between branches or sessions.

Custom providers that omit `before_provider_request` associate their input IDs at the assistant's stream-start event. A context preview alone never acknowledges input. Legacy steering messages without UUIDs use a stable identity derived from their timestamp and content and infer completion from visible historical replies.

The existing settled-boundary wake handles a real user message stranded after Pi's last queue poll. Its empty UI-only marker is removed from provider context. Explicit abort, compaction, prompt preflight, and session navigation fence that wake.

## Verification and activation

`tests/workflow-steering-continuity.test.ts` covers request ownership, repeated text, tool notifications, provider failure, context pruning, branch navigation, and reply acknowledgement. `tests/workflow-steering-session.test.ts` uses real `createAgentSession`, the actual Pi queue and session persistence, and a deterministic local faux provider. It covers an interjection followed by a tool call, a background notification, and extension recreation. These tests make no external model requests.

The local fix was also exercised through the installed Pi 0.85.0 bundled CLI in RPC mode, with the complete workflow extension, isolated settings/session storage, and an offline faux provider. Four provider requests verified the initial task, prioritized interjection, tool continuation after acknowledgement, and a later background notification without renewed priority.

After updating this local checkout without changing the package version, exit and restart Pi once. `/reload` deliberately preserves an existing `WorkflowManager` of the same package version, including its old runtime methods. New processes load all corrected runtime and persistence code. Normal later reloads retain the new steering receipts.

Checkpoint identity version 4 distinguishes omitted defaults from all legal JSON values. A journal created with an older checkpoint identity conservatively misses at that checkpoint on the first resume; downstream work follows the existing changed-prefix replay policy.

## Design references

- [Pi agent loop](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts): steering is drained at response boundaries, with a separate follow-up queue.
- [LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts): identify suspended work explicitly, persist state, and make replayed side effects idempotent. This extension uses reply receipts rather than restarting an interrupted graph.
- [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): keep the active context focused. Priority instructions are temporary projections rather than permanent additions to user text or the system prompt.
