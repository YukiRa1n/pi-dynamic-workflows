import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Check } from "typebox/value";
import type { WorkflowSnapshot } from "../src/display.js";
import type { PersistedRunState, RunStatus } from "../src/run-persistence.js";
import {
  createGetWorkflowOutputTool,
  createListActiveWorkflowsTool,
  createStopWorkflowTool,
  createWorkflowControlTool,
  releaseWorkflowOutputWaitForInput,
} from "../src/workflow-control-tool.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

function run(status: RunStatus = "running", runId = "audit-abc123"): PersistedRunState {
  return {
    runId,
    workflowName: "audit",
    script: "export const meta = { name: 'audit', description: 'audit' }; return await agent('x')",
    status,
    phases: ["Inspect"],
    currentPhase: "Inspect",
    agents: [
      { id: 1, label: "active scan", prompt: "scan", status: status === "running" ? "running" : "done", tokens: 30 },
      { id: 2, label: "queued check", prompt: "check", status: "queued" },
      { id: 3, label: "failed check", prompt: "fail", status: "error" },
      { id: 4, label: "optional check", prompt: "optional", status: "skipped" },
    ],
    logs: [],
    startedAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:01.000Z",
    tokenUsage: { input: 20, output: 10, total: 30 },
  };
}

function fakeManager(
  initial: PersistedRunState[],
  liveSnapshots: Record<string, WorkflowSnapshot> = {},
  managedRuns: Record<string, { executionSettled?: boolean }> = {},
) {
  const runs = new Map(initial.map((item) => [item.runId, item]));
  const calls: Array<{ action: string; runId: string }> = [];
  const manager = {
    listRuns: () => [...runs.values()],
    getSnapshot: (runId: string) => liveSnapshots[runId] ?? null,
    getRun: (runId: string) => managedRuns[runId],
    pause(runId: string) {
      calls.push({ action: "pause", runId });
      const item = runs.get(runId);
      if (item?.status !== "running") return false;
      item.status = "paused";
      return true;
    },
    async resume(runId: string) {
      calls.push({ action: "resume", runId });
      const item = runs.get(runId);
      if (!item || (item.status !== "paused" && item.status !== "failed" && item.status !== "pending")) return false;
      item.status = "running";
      return true;
    },
    stop(runId: string) {
      calls.push({ action: "stop", runId });
      const item = runs.get(runId);
      if (!item || (item.status !== "running" && item.status !== "paused")) return false;
      item.status = "aborted";
      return true;
    },
  } as unknown as WorkflowManager;
  return { manager, calls };
}

async function execute(manager: WorkflowManager, params: Record<string, unknown>) {
  const tool = createWorkflowControlTool({ manager });
  return (tool.execute as any)("control-call", params, undefined, undefined, {});
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content[0].text;
}

function stopManager(options: { sessionId?: string; runSessionId?: string; status?: RunStatus; runId?: string }) {
  const runId = options.runId ?? "audit-current-1";
  const item = { ...run(options.status ?? "running", runId), sessionId: options.runSessionId };
  const calls: string[] = [];
  const manager = {
    getSessionId: () => options.sessionId,
    listRuns: () => [item],
    stop(id: string) {
      calls.push(id);
      if (item.status !== "running" && item.status !== "paused") return false;
      item.status = "aborted";
      return true;
    },
  } as unknown as WorkflowManager;
  return { manager, calls, item };
}

async function executeStop(manager: WorkflowManager, params: Record<string, unknown>) {
  const tool = createStopWorkflowTool({ manager });
  return (tool.execute as any)("stop-call", params, undefined, undefined, {});
}

async function executeList(manager: WorkflowManager, params: Record<string, unknown> = {}) {
  const tool = createListActiveWorkflowsTool({ manager });
  return (tool.execute as any)("list-call", params, undefined, undefined, {});
}

function outputManager(item: PersistedRunState, sessionId = "session-a") {
  class FakeOutputManager extends EventEmitter {
    state = item;
    getSessionId() {
      return sessionId;
    }
    listRuns() {
      return [this.state];
    }
    getRun() {
      return undefined;
    }
    getPersistence() {
      return { getRunsDir: () => "C:/workflow-runs" };
    }
  }
  return new FakeOutputManager() as unknown as WorkflowManager & EventEmitter & { state: PersistedRunState };
}

async function executeOutput(manager: WorkflowManager, params: Record<string, unknown>, signal?: AbortSignal) {
  const tool = createGetWorkflowOutputTool({ manager });
  return (tool.execute as any)("output-call", params, signal, undefined, {});
}

const renderTheme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

function renderedText(component: { render(width: number): string[] }): string {
  return component
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
}

