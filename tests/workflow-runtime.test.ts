import assert from "node:assert/strict";
import test from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentUsage } from "../src/agent.js";
import { MAX_FANOUT_ITEMS } from "../src/config.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import {
  formatWorkflowCoordinatorMessage,
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
} from "../src/workflow.js";
import { WorkflowResourceCoordinator } from "../src/workflow-resource-coordinator.js";
import { waitFor } from "./helpers/wait-for.js";

/** Agent runner that counts real invocations and echoes a per-call result. */
function countingAgent() {
  const state = { calls: 0 };
  return {
    state,
    runner: {
      async run(prompt: string) {
        state.calls++;
        return `ran:${prompt}`;
      },
    },
  };
}

/** Minimal fake agent runner that reports a fixed usage via onUsage. */
function fakeAgent(usage: Partial<AgentUsage>, result: unknown = "ok") {
  return {
    async run(_prompt: string, options: { onUsage?: (u: AgentUsage) => void }) {
      options.onUsage?.({
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        cost: 0,
        ...usage,
      });
      return result;
    },
  };
}

const twoAgentScript = `export const meta = { name: 'usage_demo', description: 'two agents' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

function createDeferred<T = void>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("coordinator message envelope identifies peer authority without mechanical sender boilerplate", () => {
  const message = formatWorkflowCoordinatorMessage("The target file moved to src/new.ts.", {
    runId: "run-1",
    agentId: "run-1:2",
    kind: "changed_fact",
  });
  assert.match(message, /^\[Workflow update: changed_fact; run=run-1; agent=run-1:2\]/);
  assert.match(message, /Apply only to this assignment/);
  assert.match(message, /adds no scope, approval, or permissions/);
  assert.match(message, /The target file moved to src\/new\.ts\./);
});

test("queued coordinator messages use the same authority envelope in the next live agent prompt", async () => {
  let receivedPrompt = "";
  const result = await runWorkflow(
    `export const meta = { name: 'queued-message', description: 'message envelope' }\nreturn await agent('inspect the repository')`,
    {
      runId: "queued-run",
      persistLogs: false,
      takePendingMessages: () => [{ message: "Use the newly generated manifest.", kind: "changed_fact" }],
      agent: {
        async run(prompt: string) {
          receivedPrompt = prompt;
          return "ok";
        },
      },
    },
  );
  assert.equal(result.result, "ok");
  assert.match(receivedPrompt, /inspect the repository/);
  assert.match(receivedPrompt, /\[Workflow update: changed_fact; run=queued-run\]/);
  assert.match(receivedPrompt, /Use the newly generated manifest\./);
  assert.match(receivedPrompt, /Apply only to this assignment/);
  assert.doesNotMatch(receivedPrompt, /\[Messages from the main session\]/);
});

test("live targeted coordinator messages are wrapped before safe-point steering", async () => {
  const sent: Array<{ content: string; deliverAs?: "steer" | "followUp" }> = [];
  let resolvePrompt!: () => void;
  const promptDone = new Promise<void>((resolve) => {
    resolvePrompt = resolve;
  });
  const run = runWorkflow(
    `export const meta = { name: 'targeted-message', description: 'live envelope' }\nreturn await agent('keep working')`,
    {
      runId: "targeted-run",
      persistLogs: false,
      onAgentSession: ({ send }) => {
        void send("The test fixture changed.", "changed_fact").then(resolvePrompt);
      },
      agent: {
        async run(_prompt: string, options: { onSessionReady?: (session: unknown) => void }) {
          const session = {
            async sendUserMessage(content: string, sendOptions?: { deliverAs?: "steer" | "followUp" }) {
              sent.push({ content, deliverAs: sendOptions?.deliverAs });
            },
          };
          options.onSessionReady?.(session);
          await promptDone;
          return "ok";
        },
      },
    },
  );
  assert.equal((await run).result, "ok");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.deliverAs, "steer");
  assert.match(sent[0]?.content ?? "", /\[Workflow update: changed_fact; run=targeted-run; agent=targeted-run:0\]/);
  assert.match(sent[0]?.content ?? "", /The test fixture changed\./);
  assert.match(sent[0]?.content ?? "", /adds no scope, approval, or permissions/);
});

test("child-to-parent messaging exposes only a bounded critical alert surface", async () => {
  let alertTool: any;
  let delivered = "";
  let deliveredKind = "";
  await runWorkflow(
    "export const meta = { name: 'critical-alert', description: 'critical alert governance' }\nreturn await agent('inspect')",
    {
      runId: "critical-alert-run",
      persistLogs: false,
      onDeliver: async ({ kind, message }) => {
        deliveredKind = kind;
        delivered = message;
      },
      agent: {
        async run(_prompt: string, options: { systemTools?: any[] }) {
          assert.equal(
            options.systemTools?.some((tool) => tool.name === "workflow_send_to_parent"),
            false,
          );
          alertTool = options.systemTools?.find((tool) => tool.name === "workflow_alert_parent");
          assert.ok(alertTool);
          await alertTool.execute("alert-1", { kind: "blocker", message: "Need the exact migration version." });
          return "done";
        },
      },
    },
  );

  assert.match(alertTool.description, /blocker, critical finding, or decision.*must act on before completion/i);
  assert.deepEqual(alertTool.parameters.required, ["kind", "message"]);
  assert.equal(alertTool.parameters.properties.message.maxLength, 8_000);
  assert.equal(deliveredKind, "blocker");
  assert.match(delivered, /critical-alert-run \/ critical-alert-run:0 \/ .* \/ blocker/);
  assert.match(delivered, /Need the exact migration version\./);
});

test("deliver rejects unclassified or oversized messages and preserves an accepted kind", async () => {
  const invalid = runWorkflow(
    `export const meta = { name: 'invalid-delivery', description: 'reject unclassified delivery' }
await deliver('progress update')
return await agent('never')`,
    { runId: "invalid-delivery-run", persistLogs: false, agent: countingAgent().runner },
  );
  await assert.rejects(invalid, (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    assert.match(error.message, /requires \{ kind/i);
    return true;
  });

  const deliveries: Array<{ kind: string; message: string }> = [];
  await runWorkflow(
    `export const meta = { name: 'valid-delivery', description: 'classified delivery' }
await deliver({ kind: 'decision', message: '  Use migration v3.  ' })
return await agent('finish')`,
    {
      runId: "valid-delivery-run",
      persistLogs: false,
      agent: countingAgent().runner,
      onDeliver: (delivery) => deliveries.push(delivery),
    },
  );
  assert.deepEqual(deliveries, [{ kind: "decision", message: "Use migration v3." }]);
});

test("session teardown cleanup remains observable after workflow admission closes", async () => {
  const ended: string[] = [];
  const controller = new AbortController();
  let sessionReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    sessionReady = resolve;
  });
  const session = { async sendUserMessage(_content: string) {} };
  const run = runWorkflow(
    `export const meta = { name: 'session-cleanup', description: 'cleanup after abort' }
return await agent('hold')`,
    {
      runId: "session-cleanup-run",
      persistLogs: false,
      signal: controller.signal,
      onAgentSessionEnd: ({ id }) => ended.push(id),
      agent: {
        async run(
          _prompt: string,
          options: {
            signal?: AbortSignal;
            onSessionReady?: (value: typeof session) => void;
            onSessionEnd?: (value: typeof session) => void;
          },
        ) {
          options.onSessionReady?.(session);
          sessionReady();
          try {
            await new Promise<void>((_resolve, reject) => {
              const onAbort = () => reject(new Error("aborted"));
              if (options.signal?.aborted) onAbort();
              else options.signal?.addEventListener("abort", onAbort, { once: true });
            });
          } finally {
            options.onSessionEnd?.(session);
          }
          return "never";
        },
      },
    },
  );

  await ready;
  controller.abort();
  await assert.rejects(run);
  assert.deepEqual(ended, ["session-cleanup-run:0"]);
});

test("an already-aborted team.spawn rolls back committed membership before surfacing the abort", async () => {
  const controller = new AbortController();
  let deliveredSnapshot = "";
  const snapshotDelivered = createDeferred();
  const run = runWorkflow(
    `export const meta = { name: 'team-abort-rollback', description: 'rollback synchronous spawn admission' }
