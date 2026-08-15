import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowAgentTeam } from "../src/agent-team.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { runWorkflow } from "../src/workflow.js";

test("workflow logs fail closed at the finite resource boundary", async () => {
  const script = `export const meta = { name: "log-bound", description: "bounded logs" }
for (let i = 0; i < 10001; i++) log("entry")
await agent("must not submit")`;
  await assert.rejects(
    runWorkflow(script, {
      persistLogs: false,
      agent: {
        async run() {
          throw new Error("provider submission");
        },
      },
    }),
    (error: unknown) => error instanceof WorkflowError && error.code === WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
  );
});

test("Agent Team bounds tasks and rejects oversized task text before mutation", () => {
  const team = new WorkflowAgentTeam("team", "bounded", 2, { maxTasks: 2, maxMessages: 2 });
  const task = team.addTask("one");
  assert.equal(task, "team:task:1");
  assert.throws(() => team.addTask("x".repeat(16_385)), /text.*limit/i);
  const task2 = team.addTask("two");
  assert.equal(task2, "team:task:2");
  assert.throws(() => team.addTask("three"), /task limit/i);
  assert.equal(team.listTasks().length, 2, "rejected task admission must not mutate the board");
});

test("Agent Team broadcast preflights all recipients and does not partially enqueue", () => {
  const team = new WorkflowAgentTeam("team", "broadcast", 3, { maxMessages: 2 });
  const a = team.addMember("a");
  const b = team.addMember("b");
  team.sendFromWorkflow(a, "one");
  assert.throws(() => team.broadcastFromWorkflow("two"), /message limit|inbox.*full/i);
  assert.equal(team.readInbox(b).length, 0, "failed broadcast must not partially deliver");
});
