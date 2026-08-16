import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import type { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowSteerTool } from "../src/workflow-steer-tool.js";

test("workflow_steer exposes a compact same-task route", () => {
  const tool = createWorkflowSteerTool({ manager: {} as WorkflowManager });
  const schema = tool.parameters as { required?: string[] };

  assert.equal(tool.name, "workflow_steer");
  assert.ok(schema.required?.includes("runId"));
  assert.ok(schema.required?.includes("message"));
  assert.ok(schema.required?.includes("kind"));
  assert.equal(Check(tool.parameters, { runId: "run-a", message: "changed fact", kind: "changed_fact" }), true);
  assert.equal(Check(tool.parameters, { message: "new request" }), false);
  assert.equal(tool.description, "Send a same-task update to one identified workflow run.");
  assert.doesNotMatch(tool.description, /never|do not/i);
  assert.equal(tool.promptSnippet, undefined);
  assert.equal(tool.promptGuidelines, undefined);
});

test("workflow_steer normalization rejects missing, unsafe, and extra targets", () => {
  const tool = createWorkflowSteerTool({ manager: {} as WorkflowManager });
  const prepare = tool.prepareArguments as (value: unknown) => unknown;

  assert.throws(() => prepare({ message: "new unrelated request", kind: "same_task_correction" }), /requires a runId/i);
  assert.throws(
    () => prepare({ runId: "../old", message: "correction", kind: "same_task_correction" }),
    /canonical runId/i,
  );
  assert.throws(
    () => prepare({ runId: "run-a", message: "correction", kind: "same_task_correction", newest: true }),
    /does not accept newest/i,
  );
  assert.throws(() => prepare({ runId: "run-a", message: "correction" }), /same-task kind/i);
  assert.throws(() => prepare({ runId: "run-a", message: "x".repeat(8_001), kind: "changed_fact" }), /within 8000/i);
});

test("workflow_steer queues only to the explicitly identified run", async () => {
  const calls: Array<{ message: string; runId: string; kind: string }> = [];
  const manager = {
    enqueueUserMessage(message: string, runId: string, kind: string) {
      calls.push({ message, runId, kind });
      return runId;
    },
  } as unknown as WorkflowManager;
  const tool = createWorkflowSteerTool({ manager });

  const result = await tool.execute(
    "steer-1",
    { runId: "run-a", message: "  changed fact  ", kind: "changed_fact" },
    undefined,
    undefined,
    undefined,
  );
  assert.deepEqual(calls, [{ message: "  changed fact  ", runId: "run-a", kind: "changed_fact" }]);
  assert.deepEqual(result.details, {
    runId: "run-a",
    agentId: "",
    message: "  changed fact  ",
    kind: "changed_fact",
    mode: "next-agent",
  });
});

test("workflow_steer requires the agentId to belong to the same runId", async () => {
  const calls: Array<{ message: string; agentId: string; runId: string; kind: string }> = [];
  const manager = {
    async sendToAgent(message: string, agentId: string, runId: string, kind: string) {
      calls.push({ message, agentId, runId, kind });
      return agentId.startsWith(`${runId}:`) ? runId : undefined;
    },
  } as unknown as WorkflowManager;
  const tool = createWorkflowSteerTool({ manager });

  await assert.rejects(
    () =>
      tool.execute(
        "steer-2",
        { runId: "run-a", agentId: "run-b:0", message: "correction", kind: "same_task_correction" },
        undefined,
        undefined,
        undefined,
      ),
    /not running in workflow run-a/i,
  );
  assert.deepEqual(calls, [
    { message: "correction", agentId: "run-b:0", runId: "run-a", kind: "same_task_correction" },
  ]);
});