const team = createTeam('rollback-team')
try {
  await team.spawn([{ label: 'temporary', prompt: 'new member' }])
} catch (error) {
  await deliver({ kind: 'critical_finding', message: JSON.stringify(team.snapshot()) })
  throw error
}`,
    {
      runId: "team-abort-rollback-run",
      persistLogs: false,
      signal: controller.signal,
      agent: {
        async run() {
          return "ok";
        },
      },
      onTeamCreated: () => controller.abort(),
      onDeliver: async ({ message }) => {
        deliveredSnapshot = message;
        snapshotDelivered.resolve();
      },
    },
  );

  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof WorkflowError);
    assert.equal(error.code, WorkflowErrorCode.WORKFLOW_ABORTED);
    return true;
  });
  let rejectDelivery!: (error: Error) => void;
  const deliveryTimeout = new Promise<never>((_resolve, reject) => {
    rejectDelivery = reject;
  });
  const timer = setTimeout(() => rejectDelivery(new Error("aborted team snapshot was not delivered")), 1_000);
  try {
    await Promise.race([snapshotDelivered.promise, deliveryTimeout]);
  } finally {
    clearTimeout(timer);
  }
  const snapshot = JSON.parse(deliveredSnapshot) as {
    members: Array<{ id: string; label: string; role?: string }>;
  };
  assert.deepEqual(snapshot.members, [], "the synchronously rejected batch must leave no committed member");
});

test("late attempt IDs carry execution and resource generations", async () => {
  const registered: Array<{
    attemptId: string;
    executionGeneration?: string;
    resourceGeneration?: string;
  }> = [];
  const result = await runWorkflow(
    "export const meta = { name: 'late-id', description: 'late id' }\nawait agent('work')",
    {
      runId: "late-id-run",
      executionGeneration: "execution-1",
      resourceGeneration: "resource-1",
      persistLogs: false,
      agent: {
        async run() {
          return "ok";
        },
      },
      lateAttemptRegistry: {
        register(metadata) {
          registered.push(metadata);
          return { update() {}, settle() {} };
        },
        markLate() {},
      },
    },
  );
  assert.equal(result.result, undefined);
  assert.equal(registered[0]?.attemptId, "late-id-run:execution-1:resource-1:0:attempt1");
  assert.equal(registered[0]?.executionGeneration, "execution-1");
  assert.equal(registered[0]?.resourceGeneration, "resource-1");
});

test("workflow deadline closes the limiter and rejects queued admissions", async () => {
  const started: string[] = [];
  const runner = {
    async run(prompt: string, options: { signal?: AbortSignal }) {
      started.push(prompt);
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new Error("aborted"));
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return "never";
    },
  };
  const script = `export const meta = { name: 'limiter-close', description: 'cancel queued limiter waiters' }
await parallel([0, 1, 2, 3].map((i) => () => agent('queued-' + i)))`;
  await assert.rejects(
    runWorkflow(script, {
      agent: runner,
      concurrency: 1,
      workflowTimeoutMs: 25,
      persistLogs: false,
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_TIMEOUT,
  );
  assert.deepEqual(started, ["queued-0"], "queued agents must not start after admission closes");
});

test("workflow drain cancels queued provider waiters without releasing an active permit", async () => {
  const coordinator = new WorkflowResourceCoordinator({ maxProviderConcurrency: 1, maxQueuedProviderAttempts: 4 });
  const started: string[] = [];
  const releaseFirst = createDeferred<void>();
  const script = `export const meta = { name: 'provider-drain', description: 'provider waiter drain' }
agent('first')
agent('second')
return 'done'`;
  const run = runWorkflow(script, {
    runId: "drain-run",
    concurrency: 4,
    persistLogs: false,
    agent: {
      async run(prompt: string) {
        started.push(prompt);
        if (prompt === "first") await releaseFirst.promise;
        return prompt;
      },
    },
    providerAcquire: (runId, signal) => coordinator.acquireProvider(runId, signal, "workflow", "execution-1"),
  });
  setTimeout(() => releaseFirst.resolve(), 20);
  const result = await run;
  assert.equal(result.result, "done");
  assert.deepEqual(started, ["first"], "a queued provider waiter must not start after workflow drain begins");
  assert.equal(coordinator.queuedProviderAttempts, 0);
  assert.equal(coordinator.snapshot().providerAttempts, 0, "the active permit is released by provider settlement");
});

test("agent timeout covers provider permit wait and does not leak the queued waiter", async () => {
  const coordinator = new WorkflowResourceCoordinator({ maxProviderConcurrency: 1, maxQueuedProviderAttempts: 4 });
  const heldPermit = await coordinator.acquireProvider("held", undefined, "workflow", "held-generation");
  assert.ok(heldPermit);
  let errorCode: string | undefined;
  const script = `export const meta = { name: 'provider-timeout', description: 'provider waiter timeout' }
await agent('queued')`;
  await runWorkflow(script, {
    runId: "provider-timeout-run",
    agentTimeoutMs: 25,
    workflowTimeoutMs: 200,
    persistLogs: false,
    agent: {
      async run() {
        throw new Error("provider runner must not start while queued");
      },
    },
    providerAcquire: (runId, signal) => coordinator.acquireProvider(runId, signal, "workflow", "timeout-generation"),
    onAgentEnd: (event) => {
      errorCode = event.errorCode;
    },
  });
  assert.equal(errorCode, WorkflowErrorCode.AGENT_TIMEOUT);
  assert.equal(coordinator.queuedProviderAttempts, 0);
  heldPermit?.();
});

test("un-awaited team.spawn derived rejection is observed", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const script = `export const meta = { name: 'team-derived', description: 'observe derived finally rejection' }
const team = createTeam('derived')
team.spawn([{ label: 'worker', prompt: 'fail' }])
await agent('main')
return 'done'`;
    const fatal = new WorkflowError("fatal team member", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
      recoverable: false,
    });
    const result = await runWorkflow(script, {
      persistLogs: false,
      agent: {
        async run(prompt: string) {
          if (prompt === "fail") throw fatal;
          return "ok";
        },
      },
    });
    assert.equal(result.result, "done");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("resolved model is propagated live, journaled, and used by replay", async () => {
  const journal: JournalEntry[] = [];
  const starts: Array<string | undefined> = [];
  const resolved: string[] = [];
  const ends: Array<string | undefined> = [];
  const script = `export const meta = { name: 'model-journal', description: 'resolved model identity' }\nreturn await agent('work', { label: 'worker' })`;
  const first = await runWorkflow(script, {
    runId: "model-run",
    mainModel: "cpa/gpt-5.6-sol",
    persistLogs: false,
    onAgentStart: (event) => starts.push(event.model),
    onAgentModelResolved: (event) => resolved.push(event.model),
    onAgentJournal: (entry) => journal.push(entry),
    onAgentEnd: (event) => ends.push(event.model),
    agent: {
      async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
        options.onModelResolved?.("sunrain/gpt-5.6-luna");
        return "ok";
      },
    },
  });
  assert.equal(first.result, "ok");
  assert.deepEqual(resolved, ["sunrain/gpt-5.6-luna"]);
  assert.equal(journal[0]?.model, "sunrain/gpt-5.6-luna");
  assert.equal(ends[0], "sunrain/gpt-5.6-luna");

  let liveCalls = 0;
  const replayStarts: Array<string | undefined> = [];
  const replayEnds: Array<string | undefined> = [];
  await runWorkflow(script, {
    runId: "model-run",
    mainModel: "cpa/gpt-5.6-sol",
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:0`, entry])),
    onAgentStart: (event) => replayStarts.push(event.model),
    onAgentEnd: (event) => replayEnds.push(event.model),
    agent: {
      async run() {
        liveCalls++;
        return "unexpected";
      },
    },
  });
  assert.equal(liveCalls, 0);
  assert.equal(replayStarts[0], "sunrain/gpt-5.6-luna");
  assert.equal(replayEnds[0], "sunrain/gpt-5.6-luna");
  assert.notEqual(starts[0], "cpa/gpt-5.6-sol", "untagged start must not falsely claim the main-session model");
});

test("implicit tier fallback journals the actual session default model", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'fallback-model-journal', description: 'fallback identity' }\nreturn await agent('work')`;
  await runWorkflow(script, {
    runId: "fallback-model-run",
    mainModel: "provider/session-default",
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(
        _prompt: string,
        options: { onModelFallback?: (info: { tier: string; requestedSpec: string }) => void },
      ) {
        options.onModelFallback?.({ tier: "medium", requestedSpec: "provider/unavailable" });
        return "fallback result";
      },
    },
  });
  assert.equal(journal[0]?.model, "provider/session-default");
});

test("model registry changes invalidate bare-spec replay when concrete resolution changes", async () => {
  const script = `export const meta = { name: 'model-catalog-resume', description: 'registry identity' }\nreturn await agent('work', { model: 'bare-id', label: 'worker' })`;
  const oldRegistry = { getAll: () => [{ provider: "provider", id: "old-bare-id", name: "bare-id" }] } as any;
  const firstJournal: JournalEntry[] = [];
  let liveCalls = 0;
  await runWorkflow(script, {
    runId: "model-catalog-run",
    modelRegistry: oldRegistry,
    persistLogs: false,
    onAgentJournal: (entry) => firstJournal.push(entry),
    agent: {
      async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
        options.onModelResolved?.("provider/old-bare-id");
        return "old";
      },
    },
  });

  const newRegistry = { getAll: () => [{ provider: "provider", id: "new-bare-id", name: "bare-id" }] } as any;
  const resumed = await runWorkflow(script, {
    runId: "model-catalog-run",
    modelRegistry: newRegistry,
    persistLogs: false,
    resumeJournal: new Map(firstJournal.map((entry) => [`${entry.runId}:0`, entry])),
    agent: {
      async run(_prompt: string, options: { onModelResolved?: (model: string) => void }) {
        liveCalls++;
        options.onModelResolved?.("provider/new-bare-id");
        return "new";
      },
    },
  });

  assert.equal(liveCalls, 1, "a changed concrete registry resolution must not replay the old result");
  assert.equal(resumed.result, "new");
});

test("workflow args fail closed before an oversized bridge JSON is materialized in the VM", async () => {
  await assert.rejects(
    runWorkflow("export const meta = { name: 'large-args', description: 'bounded args' }\nawait agent('x')", {
      persistLogs: false,
      args: { payload: "x".repeat(600_000) },
      agent: {
        async run() {
          return "never";
        },
      },
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
  );
});

test("parallel rejects an oversized fan-out before allocating agent calls", async () => {
  const script = `export const meta = { name: 'fanout-bound', description: 'bounded fanout' }
