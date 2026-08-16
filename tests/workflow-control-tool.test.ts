import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { WorkflowSnapshot } from "../src/display.js";
import type { PersistedRunState, RunStatus } from "../src/run-persistence.js";
import { createWorkflowControlTool } from "../src/workflow-control-tool.js";
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

const renderTheme = {
  fg: (_color: string, value: string) => value,
  bold: (value: string) => value,
};

function renderedText(component: { render(width: number): string[] }): string {
  return component
    .render(160)
    .map((line) => line.trimEnd())
    .join("\n");
}

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