test("list_active_workflows exposes a strict empty schema and no lifecycle controls", () => {
  const fixture = stopManager({ sessionId: "session-a", runSessionId: "session-a" });
  const tool = createListActiveWorkflowsTool({ manager: fixture.manager });

  assert.equal(tool.name, "list_active_workflows");
  assert.match(tool.description, /cancellation only/i);
  assert.match(tool.description, /Never poll/i);
  assert.equal(Check(tool.parameters, {}), true);
  assert.equal(Check(tool.parameters, { status: true }), false);
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  const prepare = tool.prepareArguments as (value: unknown) => unknown;
  assert.deepEqual(prepare({}), {});
  assert.throws(() => prepare({ status: true }), /does not accept status/);
});

test("get_workflow_output exposes a strict next-output wait schema", () => {
  const manager = outputManager({ ...run("completed"), sessionId: "session-a", result: "done" });
  const tool = createGetWorkflowOutputTool({ manager });

  assert.equal(tool.name, "get_workflow_output");
  assert.match(tool.description, /event wait/i);
  assert.match(tool.description, /not status/i);
  assert.match(tool.description, /next agent result/i);
  assert.match(tool.description, /Esc cancels this wait only/i);
  assert.match(tool.description, /Never poll or use shell sleep/i);
  assert.equal(Check(tool.parameters, { runId: "audit-abc123" }), true);
  assert.equal(Check(tool.parameters, { runId: "audit-abc123", block: false }), true);
  assert.equal(Check(tool.parameters, { runId: "audit-abc123", timeoutMs: 10 }), false);
  assert.equal(Check(tool.parameters, { runId: "audit-abc123", extra: true }), false);
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(tool.executionMode, "sequential");

  const prepare = tool.prepareArguments as (value: unknown) => unknown;
  assert.deepEqual(prepare({ runId: "audit-abc123" }), {
    runId: "audit-abc123",
    block: true,
  });
  assert.throws(() => prepare({ runId: "../foreign" }), /canonical runId/);
  assert.throws(() => prepare({ runId: "audit-abc123", timeoutMs: 10 }), /does not accept timeoutMs/);
  assert.throws(() => prepare({ runId: "audit-abc123", extra: true }), /does not accept extra/);
});

test("cancelled output reads leave pending agent results available", async () => {
  const item = { ...run("running"), sessionId: "session-a" };
  item.agents = [{ id: 1, label: "report", prompt: "work", status: "done", result: "unread report" }];
  const manager = outputManager(item);
  const controller = new AbortController();
  controller.abort();
  const cancelled = await executeOutput(manager, { runId: item.runId }, controller.signal);
  assert.equal(cancelled.details.interrupted, true);
  assert.equal(cancelled.terminate, true);
  const next = await executeOutput(manager, { runId: item.runId, block: false });
  assert.match(next.content[0].text, /unread report/);
});

test("cancellation during the final-agent grace turn leaves its output unclaimed", async () => {
  const item = { ...run("running"), sessionId: "session-a", agents: [] };
  const manager = outputManager(item);
  const controller = new AbortController();
  const pending = executeOutput(manager, { runId: item.runId }, controller.signal);
  manager.state.agents.push({ id: 1, label: "report", prompt: "work", status: "done", result: "late report" });
  manager.emit("agentEnd", { runId: item.runId });
  queueMicrotask(() => controller.abort());
  assert.equal((await pending).details.interrupted, true);
  const next = await executeOutput(manager, { runId: item.runId, block: false });
  assert.match(next.content[0].text, /late report/);
});

test("cold output retrieval preserves failure diagnostics and best-effort work", async () => {
  const manager = outputManager({
    ...run("failed"),
    sessionId: "session-a",
    failure: { message: "Provider unavailable", code: "AGENT_EXECUTION_ERROR", recoverable: true },
    result: { report: "saved findings" },
  });
  const response = await executeOutput(manager, { runId: "audit-abc123" });
  assert.match(response.content[0].text, /Provider unavailable/);
  assert.match(response.content[0].text, /saved findings/);
  assert.match(response.content[0].text, /resume the same run/);
  assert.equal(response.details.recoverable, true);
});

test("partial completion is clearly distinguished from full success", async () => {
  const manager = outputManager({
    ...run("completed"),
    sessionId: "session-a",
    outcome: "partial",
    result: "usable subset",
  });
  const response = await executeOutput(manager, { runId: "audit-abc123" });
  assert.equal(response.details.completed, true);
  assert.equal(response.details.partial, true);
  assert.match(response.content[0].text, /partially completed/);
  assert.match(response.content[0].text, /usable subset/);
});