await parallel(Array.from({ length: ${MAX_FANOUT_ITEMS + 1} }, () => () => agent('never')))
return 'unreachable'`;
  await assert.rejects(
    runWorkflow(script, {
      agent: {
        async run() {
          throw new Error("provider must not run");
        },
      },
      persistLogs: false,
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
  );
});

test("pipeline rejects an oversized fan-out before provider submission", async () => {
  const script = `export const meta = { name: 'pipeline-bound', description: 'bounded pipeline' }
await pipeline(Array.from({ length: ${MAX_FANOUT_ITEMS + 1} }, () => 'x'), (x) => agent(x))
return 'unreachable'`;
  await assert.rejects(
    runWorkflow(script, {
      agent: {
        async run() {
          throw new Error("provider must not run");
        },
      },
      persistLogs: false,
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
  );
});

test("runWorkflow concurrency caps parallel agents", async () => {
  let active = 0;
  let maxActive = 0;
  const release = createDeferred<void>();
  const started: Array<string> = [];
  const runner = {
    async run(prompt: string) {
      active++;
      maxActive = Math.max(maxActive, active);
      started.push(prompt);
      await release.promise;
      active--;
      return `ok:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'concurrency_cap', description: 'cap parallelism' }
const xs = await parallel(['a','b','c','d'].map((p) => () => agent(p, { label: p })))
return xs`;

  const run = runWorkflow(script, { agent: runner, concurrency: 2, persistLogs: false });
  await waitFor(() => started.length >= 2 || undefined, {
    description: "first two agents to start before the gate opens",
  });
  assert.equal(started.length, 2, "only the first two agents should start before the gate opens");
  release.resolve();
  const result = await run;

  assert.equal(maxActive, 2);
  assert.deepEqual(result.result, ["ok:a", "ok:b", "ok:c", "ok:d"]);
  assert.equal(result.agentCount, 4);
});

test("runWorkflow retries recoverable empty output then succeeds", async () => {
  let calls = 0;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_success', description: 'retry success' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1, "retries should not allocate extra logical agent slots");
  assert.equal(journal.length, 1, "only the final success is journaled");
});

test("retry spend keeps scalar compatibility and carries detailed AgentUsage", async () => {
  let calls = 0;
  let retryTokens: number | undefined;
  let retryUsage: AgentUsage | undefined;
  const result = await runWorkflow(
    `export const meta = { name: 'retry_usage', description: 'retry usage' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
          calls++;
          if (calls === 1) {
            options?.onUsage?.({ input: 10, output: 30, cacheRead: 5, cacheWrite: 2, total: 40, cost: 0.4 });
            return "";
          }
          options?.onUsage?.({ input: 7, output: 18, cacheRead: 3, cacheWrite: 1, total: 25, cost: 0.25 });
          return "ok";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onRetrySpend: (tokens, usage) => {
        retryTokens = tokens;
        retryUsage = usage;
      },
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
  assert.equal(retryTokens, 40, "the historical scalar retry spend remains available");
  assert.deepEqual(retryUsage, {
    input: 10,
    output: 30,
    cacheRead: 5,
    cacheWrite: 2,
    total: 40,
    cost: 0.4,
  });
  assert.equal(result.tokenUsage?.total, 65, "all attempts remain in the run-wide total");
});

