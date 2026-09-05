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

test("Agent Team exposes only classified, targeted model-facing messages", async () => {
  const team = new WorkflowAgentTeam("team", "classified", 3, { maxMessages: 8 });
  const a = team.addMember("a");
  const b = team.addMember("b");
  const c = team.addMember("c");
  const tools = team.createTools(a);
  const send = tools.find((tool) => tool.name === "team_send_message");
  const broadcast = tools.find((tool) => tool.name === "team_broadcast");
  assert.ok(send);
  assert.equal(broadcast, undefined, "peer-wide broadcast is workflow-owned, not model-facing");

  assert.ok((send.parameters as { required?: string[] }).required?.includes("kind"));
  assert.equal(send.description, "Send a blocker, task-changing fact, or decision to one teammate.");
  assert.doesNotMatch(send.description, /never|do not|progress|acknowledgements/i);

  await assert.rejects(
    () => send.execute("missing-kind", { to: b, message: "unclassified" } as never),
    /requires kind/i,
  );
  await assert.rejects(
    () => send.execute("invalid-kind", { to: b, kind: "progress", message: "routine update" } as never),
    /requires kind/i,
  );
  const sent = await send.execute("classified-send", {
    to: b,
    kind: "blocker",
    message: "Need the migration version.",
  });
  assert.equal((sent.details as { kind?: string }).kind, "blocker");
  assert.equal(team.readInbox(b)[0]?.kind, "blocker");

  team.broadcast(a, "decision", "Use migration v3.");
  assert.equal(team.readInbox(b)[0]?.kind, "decision");
  assert.equal(team.readInbox(c)[0]?.kind, "decision");

  const workflowMessage = team.sendFromWorkflow(c, "Use the workflow instruction as the next input.");
  assert.equal(workflowMessage.kind, "workflow_instruction");
});

test("Agent Team inbox can wait for a peer event without polling", async () => {
  const team = new WorkflowAgentTeam("team", "wait", 2, { maxMessages: 4 });
  const sender = team.addMember("sender");
  const receiver = team.addMember("receiver");
  const inbox = team.createTools(receiver).find((tool) => tool.name === "team_inbox");
  assert.ok(inbox);

  const pending = inbox.execute("wait", { waitMs: 1_000 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  team.sendFromWorkflow(receiver, "peer is ready");
  const result = await pending;
  assert.deepEqual(
    (result.details as { messages: Array<{ message: string }>; timedOut: boolean }).messages.map((m) => m.message),
    ["peer is ready"],
  );
  assert.equal((result.details as { timedOut: boolean }).timedOut, false);
  assert.equal(team.readInbox(receiver).length, 0, "a completed wait consumes the delivered message once");
  assert.equal(sender, "team:member:1");
});

test("Agent Team inbox wait reports a bounded timeout", async () => {
  const team = new WorkflowAgentTeam("team", "wait-timeout", 1);
  const receiver = team.addMember("receiver");
  const inbox = team.createTools(receiver).find((tool) => tool.name === "team_inbox");
  assert.ok(inbox);
  const result = await inbox.execute("timeout", { waitMs: 1 });
  assert.deepEqual(result.details, { messages: [], timedOut: true });
});

test("Agent Team inbox wait is abortable", async () => {
  const team = new WorkflowAgentTeam("team", "wait-abort", 1);
  const receiver = team.addMember("receiver");
  const inbox = team.createTools(receiver).find((tool) => tool.name === "team_inbox");
  assert.ok(inbox);
  const controller = new AbortController();
  const pending = inbox.execute("abort", { waitMs: 1_000 }, controller.signal);
  controller.abort(new Error("caller stopped waiting"));
  await assert.rejects(pending, /caller stopped waiting/);
  assert.equal(team.snapshot().pendingMessages, 0);
});

test("Agent Team committed spawn rollback restores metadata, members, sequence, and quota", () => {
  let reserved = 0;
  const team = new WorkflowAgentTeam("team", "transactional", 4, {
    quota: {
      reserveMembers: (count) => {
        reserved += count;
      },
      releaseMembers: (count) => {
        reserved -= count;
      },
      reserveTasks: () => {},
      reserveMessages: () => {},
    },
  });
  const existing = team.addMember("before", "original", "existing");
  assert.equal(reserved, 1);

  const planned = team.planSpawn([
    { prompt: "reuse", memberId: existing, label: "after", role: "changed" },
    { prompt: "new", label: "temporary" },
  ]);
  const committed = team.commitSpawn(planned);
  assert.equal(reserved, 2);
  assert.equal(team.listMembers().length, 2);
  assert.equal(team.listMembers().find((member) => member.id === existing)?.label, "after");

  assert.deepEqual(team.rollbackCommittedSpawn(planned), [committed[1]]);
  assert.equal(reserved, 1);
  assert.deepEqual(team.listMembers(), [{ id: existing, label: "before", role: "original", status: "registered" }]);

  const next = team.addMember("next");
  assert.equal(next, "team:member:1", "rolled-back auto IDs must not leave a sequence gap");
});