test("get_workflow_output returns a bounded completed result immediately", async () => {
  const manager = outputManager({
    ...run("completed"),
    sessionId: "session-a",
    result: { report: "final report", evidence: ["a", "b"] },
  });
  const tool = createGetWorkflowOutputTool({ manager, getResultMaxChars: () => 80 });
  const response = await (tool.execute as any)(
    "output-call",
    { runId: "audit-abc123", block: true },
    undefined,
    undefined,
    {},
  );

  assert.equal(response.details.completed, true);
  assert.equal(response.details.status, "completed");
  assert.equal(response.details.inputPending, undefined);
  assert.match(response.content[0].text, /final report/);
  assert.match(response.content[0].text, /Full persisted run: \[path redacted\]/);
  assert.equal(response.details.resultPath, "[path redacted]");
  assert.equal(manager.eventNames().length, 0);
});

test("get_workflow_output waits on lifecycle events once and removes every listener", async () => {
  const manager = outputManager({ ...run("running"), sessionId: "session-a" });
  const pending = executeOutput(manager, { runId: "audit-abc123", block: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  for (const eventName of ["complete", "error", "stopped", "paused", "deleted"]) {
    assert.equal(manager.listenerCount(eventName), 1);
  }
  assert.equal(manager.listenerCount("delivery"), 1);
  assert.equal(manager.listenerCount("agentEnd"), 1);
  assert.equal(manager.listenerCount("parentInput"), 1);
  manager.emit("complete", { runId: "other-run" });
  manager.state = { ...manager.state, status: "completed", result: "verified output" };
  manager.emit("complete", { runId: "audit-abc123" });

  const response = await pending;
  assert.equal(response.details.completed, true);
  assert.match(response.content[0].text, /verified output/);
  for (const eventName of ["complete", "error", "stopped", "paused", "deleted"]) {
    assert.equal(manager.listenerCount(eventName), 0);
  }
  assert.equal(manager.listenerCount("delivery"), 0);
  assert.equal(manager.listenerCount("agentEnd"), 0);
  assert.equal(manager.listenerCount("parentInput"), 0);
});

test("waiting UI subscribes before publishing progress so immediate user input cannot be missed", async () => {
  const manager = outputManager({ ...run("running"), sessionId: "session-a" });
  const tool = createGetWorkflowOutputTool({ manager });
  const updates: any[] = [];
  const response = await (tool.execute as any)("wait-ui", { runId: "audit-abc123" }, undefined, (update: any) => {
    updates.push(update);
    releaseWorkflowOutputWaitForInput(manager, "audit-abc123");
  });
  assert.equal(updates.length, 1);
  assert.match(updates[0].content[0].text, /Esc cancels the wait only/);
  assert.equal(response.details.inputPending, true);
  assert.equal(manager.eventNames().length, 0);
  assert.equal(manager.state.status, "running");
});

test("get_workflow_output immediately returns an unconsumed completed agent result exactly once", async () => {
  const item = { ...run("running"), sessionId: "session-a" };
  item.agents[0] = {
    id: 1,
    callId: "audit-abc123:0",
    label: "completed scan",
    phase: "Inspect",
    prompt: "scan",
    status: "done",
    resultPreview: "compact preview",
    tokens: 30,
  };
  item.journal = [
    {
      index: 0,
      runId: "audit-abc123",
      hash: "scan-hash",
      result: { findings: ["full agent result"] },
    },
  ];
  const manager = outputManager(item);

  const first = await executeOutput(manager, { runId: "audit-abc123", block: false });
  assert.equal(first.details.completed, false);
  assert.deepEqual(first.details.agentOutputs, [
    {
      id: 1,
      callId: "audit-abc123:0",
      label: "completed scan",
      phase: "Inspect",
      status: "done",
    },
  ]);
  assert.match(first.content[0].text, /full agent result/);
  assert.match(first.content[0].text, /call get_workflow_output again only if/i);

  const secondPending = executeOutput(manager, { runId: "audit-abc123", block: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseWorkflowOutputWaitForInput(manager, "audit-abc123");
  const second = await secondPending;
  assert.equal(second.details.agentOutputs, undefined);
  assert.equal(second.details.inputPending, true, "the same completed result is not returned twice");
});

test("get_workflow_output drains every completed agent across bounded batches", async () => {
  const item = { ...run("running"), sessionId: "session-a" };
  item.agents = Array.from({ length: 18 }, (_, index) => ({
    id: index + 1,
    callId: `${item.runId}:${index}`,
    label: `agent ${index + 1}`,
    prompt: "scan",
    status: "done" as const,
    result: `result ${index + 1}`,
  }));
  const manager = outputManager(item);
  const ids: number[] = [];
  for (const expectedCount of [8, 8, 2]) {
    const response = await executeOutput(manager, { runId: item.runId, block: false });
    assert.equal(response.details.agentOutputs?.length, expectedCount);
    ids.push(...response.details.agentOutputs.map((output: { id: number }) => output.id));
    assert.equal(response.details.hasMoreAgentOutputs === true, ids.length < 18);
  }
  assert.deepEqual(
    ids,
    item.agents.map((agent) => agent.id),
  );
  const empty = await executeOutput(manager, { runId: item.runId, block: false });
  assert.equal(empty.details.agentOutputs, undefined);
});

test("get_workflow_output wakes on agentEnd and returns the live subagent result", async () => {
  const manager = outputManager({ ...run("running"), sessionId: "session-a" });
  const pending = executeOutput(manager, { runId: "audit-abc123", block: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  manager.state = {
    ...manager.state,
    agents: manager.state.agents.map((agent) =>
      agent.id === 1
        ? {
            ...agent,
            callId: "audit-abc123:0",
            status: "done" as const,
            resultPreview: "agent completed",
          }
        : agent,
    ),
    journal: [
      {
        index: 0,
        runId: "audit-abc123",
        hash: "scan-hash",
        result: "live completed result",
      },
    ],
  };
  manager.emit("agentEnd", { runId: "other-run", id: "other-run:0", result: "ignore" });
  manager.emit("agentEnd", { runId: "audit-abc123", id: "audit-abc123:0", result: "live completed result" });

  const response = await pending;
  assert.equal(response.details.completed, false);
  assert.equal(response.details.agentOutputs?.[0]?.callId, "audit-abc123:0");
  assert.match(response.content[0].text, /live completed result/);
  assert.equal(manager.eventNames().length, 0);
});

test("get_workflow_output prefers a terminal workflow result over the final agent batch", async () => {
  const manager = outputManager({ ...run("running"), sessionId: "session-a" });
  const pending = executeOutput(manager, { runId: "audit-abc123", block: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  manager.state = {
    ...manager.state,
    status: "completed",
    result: "semantic terminal result",
    agents: manager.state.agents.map((agent) =>
      agent.id === 1 ? { ...agent, status: "done" as const, result: "synthesizer result" } : agent,
    ),
  };
  manager.emit("agentEnd", { runId: "audit-abc123", id: "audit-abc123:0", result: "synthesizer result" });

  const response = await pending;
  assert.equal(response.details.completed, true);
  assert.equal(response.details.agentOutputs, undefined);
  assert.match(response.content[0].text, /semantic terminal result/);
});

test("get_workflow_output yields as soon as durable parent-visible output arrives", async () => {
  const manager = outputManager({ ...run("running"), sessionId: "session-a" });
  const pending = executeOutput(manager, { runId: "audit-abc123", block: true });
  await new Promise<void>((resolve) => setImmediate(resolve));

  manager.emit("delivery", { runId: "other-run", deliveryId: "wf_other" });
  manager.emit("delivery", { runId: "audit-abc123", deliveryId: "wf_finding_1" });

  const response = await pending;
  assert.equal(response.details.completed, false);
  assert.equal(response.details.status, "running");
  assert.equal(response.details.delivered, true);
  assert.match(response.content[0].text, /Process the delivered workflow messages now/);
  assert.match(response.content[0].text, /terminal result will arrive automatically/);
  assert.equal(manager.eventNames().length, 0, "delivery wake removes terminal, delivery, timer, and abort listeners");
});

test("get_workflow_output closes the delivery subscribe/read race through the durable outbox", async () => {
  const manager = outputManager({ ...run("running"), sessionId: "session-a" });
  (manager as any).listPendingDeliveries = () => [
    { runId: "audit-abc123", deliveryId: "wf_already_admitted", kind: "explicit", status: "submitted" },
  ];

  const response = await executeOutput(manager, { runId: "audit-abc123", block: true });
  assert.equal(response.details.delivered, true);
  assert.equal(response.details.completed, false);
  assert.equal(manager.eventNames().length, 0);
});

test("get_workflow_output closes the subscribe/read race without polling", async () => {
  const initial = { ...run("running"), sessionId: "session-a" };
  const completed = { ...initial, status: "completed" as const, result: "race-safe output" };
  const manager = outputManager(initial);
  let reads = 0;
  manager.listRuns = () => [reads++ === 0 ? initial : completed];

  const response = await executeOutput(manager, { runId: initial.runId, block: true });
  assert.equal(response.details.completed, true);
  assert.match(response.content[0].text, /race-safe output/);
  assert.equal(reads, 3);
  assert.equal(manager.eventNames().length, 0);
});

test("get_workflow_output yields for queued input or Esc without stopping the run", async () => {
  const manager = outputManager({ ...run("running"), sessionId: "session-a" });
  const inputPendingPromise = executeOutput(manager, { runId: "audit-abc123", block: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseWorkflowOutputWaitForInput(manager, "audit-abc123");
  const inputPending = await inputPendingPromise;
  assert.equal(inputPending.details.completed, false);
  assert.equal(inputPending.details.inputPending, true);
  assert.equal(inputPending.terminate, undefined, "queued input continues through Pi's normal post-tool boundary");
  assert.match(inputPending.content[0].text, /queued user message/i);
  assert.equal(manager.eventNames().length, 0);

  const controller = new AbortController();
  const outputTool = createGetWorkflowOutputTool({ manager });
  const interruptedPromise = (outputTool.execute as any)(
    "output-call",
    { runId: "audit-abc123", block: true },
    controller.signal,
    undefined,
    {},
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  const interrupted = await interruptedPromise;
  assert.equal(interrupted.details.interrupted, true);
  assert.equal(interrupted.terminate, true, "Esc ends the main agent turn instead of starting another loop");
  assert.match(interrupted.content[0].text, /continues in the background/);
  assert.equal(manager.state.status, "running");
  assert.equal(manager.eventNames().length, 0);
});

test("get_workflow_output fails closed for unbound or foreign-session runs", async () => {
  const foreign = outputManager({ ...run("completed"), sessionId: "session-b", result: "secret" });
  const foreignResponse = await executeOutput(foreign, { runId: "audit-abc123", block: false });
  assert.match(foreignResponse.details.error ?? "", /not found in current session/);
  assert.doesNotMatch(foreignResponse.content[0].text, /secret/);

  const unbound = outputManager({ ...run("completed"), sessionId: "session-a", result: "secret" }, "");
  const unboundResponse = await executeOutput(unbound, { runId: "audit-abc123", block: false });
  assert.match(unboundResponse.details.error ?? "", /ownership is unavailable/);
});

test("list_active_workflows returns only bounded current-session cancellation handles", async () => {
  const runs: PersistedRunState[] = Array.from({ length: 66 }, (_, index) => ({
    ...run(index % 2 === 0 ? "running" : "paused", `active-${String(index).padStart(3, "0")}`),
    workflowName: `workflow ${index}`,
    sessionId: "session-a",
    startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  }));
  runs.push({
    ...run("running", "foreign-001"),
    workflowName: "foreign",
    sessionId: "session-b",
    startedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
  });
  runs.push({
    ...run("completed", "completed-001"),
    workflowName: "completed",
    sessionId: "session-a",
    startedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
  });
  const manager = {
    getSessionId: () => "session-a",
    listRuns: () => runs,
  } as unknown as WorkflowManager;

  const response = await executeList(manager);
  assert.equal(response.details.runs.length, 64);
  assert.equal(response.details.truncated, true);
  assert.equal(response.details.runs[0]?.runId, "active-065");
  assert.deepEqual(Object.keys(response.details.runs[0] ?? {}).sort(), ["name", "runId", "status"]);
  assert.equal(response.details.runs[0]?.name, "workflow 65");
  assert.equal(
    response.details.runs.some(({ runId }: { runId: string }) => runId === "foreign-001"),
    false,
  );
  assert.equal(
    response.details.runs.some(({ runId }: { runId: string }) => runId === "completed-001"),
    false,
  );
  assert.match(response.content[0].text, /More active workflows are available through \/workflows list/);
});

test("list_active_workflows redacts hostile workflow names for model output", async () => {
  const control = "\x1b]52;c;clipboard\x07";
  const hostile = {
    ...run("running", "active-hostile"),
    workflowName: `${control}workflow Bearer secret-token`,
    sessionId: "session-a",
  } as PersistedRunState;
  const manager = {
    getSessionId: () => "session-a",
    listRuns: () => [hostile],
  } as unknown as WorkflowManager;

  const response = await executeList(manager);
  const name = response.details.runs[0]?.name ?? "";
  assert.ok(!name.includes("\x1b") && !name.includes("\x07"));
  assert.doesNotMatch(name, /secret-token/);
  assert.ok(!response.content[0].text.includes("\x1b") && !response.content[0].text.includes("\x07"));
  assert.doesNotMatch(response.content[0].text, /secret-token/);
});

test("list_active_workflows fails closed when current-session ownership is unavailable", async () => {
  const fixture = stopManager({ runSessionId: "session-a" });
  const response = await executeList(fixture.manager);

  assert.deepEqual(response.details.runs, []);
  assert.equal(response.details.truncated, false);
  assert.match(response.details.error ?? "", /ownership is unavailable/);
});

test("session-scoped tools survive a retained pre-upgrade manager without getSessionId", async () => {
  const fixture = stopManager({ runSessionId: "session-a" });
  const legacyManager = fixture.manager as WorkflowManager & { getSessionId?: undefined };
  legacyManager.getSessionId = undefined;
  const options = { manager: legacyManager, getSessionId: () => "session-a" };

  const listTool = createListActiveWorkflowsTool(options);
  const listed = await (listTool.execute as any)("list-call", {}, undefined, undefined, {});
  assert.deepEqual(listed.details.runs, [{ runId: "audit-current-1", name: "audit", status: "running" }]);

  const outputTool = createGetWorkflowOutputTool(options);
  const output = await (outputTool.execute as any)(
    "output-call",
    { runId: "audit-current-1", block: false },
    undefined,
    undefined,
    {},
  );
  assert.equal(output.details.status, "running");
  assert.equal(output.details.error, undefined);

  const stopTool = createStopWorkflowTool(options);
  const stopped = await (stopTool.execute as any)("stop-call", { runId: "audit-current-1" }, undefined, undefined, {});
  assert.equal(stopped.details.stopped, true);
  assert.deepEqual(fixture.calls, ["audit-current-1"]);
});

test("stop_workflow exposes only an exact runId cancellation handle", () => {
  const fixture = stopManager({ sessionId: "session-a", runSessionId: "session-a" });
  const tool = createStopWorkflowTool({ manager: fixture.manager });

  assert.equal(tool.name, "stop_workflow");
  assert.match(tool.description, /this Pi session/i);
  assert.match(tool.description, /Exact runId required/i);
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(Check(tool.parameters, { runId: "audit-current-1" }), true);
  assert.equal(Check(tool.parameters, {}), false);
  assert.equal(Check(tool.parameters, { runId: "audit-current-1", action: "stop" }), false);

  const prepare = tool.prepareArguments as (value: unknown) => unknown;
  assert.throws(() => prepare({}), /requires runId/);
  assert.throws(() => prepare({ runId: "../foreign" }), /canonical runId/);
  assert.throws(() => prepare({ runId: "audit-current-1", action: "stop" }), /does not accept action/);
});

test("stop_workflow stops an exact running or paused run owned by the current session", async () => {
  for (const status of ["running", "paused"] as const) {
    const fixture = stopManager({ sessionId: "session-a", runSessionId: "session-a", status });
    const response = await executeStop(fixture.manager, { runId: "audit-current-1" });

    assert.equal(response.details.stopped, true);
    assert.equal(response.details.status, "aborted");
    assert.equal((response as { terminate?: boolean }).terminate, undefined);
    assert.deepEqual(fixture.calls, ["audit-current-1"]);
    assert.match(response.content[0].text, /Workflow stopped/);
  }
});

test("stop_workflow fails closed without a session binding or for a foreign-session run", async () => {
  const unbound = stopManager({ runSessionId: "session-a" });
  const unboundResponse = await executeStop(unbound.manager, { runId: "audit-current-1" });
  assert.equal(unboundResponse.details.stopped, false);
  assert.match(unboundResponse.details.error ?? "", /ownership is unavailable/);
  assert.deepEqual(unbound.calls, []);

  const foreign = stopManager({ sessionId: "session-a", runSessionId: "session-b" });
  const foreignResponse = await executeStop(foreign.manager, { runId: "audit-current-1" });
  assert.equal(foreignResponse.details.stopped, false);
  assert.match(foreignResponse.details.error ?? "", /not found in current session/);
  assert.deepEqual(foreign.calls, []);
});

test("stop_workflow does not retry or mutate an already terminal run", async () => {
  const fixture = stopManager({ sessionId: "session-a", runSessionId: "session-a", status: "completed" });
  const response = await executeStop(fixture.manager, { runId: "audit-current-1" });

  assert.equal(response.details.stopped, false);
  assert.equal(response.details.status, "completed");
  assert.match(response.details.error ?? "", /cannot stop run with status completed/);
  assert.deepEqual(fixture.calls, []);
});

test("workflow_control exposes concise lifecycle actions in a strict schema", () => {
  const { manager } = fakeManager([]);
  const tool = createWorkflowControlTool({ manager });

  assert.equal(tool.name, "workflow_control");
  const guidance = [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join(" ");
  assert.equal(tool.description, "Pause, resume, or stop one workflow by runId.");
  assert.doesNotMatch(guidance, /no status|polling|never|do not|cleanup/i);
  assert.doesNotMatch(guidance, /agent-completed|subagent-completion/i);
  assert.equal(tool.promptSnippet, undefined, "control semantics stay in one provider-visible description");
  assert.equal(tool.promptGuidelines, undefined, "control adds no duplicate permanent prompt rules");

  assert.equal((tool.parameters as { type?: string }).type, "object");
  assert.equal(Check(tool.parameters, { action: "pause", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "resume", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "stop", runId: "abc" }), true);
  assert.equal(Check(tool.parameters, { action: "list" }), false);
  assert.equal(Check(tool.parameters, { action: "status", runId: "abc" }), false);
  assert.equal(Check(tool.parameters, { action: "pause" }), false);
  assert.equal(Check(tool.parameters, { action: "restart", runId: "abc" }), false);
  assert.equal(Check(tool.parameters, { action: "pause", runId: "abc", extra: true }), false);

  const prepare = tool.prepareArguments as (value: unknown) => unknown;
  assert.throws(() => prepare({ action: "pause" }), /requires runId/);
  assert.throws(() => prepare({ action: "status", runId: "abc" }), /requires action/);
  assert.throws(() => prepare({ action: "list" }), /requires action/);
  assert.throws(() => prepare({ action: "pause", runId: "abc", extra: true }), /does not accept extra/);
});

test("workflow_control renders lifecycle actions as a readable summary", async () => {
  const fixture = fakeManager([run()]);
  const tool = createWorkflowControlTool({ manager: fixture.manager });
  const call = tool.renderCall?.(
    { action: "stop", runId: "workflow-footer-multi-run-redesign-msvbe0aq-pd5kj3" } as never,
    renderTheme as never,
  );
  assert.ok(call);
  assert.match(renderedText(call as never), /^workflow stop · workflow-footer-mu…0aq-pd5kj3$/);

  const stopped = await execute(fixture.manager, { action: "stop", runId: "audit-abc123" });
  const result = tool.renderResult?.(
    stopped as never,
    { isPartial: false, expanded: false } as never,
    renderTheme as never,
  );
  assert.ok(result);
  const output = renderedText(result as never);
  assert.match(output, /^■ Workflow stopped/m);
  assert.match(output, /audit · 0\/4 agents/);
  assert.match(output, /audit-abc123/);
  assert.doesNotMatch(output, /action=|result=|runId=|total=|queued=|tokens=/);
});

test("workflow_control renders cancellation tails as settling requests, not active work", async () => {
  const running = run("running", "paused-render");
  const { manager } = fakeManager([running], {}, { [running.runId]: { executionSettled: false } });
  const tool = createWorkflowControlTool({ manager });
  const paused = await execute(manager, { action: "pause", runId: running.runId });
  const component = tool.renderResult?.(
    paused as never,
    { isPartial: false, expanded: false } as never,
    renderTheme as never,
  );
  assert.ok(component);
  const output = renderedText(component as never);
  assert.match(output, /pausing 1 request/);
  assert.doesNotMatch(output, /1 active/);
});

test("get_workflow_output renders a yielded delivery as finished output, not ongoing work", () => {
  const fixture = fakeManager([run()]);
  const tool = createGetWorkflowOutputTool({ manager: fixture.manager, getSessionId: () => "session-1" });
  const component = tool.renderResult?.(
    {
      content: [],
      details: {
        runId: "audit-abc123",
        status: "running",
        completed: false,
        blocked: true,
        delivered: true,
      },
    } as never,
    { isPartial: false, expanded: false } as never,
    renderTheme as never,
  );
  assert.ok(component);
  assert.equal(renderedText(component as never), "Output delivered audit-abc123");
});

test("get_workflow_output renders a completed agent batch as returned output", () => {
  const fixture = fakeManager([run()]);
  const tool = createGetWorkflowOutputTool({ manager: fixture.manager, getSessionId: () => "session-1" });
  const component = tool.renderResult?.(
    {
      content: [],
      details: {
        runId: "audit-abc123",
        status: "running",
        completed: false,
        blocked: true,
        agentOutputs: [
          { id: 1, callId: "audit-abc123:0", label: "scan", status: "done" },
          { id: 2, callId: "audit-abc123:1", label: "review", status: "done" },
        ],
      },
    } as never,
    { isPartial: false, expanded: false } as never,
    renderTheme as never,
  );
  assert.ok(component);
  assert.equal(renderedText(component as never), "2 agent outputs audit-abc123");
});

test("get_workflow_output renders partial and validation-error results without unknown undefined", () => {
  const fixture = fakeManager([run()]);
  const tool = createGetWorkflowOutputTool({ manager: fixture.manager, getSessionId: () => "session-1" });
  const partial = tool.renderResult?.(
    { content: [], details: undefined } as never,
    { isPartial: true, expanded: false } as never,
    renderTheme as never,
  );
  const invalid = tool.renderResult?.(
    {
      content: [{ type: "text", text: "get_workflow_output does not accept timeoutMs" }],
      details: undefined,
    } as never,
    { isPartial: false, expanded: false } as never,
    renderTheme as never,
  );

  assert.ok(partial && invalid);
  assert.equal(renderedText(partial as never), "Waiting for workflow output… · Type to interject · Esc cancels wait");
  assert.equal(renderedText(invalid as never), "get_workflow_output does not accept timeoutMs");
});

test("pause, resume, and stop call the shared manager lifecycle methods", async () => {
  const fixture = fakeManager([run()]);
  assert.match(text(await execute(fixture.manager, { action: "pause", runId: "audit-abc123" })), /result=paused/);
  assert.match(text(await execute(fixture.manager, { action: "resume", runId: "audit-abc123" })), /result=resumed/);
  assert.match(text(await execute(fixture.manager, { action: "stop", runId: "audit-abc123" })), /result=stopped/);
  assert.deepEqual(
    fixture.calls.map((call) => call.action),
    ["pause", "resume", "stop"],
  );
});

test("stop succeeds for a run resolved from disk but not tracked in memory", async () => {
  const coldRun = run("paused", "cold-restart-1");
  const runs = new Map([[coldRun.runId, coldRun]]);
  const manager = {
    listRuns: () => [...runs.values()],
    getSnapshot: () => null,
    getRun: () => undefined,
    pause: () => false,
    async resume() {
      return false;
    },
    stop(runId: string) {
      const item = runs.get(runId);
      if (!item || (item.status !== "running" && item.status !== "paused")) return false;
      item.status = "aborted";
      return true;
    },
  } as unknown as WorkflowManager;

  const response = await execute(manager, { action: "stop", runId: "cold-restart-1" });
  assert.match(text(response), /^action=stop result=stopped /);
  assert.equal(response.details.result, "stopped");
  assert.doesNotMatch(text(response), /invalidTransition|cannot stop/);
});

test("a manager exception is returned as a structured tool error", async () => {
  const throwingRun = run("paused", "throws-1");
  const manager = {
    listRuns: () => [throwingRun],
    getSnapshot: () => null,
    getRun: () => undefined,
    pause: () => false,
    async resume() {
      return false;
    },
    stop() {
      throw new Error("disk I/O failed");
    },
  } as unknown as WorkflowManager;

  const response = await execute(manager, { action: "stop", runId: "throws-1" });
  assert.match(text(response), /^action=stop result=error runId=throws-1 error=disk I\/O failed/);
  assert.equal(response.details.result, "error");
  assert.equal(response.details.error, "disk I/O failed");
});

test("workflow_control redacts manager exception text before returning control errors", async () => {
  const control = "\x1b]8;;https://evil.example\x07";
  const throwingRun = run("paused", "throws-hostile");
  const manager = {
    listRuns: () => [throwingRun],
    getSnapshot: () => null,
    getRun: () => undefined,
    pause: () => false,
    async resume() {
      return false;
    },
    stop() {
      throw new Error(`${control}Bearer secret-token`);
    },
  } as unknown as WorkflowManager;

  const response = await execute(manager, { action: "stop", runId: "throws-hostile" });
  const output = text(response);
  assert.ok(!output.includes("\x1b") && !output.includes("\x07"));
  assert.doesNotMatch(output, /secret-token/);
  assert.equal(response.details.error, "Bearer [REDACTED]");
});

test("unknown IDs and illegal transitions return explicit mutation-only actions", async () => {
  const fixture = fakeManager([run("completed"), run("running", "live-123")]);
  const unknown = text(await execute(fixture.manager, { action: "pause", runId: "missing" }));
  assert.match(unknown, /result=error runId=missing error=run not found allowed=none/);

  const pauseCompleted = text(await execute(fixture.manager, { action: "pause", runId: "audit-abc123" }));
  assert.match(pauseCompleted, /cannot pause run with status completed/);
  assert.match(pauseCompleted, /allowed=none/);

  await execute(fixture.manager, { action: "stop", runId: "live-123" });
  const stopAborted = text(await execute(fixture.manager, { action: "stop", runId: "live-123" }));
  assert.match(stopAborted, /cannot stop run with status aborted/);
  assert.match(stopAborted, /allowed=none/);
});
test("workflow_control rejects runs owned by another session", async () => {
  const mine = { ...run(), sessionId: "session-a" } as PersistedRunState;
  const foreign = { ...run("running", "foreign-run"), sessionId: "session-b" } as PersistedRunState;
  const manager = {
    getSessionId: () => "session-a",
    listRuns: () => [mine, foreign],
    pause() {
      return true;
    },
    resume: async () => true,
    stop() {
      return true;
    },
  } as unknown as WorkflowManager;
  const response = await execute(manager, { action: "pause", runId: "foreign-run" });
  assert.match(response.content[0].text, /run not found in current session/);
  assert.equal(response.details.error, "run not found in current session");
});

test("workflow_control allows runs owned by the current session", async () => {
  const mine = { ...run(), sessionId: "session-a" } as PersistedRunState;
  const calls: string[] = [];
  const manager = {
    getSessionId: () => "session-a",
    listRuns: () => [mine],
    pause(runId: string) {
      calls.push(`pause:${runId}`);
      mine.status = "paused";
      return true;
    },
    resume: async () => true,
    stop() {
      return true;
    },
  } as unknown as WorkflowManager;
  const response = await execute(manager, { action: "pause", runId: "audit-abc123" });
  assert.deepEqual(calls, ["pause:audit-abc123"]);
  assert.doesNotMatch(response.content[0].text, /not found|not owned/);
});