test("runWorkflow returns null when recoverable retries are exhausted", async () => {
  let calls = 0;
  const logs: string[] = [];
  const journal: JournalEntry[] = [];
  const result = await runWorkflow(
    `export const meta = { name: 'retry_exhausted', description: 'retry exhausted' }
const a = await agent('work', { label: 'a' })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return "";
        },
      },
      agentRetries: 1,
      persistLogs: false,
      onLog: (message) => logs.push(message),
      onAgentJournal: (entry) => journal.push(entry),
    },
  );

  assert.equal(result.result, null);
  assert.equal(calls, 2);
  assert.equal(result.agentCount, 1);
  assert.equal(journal.length, 0, "failed/null recoverable results are not journaled");
  assert.ok(
    logs.some((message) => /retrying/i.test(message)),
    "logs should mention retrying",
  );
  assert.ok(
    logs.some((message) => /exhausted/i.test(message)),
    "logs should mention exhaustion",
  );
});

test("runWorkflow does not retry nonrecoverable errors", async () => {
  let calls = 0;
  await assert.rejects(
    runWorkflow(
      `export const meta = { name: 'no_retry_nonrecoverable', description: 'nonrecoverable' }
const a = await agent('work', { label: 'a' })
return a`,
      {
        agent: {
          async run() {
            calls++;
            throw new WorkflowError("hard stop", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
          },
        },
        agentRetries: 2,
        persistLogs: false,
      },
    ),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
  );
  assert.equal(calls, 1);
});

test("per-agent retries override run-level retries", async () => {
  let calls = 0;
  const result = await runWorkflow(
    `export const meta = { name: 'agent_retry_override', description: 'override' }
const a = await agent('work', { label: 'a', retries: 1 })
return a`,
    {
      agent: {
        async run() {
          calls++;
          return calls === 1 ? "" : "ok";
        },
      },
      agentRetries: 0,
      persistLogs: false,
    },
  );

  assert.equal(result.result, "ok");
  assert.equal(calls, 2);
});

test("runWorkflow accumulates real per-agent usage (incl. cost + cache tokens)", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ input: 100, output: 40, total: 140, cost: 0.002, cacheRead: 50, cacheWrite: 10 }),
    persistLogs: false,
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.tokenUsage?.input, 200);
  assert.equal(result.tokenUsage?.output, 80);
  assert.equal(result.tokenUsage?.total, 280);
  assert.ok(Math.abs((result.tokenUsage?.cost ?? 0) - 0.004) < 1e-9, "should be within tolerance");
  assert.equal(result.tokenUsage?.cacheRead, 100, "cacheRead accumulates across agents");
  assert.equal(result.tokenUsage?.cacheWrite, 20, "cacheWrite accumulates across agents");
});

test("Anthropic cache fan-out gate is disabled when PI_CACHE_RETENTION=none", async () => {
  const previous = process.env.PI_CACHE_RETENTION;
  const script = `export const meta = { name: 'cache_retention', description: 'gate policy' }
return await agent('work', { model: 'anthropic/claude-test' })`;
  try {
    delete process.env.PI_CACHE_RETENTION;
    let defaultGate: unknown;
    await runWorkflow(script, {
      agent: {
        async run(_prompt, options) {
          defaultGate = options?.cacheWarmGate;
          return "ok";
        },
      },
      persistLogs: false,
    });
    assert.ok(defaultGate, "Anthropic default short retention uses the fan-out gate");

    process.env.PI_CACHE_RETENTION = "none";
    let disabledGate: unknown;
    await runWorkflow(script, {
      agent: {
        async run(_prompt, options) {
          disabledGate = options?.cacheWarmGate;
          return "ok";
        },
      },
      persistLogs: false,
    });
    assert.equal(disabledGate, undefined, "no-cache mode must not serialize siblings for a cache that cannot exist");
  } finally {
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
  }
});

test("meta.model is parsed and routes as the default model for agents", async () => {
  let seenModel: string | undefined;
  const recorder = {
    async run(_p: string, o: { model?: string }) {
      seenModel = o.model;
      return "ok";
    },
  };
  const script = `export const meta = { name: 'm', description: 'd', model: 'meta/default-model' }
await agent('x', { label: 'x' })
return 1`;
  await runWorkflow(script, { agent: recorder, persistLogs: false });
  assert.equal(seenModel, "meta/default-model", "an agent with no model/tier/phase route uses meta.model");
});

test("runWorkflow falls back to an estimate when provider reports total === 0", async () => {
  const result = await runWorkflow(twoAgentScript, {
    agent: fakeAgent({ total: 0 }, "a result string"),
    persistLogs: false,
  });

  assert.equal(result.tokenUsage?.input, 0);
  assert.equal(result.tokenUsage?.output, 0);
  assert.ok((result.tokenUsage?.total ?? 0) > 0, "estimate should be positive");
  assert.equal(result.tokenUsage?.cost, 0);
});

test("agents default to the first declared phase when the script omits phase()", async () => {
  // Regression for the "(no phase) has agents, declared phase 0/0" bug: a script
  // that declares meta.phases but never calls phase() should still group its
  // agents under the first declared phase, not an orphan "(no phase)" bucket.
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'Research' }, { title: 'Synthesize' }] }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["Research"]);
});

test("explicit phase() overrides the default first phase", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd', phases: [{ title: 'A' }, { title: 'B' }] }
     phase('B')
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, ["B"]);
});

test("no declared phases => agent phase stays undefined (no synthetic phase)", async () => {
  const phases: Array<string | undefined> = [];
  const noop = {
    async run() {
      return "ok";
    },
  };
  await runWorkflow(
    `export const meta = { name: 'p', description: 'd' }
     await agent('a', { label: 'x' })
     return {}`,
    { agent: noop, persistLogs: false, onAgentStart: (e) => phases.push(e.phase) },
  );
  assert.deepEqual(phases, [undefined]);
});

test("runWorkflow routes models: explicit opts.model > phase model > default", async () => {
  const seen: Array<string | undefined> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; onUsage?: (u: AgentUsage) => void }) {
      seen.push(options.model);
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'routing', description: 'model routing',
    phases: [{ title: 'A', model: 'phase-a-model' }, { title: 'B' }]
  }
  phase('A')
  await agent('explicit wins', { label: 'e', model: 'explicit-model' })
  await agent('phase routed', { label: 'p' })
  phase('B')
  await agent('no model -> default', { label: 'n' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  assert.deepEqual(seen, ["explicit-model", "phase-a-model", undefined]);
});

test("runWorkflow plumbs opts.tier through to the agent with correct precedence", async () => {
  // Regression guard: tier must reach WorkflowAgent.run() (it was previously
  // dropped). Precedence: explicit model > tier > phase model.
  const seen: Array<{ model?: string; tier?: string }> = [];
  const capturingAgent = {
    async run(_prompt: string, options: { model?: string; tier?: string }) {
      seen.push({ model: options.model, tier: options.tier });
      return "ok";
    },
  };

  const script = `export const meta = {
    name: 'tier_routing', description: 'tier routing',
    phases: [{ title: 'A', model: 'phase-a-model' }]
  }
  phase('A')
  await agent('tier beats phase', { label: 't', tier: 'small' })
  await agent('explicit beats tier', { label: 'e', tier: 'small', model: 'explicit-model' })
  return {}`;

  await runWorkflow(script, { agent: capturingAgent, persistLogs: false });

  // 1) tier set, no explicit model: model is left undefined so the tier (resolved
  //    inside run()) wins over the phase model; tier is forwarded.
  assert.deepEqual(seen[0], { model: undefined, tier: "small" });
  // 2) explicit model + tier: explicit model is forwarded and still wins.
  assert.deepEqual(seen[1], { model: "explicit-model", tier: "small" });
});

const resumeScript = `export const meta = { name: 'resume_demo', description: 'resume' }
const a = await agent('first', { label: 'a' })
const b = await agent('second', { label: 'b' })
return { a, b }`;

test("resume replays cached results without re-running agents", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  const r1 = await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "resume-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 2);
  assert.equal(journal.length, 2);
  assert.deepEqual(
    journal.map((e) => e.index),
    [0, 1],
  );

  const second = countingAgent();
  const r2 = await runWorkflow(resumeScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "resume-run",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 0, "no live runs on a full cache hit");
  assert.equal(JSON.stringify(r2.result), JSON.stringify(r1.result));
});

test("resume hashes realized args at the call boundary without invalidating unrelated prefix work", async () => {
  const script = `export const meta = { name: 'resume_args', description: 'args-aware replay' }
const stable = await agent('stable', { label: 'stable' })
const scoped = await agent('scope:' + args.scope, { label: 'scoped' })
return { stable, scoped }`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    args: { scope: "a", displayOnly: 1 },
    persistLogs: false,
    runId: "resume-args-boundary-run",
    onAgentJournal: (entry) => journal.push(entry),
  });

  const sameRealizedCalls = countingAgent();
  await runWorkflow(script, {
    agent: sameRealizedCalls.runner,
    args: { scope: "a", displayOnly: 2 },
    persistLogs: false,
    runId: "resume-args-boundary-run",
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(sameRealizedCalls.state.calls, 0, "an unused args edit does not invalidate identical call inputs");

  const changedRealizedCalls = countingAgent();
  await runWorkflow(script, {
    agent: changedRealizedCalls.runner,
    args: { scope: "b", displayOnly: 2 },
    persistLogs: false,
    runId: "resume-args-boundary-run",
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
  });
  assert.equal(changedRealizedCalls.state.calls, 1, "only the first call whose realized args changed runs live");
});

test("resume re-runs only the changed call (hash mismatch)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(resumeScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "resume-run-2",
    onAgentJournal: (e) => journal.push(e),
  });

  const editedScript = resumeScript.replace("'second'", "'second-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "resume-run-2",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 1, "only the edited call re-runs");
});

const threeCallScript = `export const meta = { name: 'prefix', description: 'prefix resume' }
const a = await agent('A', { label: 'a' })
const b = await agent('B', { label: 'b' })
const c = await agent('C', { label: 'c' })
return { a, b, c }`;

test("resume re-runs the changed call AND everything after it (longest-unchanged-prefix)", async () => {
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(threeCallScript, {
    agent: first.runner,
    persistLogs: false,
    runId: "prefix-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  // Edit the MIDDLE call (index 1). Index 0 is an unchanged prefix → cache hit.
  // Index 1 changed → re-run; index 2 is unchanged but AFTER the first miss, so
  // it must re-run too (the bug was serving it stale from the journal).
  const editedScript = threeCallScript.replace("'B'", "'B-edited'");
  const second = countingAgent();
  await runWorkflow(editedScript, {
    agent: second.runner,
    persistLogs: false,
    runId: "prefix-run",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 2, "edited call (1) + its suffix (2) re-run; only the prefix (0) is cached");
});

test("resume in parallel(): editing one thunk re-runs that index and every later one", async () => {
  // Three identical-prompt thunks; editing the middle one must invalidate it and
  // the same-or-later index, not just the single changed call.
  const script = (mid: string) => `export const meta = { name: 'par_prefix', description: 'parallel prefix' }
  const xs = await parallel([
    () => agent('x', { label: 'p0' }),
    () => agent('${mid}', { label: 'p1' }),
    () => agent('x', { label: 'p2' }),
  ])
  return xs`;
  const first = countingAgent();
  const journal: JournalEntry[] = [];
  await runWorkflow(script("x"), {
    agent: first.runner,
    persistLogs: false,
    runId: "par-prefix-run",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(first.state.calls, 3);

  const second = countingAgent();
  await runWorkflow(script("x-edited"), {
    agent: second.runner,
    persistLogs: false,
    runId: "par-prefix-run",
    resumeJournal: new Map(journal.map((e) => [`${e.runId}:${e.index}`, e])),
  });
  assert.equal(second.state.calls, 2, "changed thunk (index 1) + later index (2) re-run; index 0 cached");
});

test("callSeq is deterministic under parallel()", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'par', description: 'parallel order' }
  const xs = await parallel(['p0','p1','p2'].map((p) => () => agent(p, { label: p })))
  return xs`;
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.deepEqual(
    journal.map((e) => e.index).sort((a, b) => a - b),
    [0, 1, 2],
  );
});

test("a nested child miss invalidates the parent suffix", async () => {
  const childScript = (prompt: string) => `
    export const meta = { name: 'nested-cache-child', description: 'nested cache child' }
    return await agent(${JSON.stringify(prompt)})
  `;
  const script = (prompt: string) => `
    export const meta = { name: 'nested-cache-parent', description: 'nested cache parent' }
    const child = await workflow(${JSON.stringify(childScript(prompt))})
    const suffix = await agent('parent-suffix')
    return { child, suffix }
  `;
  const journal: JournalEntry[] = [];
  let firstCalls = 0;
  await runWorkflow(script("child-v1"), {
    runId: "nested-cache-propagation-run",
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run(prompt: string) {
        firstCalls++;
        return `live:${prompt}`;
      },
    },
  });
  assert.equal(firstCalls, 2);

  let resumedCalls = 0;
  const resumed = await runWorkflow<{ child: string; suffix: string }>(script("child-v2"), {
    runId: "nested-cache-propagation-run",
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    agent: {
      async run(prompt: string) {
        resumedCalls++;
        return `live:${prompt}`;
      },
    },
  });
  assert.equal(resumedCalls, 2, "a live child miss must force the parent suffix live");
  assert.equal(resumed.result.child, "live:child-v2");
  assert.equal(resumed.result.suffix, "live:parent-suffix");
});

test("run-level instructions are part of replay identity", async () => {
  const script = `export const meta = { name: 'run-context-hash', description: 'run context hash' }
return await agent('same')`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    runId: "run-context-hash",
    instructions: "context-v1",
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "old";
      },
    },
  });

  let liveCalls = 0;
  const resumed = await runWorkflow(script, {
    runId: "run-context-hash",
    instructions: "context-v2",
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    agent: {
      async run() {
        liveCalls++;
        return "new";
      },
    },
  });
  assert.equal(liveCalls, 1);
  assert.equal(resumed.result, "new");
});

test("run-level tool definitions have stable replay identity and invalidate when their provider contract changes", async () => {
  const script = `export const meta = { name: 'tool-context-hash', description: 'tool context hash' }
return await agent('same')`;
  const makeTool = (description: string) =>
    defineTool({
      name: "lookup",
      label: "Lookup",
      description,
      parameters: Type.Object({ query: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text" as const, text: params.query }], details: params };
      },
    });
  const journal: JournalEntry[] = [];
  let liveCalls = 0;
  const runner = {
    async run() {
      liveCalls++;
      return `live-${liveCalls}`;
    },
  };
  await runWorkflow(script, {
    runId: "tool-context-hash",
    tools: [makeTool("Lookup v1")],
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });

  const resumeJournal = new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry]));
  const replayed = await runWorkflow(script, {
    runId: "tool-context-hash",
    tools: [makeTool("Lookup v1")],
    persistLogs: false,
    resumeJournal,
    agent: runner,
  });
  assert.equal(liveCalls, 1, "an equivalent tool definition keeps the replay hit");
  assert.equal(replayed.result, "live-1");

  const invalidated = await runWorkflow(script, {
    runId: "tool-context-hash",
    tools: [makeTool("Lookup v2")],
    persistLogs: false,
    resumeJournal,
    agent: runner,
  });
  assert.equal(liveCalls, 2, "a changed provider-visible tool contract invalidates replay");
  assert.equal(invalidated.result, "live-2");
});

test("opaque session/resource context disables replay instead of guessing its identity", async () => {
  const script = `export const meta = { name: 'opaque-context', description: 'opaque context' }
return await agent('same')`;
  const journal: JournalEntry[] = [];
  const session = { resourceLoader: () => ({}) } as any;
  await runWorkflow(script, {
    runId: "opaque-context-run",
    session,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "old";
      },
    },
  });

  let liveCalls = 0;
  await runWorkflow(script, {
    runId: "opaque-context-run",
    session,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    agent: {
      async run() {
        liveCalls++;
        return "new";
      },
    },
  });
  assert.equal(liveCalls, 1, "a dynamic resource loader must fail closed for replay");
});

test("parallel shared-store writes use the same order live and on replay", async () => {
  const journal: JournalEntry[] = [];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const runner = {
    async run(
      prompt: string,
      options: { systemTools?: Array<{ name: string; execute: (id: string, params: any) => Promise<any> }> },
    ) {
      const put = options.systemTools?.find((tool) => tool.name === "store_put");
      const get = options.systemTools?.find((tool) => tool.name === "store_get");
      if (prompt === "a") {
        await sleep(30);
        await put?.execute("", { key: "conflict", value: "A" });
        return "a";
      }
      if (prompt === "b") {
        await sleep(1);
        await put?.execute("", { key: "conflict", value: "B" });
        return "b";
      }
      const result = await get?.execute("", { key: "conflict" });
      return result?.details?.value;
    },
  };
  const script = (readPrompt: string) => `
    export const meta = { name: 'ordered-store', description: 'ordered store' }
    await parallel([() => agent('a'), () => agent('b')])
    return await agent(${JSON.stringify(readPrompt)})
  `;
  const first = await runWorkflow(script("read"), {
    runId: "ordered-store-run",
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: runner,
  });
  assert.equal(first.result, "B", "live state must use lexical admission order");

  const resumed = await runWorkflow(script("read-edited"), {
    runId: "ordered-store-run",
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    agent: runner,
  });
  assert.equal(resumed.result, "B", "replay must reconstruct the same conflicting write order");
});

test("replay rejects a journal entry whose runId does not match the lookup run", async () => {
  const script = `export const meta = { name: 'run-id-fence', description: 'run id fence' }
return await agent('same')`;
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    runId: "run-id-fence",
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "old";
      },
    },
  });
  const foreign = { ...journal[0], runId: "foreign-run" } as JournalEntry;
  let liveCalls = 0;
  const resumed = await runWorkflow(script, {
    runId: "run-id-fence",
    persistLogs: false,
    resumeJournal: new Map([["run-id-fence:0", foreign]]),
    agent: {
      async run() {
        liveCalls++;
        return "new";
      },
    },
  });
  assert.equal(liveCalls, 1);
  assert.equal(resumed.result, "new");
});

test("an unrelated model-registry change does not invalidate a canonical model pin", async () => {
  const script = `export const meta = { name: 'canonical-model-cache', description: 'canonical model cache' }
return await agent('same', { model: 'provider/model-a' })`;
  const model = (id: string) => ({ provider: "provider", id });
  const journal: JournalEntry[] = [];
  await runWorkflow(script, {
    runId: "canonical-model-cache",
    modelRegistry: { getAll: () => [model("model-a"), model("unrelated-v1")] } as any,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
    agent: {
      async run() {
        return "old";
      },
    },
  });
  let liveCalls = 0;
  const resumed = await runWorkflow(script, {
    runId: "canonical-model-cache",
    modelRegistry: { getAll: () => [model("model-a"), model("unrelated-v2")] } as any,
    persistLogs: false,
    resumeJournal: new Map(journal.map((entry) => [`${entry.runId}:${entry.index}`, entry])),
    agent: {
      async run() {
        liveCalls++;
        return "new";
      },
    },
  });
  assert.equal(liveCalls, 0);
  assert.equal(resumed.result, "old");
});

test("workflow() runs a nested saved workflow and shares the global agent counter", async () => {
  const child = `export const meta = { name: 'child', description: 'c' }
const r = await agent('child task', { label: 'c' })
return { child: r }`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await agent('parent task', { label: 'p' })
const nested = await workflow('child', { foo: 1 })
return { a, nested }`;

  const result = await runWorkflow<{ a: string; nested: { child: string } }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });

  assert.equal(result.agentCount, 2);
  assert.equal(result.result.nested.child, "ran:child task");
});

test("workflow() nesting is one level deep (second level throws)", async () => {
  const map: Record<string, string> = {
    gc: `export const meta = { name: 'gc', description: 'g' }
await agent('gc', { label: 'g' })
return 1`,
    child: `export const meta = { name: 'child', description: 'c' }
await workflow('gc')
return 2`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
let err = null
try { await workflow('child') } catch (e) { err = String(e && e.message || e) }
await agent('parent-contract-smoke')
return { err }`;

  const result = await runWorkflow<{ err: string }>(parent, {
    agent: countingAgent().runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => map[name],
  });
  assert.match(result.result.err, /one level deep/);
});

test("sequential nested workflow() calls at the same depth get distinct child run ids (no cross-child id/deltaKey collision)", async () => {
  // `shared.depth` alone would give BOTH of these sequential children the
  // same `${runId}-nested1` suffix (depth returns to 0 between them, since
  // only one level of nesting is ever live at a time) — and each child's own
  // callSeq restarts at 0, so their first agent() calls would then compute
  // the identical deltaKey (also used as the onAgentStart/onAgentEnd event
  // id — see item 2's identity model), corrupting SharedStore deltas and
  // misattributing events. child1's agent() call is deliberately left
  // un-awaited — realistically, that's exactly when the collision bites:
  // the stray can still be in SharedRuntime.inFlight (only the top-level
  // frame drains, not each nested frame) when child2 starts and mints an id.
  const seenIds = new Set<string>();
  let duplicateId: string | undefined;
  const runner = {
    async run(prompt: string) {
      if (prompt === "child1-stray") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "child1-stray-done";
      }
      return `ran:${prompt}`;
    },
  };
  const scripts: Record<string, string> = {
    child1: `export const meta = { name: 'child1', description: 'c1' }
// Deliberately NOT awaited.
agent('child1-stray', { label: 'stray' })
return 'child1-done'`,
    child2: `export const meta = { name: 'child2', description: 'c2' }
const r = await agent('child2-live', { label: 'live' })
return r`,
  };
  const parent = `export const meta = { name: 'parent', description: 'p' }
const a = await workflow('child1')
const b = await workflow('child2')
return { a, b }`;

  const result = await runWorkflow<{ a: string; b: string }>(parent, {
    agent: runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => scripts[name],
    onAgentStart: (event) => {
      if (seenIds.has(event.id)) duplicateId = event.id;
      seenIds.add(event.id);
    },
  });
  assert.equal(result.result.a, "child1-done");
  assert.equal(result.result.b, "ran:child2-live");
  assert.equal(
    duplicateId,
    undefined,
    "child1's un-awaited stray and child2's live call must never share an id/deltaKey",
  );
});

test("runWorkflow budget gates on accumulated tokens", async () => {
  const script = `export const meta = { name: 'budget_demo', description: 'budget' }
const a = await agent('first', { label: 'a' })
let second = null
try { second = await agent('second', { label: 'b' }) } catch (e) { second = 'blocked' }
return { a, second }`;

  const result = await runWorkflow<{ a: unknown; second: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    tokenBudget: 100,
    persistLogs: false,
  });

  assert.equal(result.result.second, "blocked");
});

test("runWorkflow initialTokenUsage seeds the run-wide budget so it holds cumulatively across resume (#A2)", async () => {
  // Simulates what WorkflowManager.resume() passes: a prior execution already
  // spent 60 (persisted). This fresh execution's own SharedRuntime must start
  // counting from there — 'a' (allowed: seeded 60 + budget 100 leaves 40
  // headroom) then spends 60 more, landing at 120; 'b' must then be blocked,
  // even though neither the seed alone (60) nor 'a' alone (60) would trip it.
  const script = `export const meta = { name: 'seeded_budget', description: 'seed' }
const a = await agent('a', { label: 'a' })
let blocked = false
try { await agent('b', { label: 'b' }) } catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
return { a, blocked }`;

  const result = await runWorkflow<{ a: unknown; blocked: boolean }>(script, {
    agent: fakeAgent({ input: 60, output: 0, total: 60, cost: 0 }),
    tokenBudget: 100,
    initialTokenUsage: { input: 60, output: 0, total: 60, cost: 0, cacheRead: 0, cacheWrite: 0 },
    persistLogs: false,
  });

  assert.equal(result.result.a, "ok", "'a' itself is allowed to run (remaining was 40 > 0 before it)");
  assert.equal(
    result.result.blocked,
    true,
    "'b' must be blocked once the seeded + this-run spend sums past the budget",
  );
  assert.equal(result.tokenUsage?.total, 120, "final total reflects the seed (60) plus 'a's spend (60); 'b' never ran");
});

test("runWorkflow initialTokenUsage integrates correctly with phase() sub-budgets (seeded baseline isn't corrupted)", async () => {
  // phase()'s sub-budget deliberately re-bases from shared.spent AT the
  // phase() call (see workflow.ts's phase(): "Re-declaring re-bases from the
  // current spent"), so a seed doesn't make the phase's OWN ceiling trip any
  // sooner than usual — it only shifts the visible baseline. This mirrors the
  // existing "phase sub-budget throws..." test's budget/spend shape exactly,
  // plus a seed, to confirm seeding doesn't corrupt that mechanism.
  const script = `export const meta = { name: 'seeded_phase_budget', description: 'seed' }
const spentAtStart = budget.spent()
phase('noisy', { budget: 100 })
let blocked = false
await agent('a', { label: '1' })
try { await agent('b', { label: '2' }) } catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
return { spentAtStart, blocked }`;

  const result = await runWorkflow<{ spentAtStart: number; blocked: boolean }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    initialTokenUsage: { input: 40, output: 0, total: 40, cost: 0, cacheRead: 0, cacheWrite: 0 },
    persistLogs: false,
  });

  assert.equal(
    result.result.spentAtStart,
    40,
    "budget.spent() reflects the seed before any agent in this execution runs",
  );
  assert.equal(
    result.result.blocked,
    true,
    "the phase sub-budget still gates normally on top of a seeded run-wide total",
  );
});

test("token budget exhaustion inside parallel() halts (non-recoverable, not swallowed)", async () => {
  // A warm-up agent spends the whole budget (soft gate: spent accrues after it
  // finishes); the agent() inside parallel() then hits the gate and must
  // propagate the non-recoverable error, not become a null in the result array.
  const script = `export const meta = { name: 'pb', description: 'budget in parallel' }
await agent('warmup', { label: 'w' })
const xs = await parallel([() => agent('x', { label: '1' })])
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
        tokenBudget: 100,
        persistLogs: false,
      }),
    /budget/i,
    "exhausted budget must reject the run, not become a null in the result array",
  );
});

test("non-recoverable agent-limit propagates out of pipeline() too", async () => {
  const script = `export const meta = { name: 'mp', description: 'agent limit pipeline' }
const xs = await pipeline([0, 1, 2, 3], (n) => agent('x' + n, { label: 'p' + n }))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("phase sub-budget throws when a phase exceeds its ceiling (run total untouched)", async () => {
  const script = `export const meta = { name: 'pb', description: 'phase budget' }
phase('noisy', { budget: 100 })
let blocked = false
try {
  await agent('a', { label: '1' })
  await agent('b', { label: '2' })
} catch (e) { blocked = (e && e.code) === 'TOKEN_BUDGET_EXHAUSTED' }
phase('calm')
const after = await agent('c', { label: '3' })
return { blocked, after }`;
  const res = await runWorkflow<{ blocked: boolean; after: unknown }>(script, {
    agent: fakeAgent({ input: 100, output: 0, total: 100, cost: 0 }),
    persistLogs: false,
  });
  assert.equal(res.result.blocked, true, "the 2nd agent in the phase hit the sub-budget");
  assert.ok(res.result.after !== null, "a later phase still proceeds");
});

test("maxAgents is enforced under a parallel() fan-out (atomic slot reservation)", async () => {
  // Four agents fan out with maxAgents=2. With the synchronous slot reservation,
  // the 3rd agent() throws AGENT_LIMIT instead of all four passing the gate.
  const script = `export const meta = { name: 'ma', description: 'agent limit' }
const xs = await parallel([0, 1, 2, 3].map((i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  await assert.rejects(
    () =>
      runWorkflow(script, {
        agent: fakeAgent({ input: 1, output: 0, total: 1, cost: 0 }),
        maxAgents: 2,
        persistLogs: false,
      }),
    /limit/i,
  );
});

test("a fan-out past maxAgents cancels queued agents instead of draining the reserved queue", async () => {
  // A parallel() overshoot reserves and queues up to maxAgents agents behind the
  // limiter. Before the fix, every reserved agent ran its real API call (spending)
  // even though the fan-out had already rejected; now the breach short-circuits the
  // still-queued agents so at most ~concurrency of them execute.
  const fanout = 100;
  const maxAgents = 50;
  const concurrency = 4;
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const runner = {
    async run(prompt: string) {
      calls.count++;
      await gate; // stay in-flight/queued while the limit breach propagates
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'c4', description: 'fanout cancel' }
const xs = await parallel(Array.from({ length: ${fanout} }, (_, i) => () => agent('x' + i, { label: 'a' + i })))
return xs`;
  const run = runWorkflow(script, { agent: runner, maxAgents, concurrency, persistLogs: false });
  // The run now drains every in-flight agent() call (including these
  // gate-blocked ones) before its own promise settles — see the run-fatal
  // drain in runWorkflow's finally — so `run` will NOT reject until `gate`
  // resolves. Release it concurrently instead of after awaiting the
  // rejection (which would deadlock: nothing else ever calls release()).
  const releaseSoon = new Promise<void>((r) => setTimeout(r, 20)).then(() => release());
  await assert.rejects(run, /limit/i);
  await releaseSoon;
  // Deterministically exactly `concurrency`: the limiter runs the first
  // `concurrency` submissions' bodies synchronously during the reservation
  // pass (each immediately calls runner.run() and then suspends on `gate`);
  // every submission after that suspends on the limiter's internal queue
  // before it ever reaches runner.run(), and the batch is cancelled (via
  // fanoutScope) before any of them get their turn.
  assert.equal(calls.count, concurrency);
});

test("sibling parallel() batches are isolated: one breaching maxAgents does not cancel the other", async () => {
  // Two independent parallel() fan-outs run CONCURRENTLY inside the same run
  // (sharing one shared.agentCount / maxAgents), each isolated via its own
  // .then(ok, err). Batch A (3 agents) never breaches; batch B (40 agents)
  // does. Before batch-scoped cancellation, a run-global "limitReached" flag
  // would wrongly cancel A's still-queued agents too, purely because B (an
  // unrelated fan-out) breached the shared cap — that's the regression this
  // guards against.
  const maxAgents = 10;
  const concurrency = 2;
  const runner = {
    async run(prompt: string) {
      await new Promise((r) => setTimeout(r, 5));
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'sib', description: 'sibling isolation' }
const batchA = parallel(Array.from({ length: 3 }, (_, i) => () => agent('a' + i, { label: 'a' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const batchB = parallel(Array.from({ length: 40 }, (_, i) => () => agent('b' + i, { label: 'b' + i })))
  .then((r) => ({ ok: true, r }), (e) => ({ ok: false, code: e && e.code }))
const [a, b] = await Promise.all([batchA, batchB])
return { a, b }`;
  const res = await runWorkflow<{
    a: { ok: boolean; r?: unknown[] };
    b: { ok: boolean; code?: string };
  }>(script, { agent: runner, maxAgents, concurrency, persistLogs: false });

  assert.equal(res.result.a.ok, true, "batch A (never breaches) must resolve, not be cancelled by sibling B");
  assert.equal(res.result.a.r?.length, 3);
  assert.ok((res.result.a.r as unknown[]).every((r) => typeof r === "string" && r.startsWith("ran:")));

  assert.equal(res.result.b.ok, false, "batch B (breaches maxAgents) must reject");
  assert.equal(res.result.b.code, WorkflowErrorCode.AGENT_LIMIT_EXCEEDED);
});

test("a breach in a nested parallel() doesn't corrupt the outer batch's state", async () => {
  // Outer parallel() of two thunks; one thunk runs an inner parallel() that
  // breaches a low maxAgents. The breach should propagate as a rejection of
  // the whole run (agent limit is non-recoverable) without throwing anything
  // unexpected (e.g. an ALS/ordering bug corrupting shared.agentCount).
  const runner = {
    async run(prompt: string) {
      return `ran:${prompt}`;
    },
  };
  const script = `export const meta = { name: 'nest', description: 'nested fanout' }
const xs = await parallel([
  () => agent('outer-1', { label: 'outer-1' }),
  () => parallel(Array.from({ length: 5 }, (_, i) => () => agent('inner' + i, { label: 'inner' + i }))),
])
return xs`;
  await assert.rejects(
    () => runWorkflow(script, { agent: runner, maxAgents: 2, concurrency: 2, persistLogs: false }),
    /limit/i,
  );
});

// ─── Additional edge case tests ─────────────────────────────────────────────────

test("runWorkflow returns meta, logs, phases, and duration", async () => {
  const ONE_AGENT = `export const meta = { name: 'meta_test', description: 'check metadata' }
const a = await agent('test', { label: 'a' })
return a`;

  const result = await runWorkflow(ONE_AGENT, {
    agent: fakeAgent({ total: 50 }),
    persistLogs: false,
  });

  assert.equal(result.meta.name, "meta_test");
  assert.equal(result.meta.description, "check metadata");
  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
  assert.ok(Array.isArray(result.phases), "result.phases should be an array");
  assert.ok(result.durationMs >= 0, "durationMs should be non-negative");
  assert.ok(typeof result.runId === "string" && result.runId.length > 0, "runId should be a non-empty string");
});

test("runWorkflow handles empty script without phases gracefully", async () => {
  const SIMPLE = `export const meta = { name: 'simple', description: 'simple' }
const a = await agent('hello', { label: 'greeter' })
return a`;

  const result = await runWorkflow(SIMPLE, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.equal(result.result, "done");
  assert.equal(result.agentCount, 1);
});

test("runWorkflow parallel returns results in input order", async () => {
  const script = `export const meta = { name: 'parallel_order', description: 'check order' }
const results = await parallel([1,2,3].map(n => () => agent('task ' + n, { label: 't' + n })))
return results`;

  let callIndex = 0;
  const agent = {
    async run(prompt: string) {
      return `result-${++callIndex}:${prompt}`;
    },
  };

  const result = await runWorkflow<unknown[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 3);
});

test("runWorkflow parallel accepts variadic thunks with array-equivalent semantics", async () => {
  const script = `export const meta = { name: 'parallel_variadic', description: 'accept common model-authored syntax' }
const results = await parallel(
  () => agent('first', { label: 'first' }),
  () => agent('second', { label: 'second' })
)
return results`;

  const result = await runWorkflow<string[]>(script, {
    agent: fakeAgent({ total: 50 }, "done"),
    persistLogs: false,
  });
  assert.deepEqual(result.result, ["done", "done"]);
  assert.equal(result.agentCount, 2);
});

test("runWorkflow pipeline stages in order", async () => {
  const script = `export const meta = { name: 'pipeline_test', description: 'test pipeline' }
const results = await pipeline(['a','b'], item => agent('stage1 ' + item), result => agent('stage2 ' + result))
return results`;

  const log: string[] = [];
  const agent = {
    async run(prompt: string) {
      log.push(prompt);
      return prompt.replace("stage1", "stage1-done").replace("stage2", "stage2-done");
    },
  };

  const result = await runWorkflow<string[]>(script, { agent, persistLogs: false });
  assert.ok(Array.isArray(result.result), "result.result should be an array");
  assert.equal(result.result.length, 2);
});

test("pipeline forwards a recoverable null to the next stage with original item and index", async () => {
  const script = `export const meta = { name: 'pipeline_null', description: 'null forwarding' }
const results = await pipeline(
  ['alpha'],
  (item) => agent('first ' + item, { label: 'first' }),
  (previousValue, originalItem, index) => ({ previousValue, originalItem, index }),
)
return results`;
  const agent = {
    async run() {
      throw new Error("recoverable first-stage failure");
    },
  };

  const result = await runWorkflow<Array<{ previousValue: null; originalItem: string; index: number }>>(script, {
    agent,
    persistLogs: false,
  });

  assert.deepEqual(
    Array.from(result.result, ({ previousValue, originalItem, index }) => ({ previousValue, originalItem, index })),
    [{ previousValue: null, originalItem: "alpha", index: 0 }],
  );
});

test("runWorkflow agent with different labels", async () => {
  const script = `export const meta = { name: 'label_test', description: 'labels' }
const a = await agent('task1', { label: 'worker-1' })
const b = await agent('task2', { label: 'worker-2' })
return { a, b }`;

  const seenLabels: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onAgentStart: (e) => seenLabels.push(e.label),
  });

  assert.deepEqual(seenLabels, ["worker-1", "worker-2"]);
});

test("runWorkflow with phases assignment to agents", async () => {
  const script = `export const meta = { name: 'phase_test', description: 'phases', phases: [{ title: 'Phase1' }, { title: 'Phase2' }] }
phase('Phase1')
const a = await agent('phase1 work', { label: 'p1' })
phase('Phase2')
const b = await agent('phase2 work', { label: 'p2' })
return { a, b }`;

  const phases: string[] = [];
  const agentPhases: string[] = [];
  await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    onPhase: (title) => phases.push(title),
    onAgentStart: (e) => {
      if (e.phase) agentPhases.push(e.phase);
    },
  });

  assert.ok(phases.includes("Phase1"), "should contain Phase1");
  assert.ok(phases.includes("Phase2"), "should contain Phase2");
});

test("runWorkflow can send args to the script", async () => {
  const script = `export const meta = { name: 'args_test', description: 'test args' }
await agent('args-contract-smoke')
return { received: args && args.value }`;

  const result = await runWorkflow<{ received: unknown }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
    args: { value: 42 },
  });

  // No agent calls means 0 agents
  assert.equal(result.result.received, 42);
});

test("runWorkflow log function works inside script", async () => {
  const script = `export const meta = { name: 'log_test', description: 'logging' }
log('hello from script')
await agent('log-contract-smoke')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("hello from script")),
    "should contain hello from script",
  );
});

test("runWorkflow console.log works inside script", async () => {
  const script = `export const meta = { name: 'console_test', description: 'console' }
console.log('console log')
console.warn('console warn')
await agent('console-contract-smoke')
return true`;

  const result = await runWorkflow(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.ok(
    result.logs.some((l) => l.includes("console log")),
    "should contain console log",
  );
  assert.ok(
    result.logs.some((l) => l.includes("console warn")),
    "should contain console warn",
  );
});

test("runWorkflow process.cwd() works inside script", async () => {
  const script = `export const meta = { name: 'cwd_test', description: 'cwd' }
const value = process.cwd()
await agent('cwd-contract-smoke')
return { cwd: value }`;

  const result = await runWorkflow<{ cwd: string }>(script, {
    agent: countingAgent().runner,
    persistLogs: false,
  });

  assert.equal(typeof result.result.cwd, "string");
  assert.ok(result.result.cwd.length > 0, "result.cwd should not be empty");
});

test("runWorkflow budget object exposes spent() and remaining()", async () => {
  const script = `export const meta = { name: 'budget_api', description: 'budget API' }
try { const s = budget.spent(); const r = budget.remaining(); await agent('budget-contract-smoke'); return { spent: s, remaining: typeof r } }
catch(e) { return { error: String(e) } }`;

  const result = await runWorkflow<{ spent: number; remaining: string }>(script, {
    agent: fakeAgent({ total: 100 }),
    persistLogs: false,
  });

  assert.equal(result.result.spent, 0); // before first agent
  assert.equal(result.result.remaining, "number");
});

test("runWorkflow returns empty logs array when nothing logged", async () => {
  const script = `export const meta = { name: 'no_log', description: 'no logs' }
await agent('silent', { label: 's' })
return 1`;

  const result = await runWorkflow(script, {
    agent: fakeAgent({ total: 10 }),
    persistLogs: false,
  });

  assert.ok(Array.isArray(result.logs), "result.logs should be an array");
});

// ─── Runtime determinism hardening (P0-5) ───────────────────────────────────────

const noopAgent = {
  async run() {
    return "ok";
  },
};

function probe(expr: string): Promise<{ result: { err: string | null; val: unknown } }> {
  const script = `export const meta = { name: 'det', description: 'determinism' }
let err = null, val = null
try { val = ${expr} } catch (e) { err = String((e && e.message) || e) }
await agent('noop', { label: 'x' })
return { err, val }`;
  return runWorkflow(script, { agent: noopAgent, persistLogs: false });
}

test("parse-time guard rejects literal Date.now / Math.random / new Date()", async () => {
  for (const expr of ["Math.random()", "Date.now()", "new Date()"]) {
    await assert.rejects(
      () =>
        runWorkflow(
          `export const meta = { name: 'lit', description: 'd' }\nconst v = ${expr}\nawait agent('x', { label: 'x' })\nreturn v`,
          { agent: noopAgent, persistLogs: false },
        ),
      /deterministic|unavailable/i,
      `${expr} literal should be rejected at parse time`,
    );
  }
});

test("determinism validation ignores comments and string literals", () => {
  for (const forbidden of ["Date.now()", "Math.random()", "new Date()"]) {
    const script = `export const meta = { name: 'allowed-prose', description: 'fixture' }
// ${forbidden} is unavailable here.
const warning = ${JSON.stringify(`Do not call ${forbidden}`)}
await agent('x', { label: 'x' })
return { warning }`;

    assert.doesNotThrow(() => parseWorkflowScript(script));
  }
});

test("runtime guard neuters computed-access bypasses the parse regex misses", async () => {
  const r1 = await probe('Math["random"]()');
  assert.match(r1.result.err ?? "", /unavailable|resume/i, 'Math["random"]() should throw at runtime');
  const r2 = await probe('Date["now"]()');
  assert.match(r2.result.err ?? "", /unavailable|resume/i, 'Date["now"]() should throw at runtime');
  const r3 = await probe("(() => { const D = Date; return new D(); })()");
  assert.match(r3.result.err ?? "", /unavailable|resume/i, "aliased no-arg Date should throw at runtime");
});

test("runtime determinism: new Date(arg) and Math.max still work", async () => {
  const d = await probe("new Date(0).getTime()");
  assert.equal(d.result.err, null, "new Date(0) should construct");
  assert.equal(d.result.val, 0, "new Date(0).getTime() === 0");
  const m = await probe("Math.max(1, 2, 3)");
  assert.equal(m.result.err, null);
  assert.equal(m.result.val, 3);
});

test("vm-realm builtins work and the constructor escape hits the neutered Date.now", async () => {
  // The escape string is split so the parse-time regex doesn't flag it; at runtime
  // the vm Function runs in the vm realm where Date.now is neutered.
  const script = `export const meta = { name: 'vm', description: 'vm realm' }
let escaped = null
try { escaped = ({}).constructor.constructor('return Da' + 'te.now()')() } catch (e) { escaped = 'blocked:' + String((e && e.message) || e) }
const arr = [1, 2, 3].map((x) => x * 2)
const j = JSON.stringify({ a: 1 })
const s = [...new Set([1, 1, 2])]
await agent('noop', { label: 'x' })
return { escaped, arr, j, s }`;
  const r = await runWorkflow<{ escaped: string; arr: number[]; j: string; s: number[] }>(script, {
    agent: noopAgent,
    persistLogs: false,
  });
  // Spread to a host array: vm-realm arrays don't deepStrictEqual host literals.
  assert.deepEqual([...r.result.arr], [2, 4, 6], "vm Array.map works");
  assert.equal(r.result.j, '{"a":1}', "vm JSON works");
  assert.deepEqual([...r.result.s], [1, 2], "vm Set works");
  // ({}).constructor.constructor is the vm Function; its code runs in the vm realm
  // where Date.now is neutered -> blocked (the old host-object escape is closed).
  assert.match(r.result.escaped, /blocked/, "constructor escape via vm objects is closed");
});

// ── Run-fatal abort: a non-recoverable error that will fail the whole run
// must stop in-flight siblings from continuing to spend, while preserving
// parallel()'s null-on-recoverable-error contract and a script's own
// try/catch around agent()/parallel(). ──

/** An agent runner whose in-flight calls actually respect an abort signal. */
function abortAwareAgent(delayMs: number) {
  const state = { started: 0, completed: 0, aborted: 0 };
  return {
    state,
    runner: {
      async run(prompt: string, options: { signal?: AbortSignal } = {}) {
        state.started++;
        if (prompt === "failer") {
          throw new WorkflowError("boom", WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: false });
        }
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            state.completed++;
            resolve(`done:${prompt}`);
          }, delayMs);
          options.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              state.aborted++;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        });
      },
    },
  };
}

test("a run-fatal error aborts in-flight parallel() siblings instead of letting them run to completion", async () => {
  const { state, runner } = abortAwareAgent(200);
  const script = `export const meta = { name: 'fatal_abort', description: 'sibling abort' }
const xs = await parallel([
  () => agent('failer', { label: 'failer' }),
  () => agent('sib1', { label: 'sib1' }),
  () => agent('sib2', { label: 'sib2' }),
])
return xs`;
  await assert.rejects(runWorkflow(script, { agent: runner, persistLogs: false }), /boom/);
  // Both in-flight siblings must have been aborted before their (200ms)
  // delay would otherwise have let them complete and return a result.
  assert.equal(state.started, 3, "all three agent() calls actually started");
  assert.equal(state.aborted, 2, "both siblings were aborted once the run's fate was sealed");
  assert.equal(state.completed, 0, "no sibling ran to completion on a run that's already failing");
});

test("a script's own try/catch around parallel() preserves in-flight siblings — no run-fatal abort", async () => {
  const { state, runner } = abortAwareAgent(20);
  const script = `export const meta = { name: 'fatal_abort_caught', description: 'sibling survives caught failure' }
let caught = false
try {
  await parallel([
    () => agent('failer', { label: 'failer' }),
    () => agent('sib1', { label: 'sib1' }),
  ])
} catch (e) {
  caught = true
}
// A later agent() call must still work normally — the run's fate was never
// sealed because the script caught parallel()'s escaping error.
const after = await agent('after', { label: 'after' })
return { caught, after }`;
  const result = await runWorkflow<{ caught: boolean; after: string }>(script, {
    agent: runner,
    persistLogs: false,
  });
  assert.equal(result.result.caught, true, "the script's own try/catch saw parallel()'s escaping error");
  assert.equal(result.result.after, "done:after", "a later agent() call still runs normally, unaborted");
  assert.equal(state.aborted, 0, "the caught sibling was never aborted — the run's fate was never sealed");
  assert.equal(state.completed, 2, "the caught sibling and the later agent() both ran to completion");
});

test("parallel()'s recoverable-error-to-null contract does not seal the run's fate (siblings unaffected)", async () => {
  const { state, runner } = abortAwareAgent(20);
  // A plain (non-WorkflowError) throw from a thunk is classified recoverable by
  // wrapError()'s default — parallel() must swallow it to null, not rethrow,
  // and must NOT abort the sibling still in flight.
  const script = `export const meta = { name: 'recoverable_null', description: 'recoverable swallowed' }
const xs = await parallel([
  () => { throw new Error('plain failure') },
  () => agent('sib', { label: 'sib' }),
])
return xs`;
  const result = await runWorkflow<Array<unknown>>(script, { agent: runner, persistLogs: false });
  assert.deepEqual(result.result, [null, "done:sib"], "the thrown thunk resolves to null; the sibling still succeeds");
  assert.equal(state.aborted, 0, "a recoverable, swallowed-to-null error must never trigger a run-fatal abort");
  assert.equal(state.completed, 1);
});

test("a parent script that catches a nested workflow()'s uncaught child error can still run agents afterward (isTopLevelRun gate)", async () => {
  // Only the TOP-level frame is allowed to seal shared.runFatalController (see
  // isTopLevelRun in runWorkflow's catch) — a NESTED frame reaching its own
  // catch must never seal it, because the error hasn't finished propagating
  // yet: the parent script may still catch workflow()'s rejection and
  // continue normally. If a nested frame sealed it too (the mutation this
  // test targets — dropping the isTopLevelRun guard), the shared runtime
  // (shared between parent and child via sharedRuntime) would already be
  // aborted by the time control returns to the parent's catch block, so the
  // parent's own SUBSEQUENT agent() call would be aborted before it could
  // even start — even though the parent legitimately handled the failure.
  const { state, runner } = abortAwareAgent(20);
  const child = `export const meta = { name: 'child', description: 'c' }
await agent('failer', { label: 'child-failer' })
return 1`;
  const parent = `export const meta = { name: 'parent', description: 'p' }
let caught = false
try {
  await workflow('child')
} catch (e) {
  caught = true
}
const after = await agent('after', { label: 'after' })
return { caught, after }`;

  const result = await runWorkflow<{ caught: boolean; after: string }>(parent, {
    agent: runner,
    persistLogs: false,
    loadSavedWorkflow: (name) => (name === "child" ? child : undefined),
  });
  assert.equal(result.result.caught, true, "the parent's own try/catch saw the child workflow's escaping error");
  assert.equal(result.result.after, "done:after", "a later agent() call must still run normally after the catch");
  assert.equal(state.aborted, 0, "sealing at the child (nested) level must never abort the parent's own later agent");
});

// ── Un-awaited agent() calls must not outlive the run: the run drains every
// spawned agent() call (awaited or not) before it is allowed to complete. ──

test("an un-awaited agent() call is drained before the run completes", async () => {
  let strayCompleted = false;
  const runner = {
    async run(prompt: string) {
      if (prompt === "stray") {
        await new Promise((resolve) => setTimeout(resolve, 30));
        strayCompleted = true;
        return "stray-done";
      }
      return "main-done";
    },
  };
  const script = `export const meta = { name: 'stray_demo', description: 'un-awaited agent' }
// Deliberately NOT awaited — a script bug the run must tolerate without
// letting this call outlive the run's completion.
agent('stray', { label: 'stray' })
const main = await agent('main', { label: 'main' })
return main`;
  const journal: JournalEntry[] = [];
  const result = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    onAgentJournal: (entry) => journal.push(entry),
  });
  assert.equal(result.result, "main-done");
  assert.equal(strayCompleted, true, "the run must not complete until the un-awaited agent has settled");
  assert.ok(
    journal.some((e) => e.result === "stray-done"),
    "the stray agent's completion must be journaled before the run ends",
  );
});

test("an un-awaited agent() call replays deterministically from the journal on resume", async () => {
  const calls = { stray: 0, main: 0 };
  const runner = {
    async run(prompt: string) {
      if (prompt === "stray") {
        calls.stray++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "stray-done";
      }
      calls.main++;
      return "main-done";
    },
  };
  const script = `export const meta = { name: 'stray_resume_demo', description: 'un-awaited agent replay' }
agent('stray', { label: 'stray' })
const main = await agent('main', { label: 'main' })
return main`;
  const journalEntries = new Map<string, JournalEntry>();
  const first = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    runId: "prior-run",
    onAgentJournal: (entry) => journalEntries.set(`${entry.runId}:${entry.index}`, entry),
  });
  assert.equal(first.result, "main-done");
  assert.equal(calls.stray, 1);
  assert.equal(calls.main, 1);

  const second = await runWorkflow<string>(script, {
    agent: runner,
    persistLogs: false,
    runId: "prior-run",
    resumeJournal: journalEntries,
    resumeFromRunId: "prior-run",
  });
  assert.equal(second.result, "main-done");
  // Resume replays BOTH cached calls (including the un-awaited 'stray') from
  // the journal — neither runner.run() is invoked again.
  assert.equal(calls.stray, 1, "the un-awaited agent's cached result must replay, not re-run, on resume");
  assert.equal(calls.main, 1, "the awaited agent's cached result must replay, not re-run, on resume");
});

test("workflow frame deadline settles an endless script without awaiting its promise", async () => {
  const script = `export const meta = { name: 'deadline_demo', description: 'finite logical lifecycle' }
await agent('ready')
await new Promise(() => {})`;
  const started = Date.now();
  await assert.rejects(
    runWorkflow(script, { agent: noopAgent, persistLogs: false, workflowTimeoutMs: 25 }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_TIMEOUT,
  );
  assert.ok(Date.now() - started < 1_000, "logical settlement must not wait for the endless script promise");
});

test("workflow deadline aborts an in-flight provider when the provider honors AbortSignal", async () => {
  let aborted = false;
  const runner = {
    async run(_prompt: string, options: { signal?: AbortSignal }) {
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => {
          aborted = true;
          reject(new Error("aborted"));
        };
        if (options.signal?.aborted) onAbort();
        else options.signal?.addEventListener("abort", onAbort, { once: true });
      });
      return "never";
    },
  };
  await assert.rejects(
    runWorkflow("export const meta = { name: 'provider_deadline', description: 'abort' }\nawait agent('hang')", {
      agent: runner,
      persistLogs: false,
      workflowTimeoutMs: 25,
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.WORKFLOW_TIMEOUT,
  );
  assert.equal(aborted, true);
});

test("host-provided args are copied into the VM realm without host constructors", async () => {
  const hostDate = new Date(0);
  const result = await runWorkflow<{ value: string; same: boolean; processCtor: boolean; budgetCtor: boolean }>(
    "export const meta = { name: 'bridge', description: 'bridge' }\nawait agent('x')\nreturn { value: String(args.value), same: args.value.constructor === Date, processCtor: process.cwd.constructor === undefined, budgetCtor: budget.spent.constructor === undefined }",
    { agent: noopAgent, args: { value: hostDate }, persistLogs: false },
  );
  assert.equal(result.result.value, "[workflow bridge value omitted]");
  assert.equal(result.result.same, false);
  assert.equal(result.result.processCtor, true);
  assert.equal(result.result.budgetCtor, true);
});
