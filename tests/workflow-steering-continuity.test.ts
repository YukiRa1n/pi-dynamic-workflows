import assert from "node:assert/strict";
import test from "node:test";
import {
  createFollowUpPriorityContinuity,
  installFollowUpPriority,
  projectFollowUpPriorityContext,
} from "../extensions/follow-up-priority.js";

test("interactive steer is tagged without changing the visible user content", () => {
  const continuity = createFollowUpPriorityContinuity();
  const content = [
    { type: "text", text: "补充：" },
    { type: "text", text: "同时检查重试逻辑" },
    { type: "image", data: "image-data", mimeType: "image/png" },
  ];
  const original = { role: "user", content, timestamp: 1 };

  continuity.observeInput({
    source: "interactive",
    streamingBehavior: "steer",
    text: "补充：\n同时检查重试逻辑",
  });
  const marked = continuity.markMessage(original);

  assert.notEqual(marked, original);
  assert.equal(marked?.steering, true);
  assert.equal(marked?.followUpPriorityKind, "steer");
  assert.equal(typeof marked?.followUpPriorityId, "string");
  assert.deepEqual(marked?.content, content);
  assert.equal(Object.hasOwn(original, "steering"), false, "the finalized input object is not mutated by the helper");
  assert.equal(continuity.markMessage(original), undefined, "one observed steer tags exactly one queued message");
});

test("idle prompts, extension input, blank input, and slash expansion are not tagged", () => {
  const continuity = createFollowUpPriorityContinuity();
  const ignored = [
    { source: "interactive" as const, streamingBehavior: undefined, text: "idle" },
    { source: "extension" as const, streamingBehavior: "steer" as const, text: "internal" },
    { source: "rpc" as const, streamingBehavior: "steer" as const, text: "   " },
    { source: "interactive" as const, streamingBehavior: "steer" as const, text: "/skill:review target" },
  ];

  for (const event of ignored) continuity.observeInput(event);

  for (const event of ignored) {
    assert.equal(
      continuity.markMessage({ role: "user", content: [{ type: "text", text: event.text }], timestamp: 1 }),
      undefined,
    );
  }
});

test("ordinary follow-ups receive a durable FIFO priority identity", () => {
  const continuity = createFollowUpPriorityContinuity();
  continuity.observeInput({ source: "interactive", streamingBehavior: "followUp", text: "afterwards" });
  const marked = continuity.markMessage({ role: "user", content: "afterwards", timestamp: 1 });

  assert.equal(marked?.followUpPriorityKind, "followUp");
  assert.equal(typeof marked?.followUpPriorityId, "string");
  assert.equal(marked?.steering, undefined);
});

test("RPC steer survives a settled boundary only while Pi still reports a queued message", () => {
  const continuity = createFollowUpPriorityContinuity();
  continuity.observeInput({ source: "rpc", streamingBehavior: "steer", text: "new fact" });
  continuity.settle(true);

  assert.equal(
    continuity.markMessage({ role: "user", content: [{ type: "text", text: "new fact" }], timestamp: 1 })?.steering,
    true,
  );

  continuity.observeInput({ source: "rpc", streamingBehavior: "steer", text: "stale fact" });
  continuity.settle(false);

  assert.equal(
    continuity.markMessage({ role: "user", content: [{ type: "text", text: "stale fact" }], timestamp: 2 }),
    undefined,
  );

  continuity.observeInput({ source: "rpc", streamingBehavior: "steer", text: "new fact" });
  continuity.reset();
  assert.equal(
    continuity.markMessage({ role: "user", content: [{ type: "text", text: "new fact" }], timestamp: 3 }),
    undefined,
  );
});

test("a same-text fresh prompt cannot consume a steer stranded across agent_settled", () => {
  const continuity = createFollowUpPriorityContinuity();
  const message = { role: "user", content: [{ type: "text", text: "same text" }], timestamp: 1 };

  continuity.observeInput({ source: "interactive", streamingBehavior: "steer", text: "same text" });
  continuity.settle(true);
  continuity.observeInput({ source: "interactive", streamingBehavior: undefined, text: "same text" });

  assert.equal(continuity.markMessage(message), undefined, "the fresh prompt is emitted before the stranded steer");
  assert.equal(continuity.markMessage({ ...message, timestamp: 2 })?.steering, true);
});

test("agent_settled wakes a stranded user steer after leaving the lifecycle callback", async () => {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const sent: Array<{ message: any; options: any }> = [];
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };
  installFollowUpPriority(pi as any);

  handlers.input[0]({ source: "rpc", streamingBehavior: "steer", text: "late update" });
  handlers.agent_settled[0]({}, { isIdle: () => true, hasPendingMessages: () => true });
  assert.equal(sent.length, 0, "the wake must not run reentrantly inside agent_settled");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.customType, "follow-up-priority-wake");
  assert.deepEqual(sent[0].message.content, [], "the wake carries no provider-facing instruction text");
  assert.equal(sent[0].message.display, false);
  assert.deepEqual(sent[0].options, { triggerTurn: true });
});

test("an explicitly aborted run never auto-wakes its still-queued steer", async () => {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const sent: any[] = [];
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  installFollowUpPriority(pi as any);

  handlers.input[0]({ source: "rpc", streamingBehavior: "steer", text: "queued before abort" });
  handlers.agent_end[0]({
    messages: [{ role: "assistant", content: [], stopReason: "aborted", timestamp: 1 }],
  });
  handlers.agent_settled[0]({}, { isIdle: () => true, hasPendingMessages: () => true });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(sent, []);
  handlers.session_shutdown[0]();
});

test("manual compaction fences an already-scheduled stranded-steer wake", async () => {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const sent: any[] = [];
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx = { isIdle: () => true, hasPendingMessages: () => true };
  installFollowUpPriority(pi as any);

  handlers.input[0]({ source: "rpc", streamingBehavior: "steer", text: "queued during compact" });
  handlers.agent_settled[0]({}, ctx);
  handlers.session_before_compact[0]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(sent, [], "the compaction fence cancels the settled wake");
  handlers.session_shutdown[0]();
});

test("tree, switch, and fork preflight fence a scheduled stranded-steer wake", async () => {
  for (const eventName of ["session_before_tree", "session_before_switch", "session_before_fork"]) {
    const handlers: Record<string, Array<(...args: any[]) => any>> = {};
    const sent: any[] = [];
    const pi = {
      on(event: string, handler: (...args: any[]) => any) {
        handlers[event] ??= [];
        handlers[event].push(handler);
      },
      sendMessage(message: any) {
        sent.push(message);
      },
    };
    installFollowUpPriority(pi as any);

    handlers.input[0]({ source: "rpc", streamingBehavior: "steer", text: `queued before ${eventName}` });
    handlers.agent_settled[0]({}, { isIdle: () => true, hasPendingMessages: () => true });
    handlers[eventName][0]();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(sent, [], `${eventName} must cancel and fence the deferred wake`);
    handlers.session_shutdown[0]();
  }
});

test("a real prompt preflight wins the race against a stranded-steer wake", async () => {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const sent: any[] = [];
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  const ctx = { isIdle: () => true, hasPendingMessages: () => true };
  installFollowUpPriority(pi as any);

  handlers.input[0]({ source: "rpc", streamingBehavior: "steer", text: "queued before prompt" });
  handlers.agent_settled[0]({}, ctx);
  handlers.input[0]({ source: "rpc", streamingBehavior: undefined, text: "new prompt" });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(sent, []);
  handlers.session_shutdown[0]();
});

test("a queue cleared before the deferred wake also clears stale steer correlation", async () => {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const sent: any[] = [];
  let hasPendingMessages = true;
  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    sendMessage(message: any) {
      sent.push(message);
    },
  };
  installFollowUpPriority(pi as any);

  handlers.input[0]({ source: "rpc", streamingBehavior: "steer", text: "cleared steer" });
  handlers.agent_settled[0]({}, { isIdle: () => true, hasPendingMessages: () => hasPendingMessages });
  hasPendingMessages = false;
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(sent, []);
  assert.equal(
    handlers.message_end[0]({
      message: { role: "user", content: [{ type: "text", text: "cleared steer" }], timestamp: 1 },
    }),
    undefined,
  );
  handlers.session_shutdown[0]();
});

test("provider projection wraps only the active steer and preserves images", () => {
  const image = { type: "image", data: "image-data", mimeType: "image/png" };
  const messages = [
    {
      role: "user",
      content: "old addendum",
      timestamp: 1,
      steering: true,
      followUpPriorityKind: "steer",
      followUpPriorityId: "old-id",
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "handled" }],
      stopReason: "stop",
      timestamp: 2,
      followUpPriorityAcknowledged: ["old-id"],
    },
    {
      role: "user",
      content: [{ type: "text", text: "current addendum" }, image],
      timestamp: 3,
      steering: true,
      followUpPriorityKind: "steer",
      followUpPriorityId: "current-id",
    },
  ];

  const projected = projectFollowUpPriorityContext(messages);
  const old = projected[0] as any;
  const current = projected[2] as any;
  const currentText = current.content[0].text as string;

  assert.equal(old.content, "old addendum");
  assert.equal(Object.hasOwn(old, "steering"), false);
  assert.equal(Object.hasOwn(current, "steering"), false, "private metadata is removed before provider conversion");
  assert.match(currentText, /pending-user-follow-up/);
  assert.match(currentText, /User follow-up priority is dynamic/);
  assert.match(currentText, /Todo tool \(todowrite or equivalent\)/);
  assert.match(currentText, /do not infer that another follow-up explains its text or attachment/i);
  assert.match(currentText, /pi-follow-up-done:FOLLOW_UP_ID/);
  assert.equal(currentText.split("current addendum").length - 1, 1, "the user's text appears exactly once");
  assert.deepEqual(current.content[1], image);
  assert.equal((messages[2] as any).steering, true, "provider projection does not mutate session history");
  assert.equal((messages[2] as any).content[0].text, "current addendum");

  const laterProjection = projectFollowUpPriorityContext([
    ...messages,
    {
      role: "assistant",
      content: [{ type: "text", text: "Answered." }],
      stopReason: "stop",
      timestamp: 4,
      followUpPriorityAcknowledged: ["current-id"],
    },
  ]);
  assert.equal((laterProjection[0] as any).content, "old addendum");
  assert.deepEqual((laterProjection[2] as any).content, [{ type: "text", text: "current addendum" }, image]);
  assert.equal(Object.hasOwn(laterProjection[2] as any, "steering"), false);
});

test("priority projection dynamically ranks steers newest-first and follow-ups FIFO", () => {
  const messages = [
    {
      role: "user",
      content: "queued follow-up",
      followUpPriorityKind: "followUp",
      followUpPriorityId: "follow-up-1",
    },
    { role: "user", content: "older steer", followUpPriorityKind: "steer", followUpPriorityId: "steer-1" },
    { role: "user", content: "newer steer", followUpPriorityKind: "steer", followUpPriorityId: "steer-2" },
  ];

  const projected = projectFollowUpPriorityContext(messages) as any[];
  assert.match(projected[2].content, /priority="P1\/3"/);
  assert.match(projected[2].content, /P1:steer-2:steer > P2:steer-1:steer > P3:follow-up-1:followUp/);
  assert.match(projected[2].content, /Todo tool \(todowrite or equivalent\)/);
  assert.match(projected[1].content, /priority="P2\/3"/);
  assert.doesNotMatch(projected[1].content, /Todo tool/);
  assert.match(projected[0].content, /priority="P3\/3"/);
});

test("legacy workflow steering receipts remain readable after extraction", () => {
  const legacy = {
    role: "user",
    content: "legacy question",
    steering: true,
    workflowSteeringId: "legacy-id",
  };
  const reply = {
    role: "assistant",
    content: [{ type: "text", text: "already answered" }],
    stopReason: "stop",
    workflowSteeringAcknowledged: ["legacy-id"],
  };

  const projected = projectFollowUpPriorityContext([legacy, reply]) as any[];
  assert.equal(projected[0].content, "legacy question");
  assert.equal(projected[0].workflowSteeringId, undefined);
  assert.equal(projected[1].workflowSteeringAcknowledged, undefined);
});

test("provider projection is a no-op when the context has no steer marker", () => {
  const messages = [
    { role: "user", content: "ordinary prompt", timestamp: 1 },
    { role: "assistant", content: [], stopReason: "stop", timestamp: 2 },
  ];
  assert.equal(projectFollowUpPriorityContext(messages), messages);
});

test("provider projection always removes the hidden wake control marker", () => {
  const ordinary = { role: "user", content: "real prompt", timestamp: 1 };
  const wake = {
    role: "custom",
    customType: "follow-up-priority-wake",
    content: [],
    display: false,
    timestamp: 2,
  };

  assert.deepEqual(projectFollowUpPriorityContext([wake, ordinary]), [ordinary]);
});

function steeringHarness(branch: any[] = []) {
  const handlers: Record<string, Array<(...args: any[]) => any>> = {};
  const statuses: Array<string | undefined> = [];
  const ctx = {
    sessionManager: { getBranch: () => branch },
    ui: { setStatus: (_key: string, text?: string) => statuses.push(text) },
  };
  installFollowUpPriority({
    on(event: string, handler: (...args: any[]) => any) {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
  } as any);
  const emit = (event: string, input: any = {}) => handlers[event]?.[0]?.(input, ctx);
  return {
    emit,
    statuses,
    queue(text = "new question") {
      emit("input", { source: "interactive", streamingBehavior: "steer", text });
      const message = emit("message_end", { message: { role: "user", content: text, timestamp: 1 } }).message;
      branch.push({ type: "message", message });
      return message;
    },
    project(messages: any[]) {
      return emit("context", { messages }).messages;
    },
    reply(text = "Answer", stopReason = "stop", completedIds: string[] = []) {
      const receipts = completedIds.map((id) => `<!-- pi-follow-up-done:${id} -->`).join("\n");
      const message = {
        role: "assistant",
        content: [{ type: "text", text: [text, receipts].filter(Boolean).join("\n") }],
        timestamp: 2,
        stopReason,
      };
      const replacement = emit("message_end", { message });
      branch.push({ type: "message", message: replacement?.message ?? message });
      return replacement?.message ?? message;
    },
  };
}

function priorityCount(messages: any[]): number {
  return JSON.stringify(messages).split("<pending-user-follow-up").length - 1;
}

test("synthetic notifications and tool-only replies preserve pending interjection priority", () => {
  const harness = steeringHarness();
  const question = harness.queue();
  const synthetic = {
    role: "assistant",
    stopReason: "toolUse",
    timestamp: 2,
    content: [{ type: "toolCall", id: "notification", name: "workflow_notification", arguments: {} }],
  };
  const output = {
    role: "toolResult",
    toolCallId: "notification",
    content: [{ type: "text", text: "background result" }],
  };
  assert.equal(priorityCount(harness.project([question, synthetic, output])), 1);
  harness.emit("before_provider_request");
  harness.emit("message_end", { message: synthetic });
  assert.equal(priorityCount(harness.project([question, synthetic, output])), 1);
});

test("a successful visible reply retires priority even when later context omits that reply", () => {
  const branch: any[] = [];
  const harness = steeringHarness(branch);
  const question = harness.queue();
  assert.equal(priorityCount(harness.project([question])), 1);
  harness.emit("before_provider_request");
  const reply = harness.reply("Answer", "stop", [question.followUpPriorityId]);
  assert.deepEqual(reply.followUpPriorityAcknowledged, [question.followUpPriorityId]);
  assert.doesNotMatch(JSON.stringify(reply.content), /pi-follow-up-done/);
  assert.equal(harness.statuses.at(-1), undefined, "reply clears the transient status");
  assert.equal(priorityCount(harness.project([question])), 0);
  const fresh = steeringHarness(branch);
  assert.equal(priorityCount(fresh.project([question])), 0, "reload recovers receipt outside the compacted context");
  const projected = fresh.project([question, reply]);
  assert.equal(projected[0].followUpPriorityId, undefined);
  assert.equal(projected[1].followUpPriorityAcknowledged, undefined);
  assert.equal(question.content, "new question", "raw user content stays unchanged");
});

test("provider errors, aborts, truncated replies, tool-use progress and thinking-only messages do not acknowledge input", () => {
  for (const reason of ["error", "aborted", "length", "pending"]) {
    const harness = steeringHarness();
    const question = harness.queue();
    harness.project([question]);
    harness.emit("before_provider_request");
    const failed = harness.reply("partial text", reason, [question.followUpPriorityId]);
    assert.equal(failed.followUpPriorityAcknowledged, undefined);
    if (reason !== "pending") assert.equal(harness.statuses.at(-1), "1 user follow-up pending");
    assert.equal(priorityCount(harness.project([question, failed])), 1);
  }
  const harness = steeringHarness();
  const question = harness.queue();
  harness.project([question]);
  harness.emit("before_provider_request");
  const thinking = { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "reasoning" }] };
  assert.equal(harness.emit("message_end", { message: thinking }), undefined);
  assert.equal(priorityCount(harness.project([question, thinking])), 1);

  const toolHarness = steeringHarness();
  const toolQuestion = toolHarness.queue();
  toolHarness.project([toolQuestion]);
  toolHarness.emit("before_provider_request");
  const progress = toolHarness.reply("Starting now", "toolUse", [toolQuestion.followUpPriorityId]);
  assert.equal(progress.followUpPriorityAcknowledged, undefined);
  assert.equal(priorityCount(toolHarness.project([toolQuestion, progress])), 1);
});

test("custom providers acknowledge from assistant stream start without a payload hook", () => {
  const harness = steeringHarness();
  const question = harness.queue();
  harness.project([question]);
  harness.emit("message_start", { message: { role: "assistant", content: [] } });
  const reply = harness.reply("Answer", "stop", [question.followUpPriorityId]);
  assert.deepEqual(reply.followUpPriorityAcknowledged, [question.followUpPriorityId]);
  assert.equal(priorityCount(harness.project([question])), 0);
});

test("context inspection alone cannot acknowledge an interjection", () => {
  const harness = steeringHarness();
  const question = harness.queue();
  harness.project([question]);
  const unrelated = harness.reply("unassociated answer");
  assert.equal(unrelated.followUpPriorityAcknowledged, undefined);
  assert.equal(priorityCount(harness.project([question, unrelated])), 1);
});

test("a request acknowledges its own inputs only and a repeated user message gets a new identity", () => {
  const harness = steeringHarness();
  const first = harness.queue("same question");
  harness.project([first]);
  harness.emit("before_provider_request");
  const second = harness.queue("same question");
  const reply = harness.reply("First answered", "stop", [first.followUpPriorityId]);
  assert.notEqual(first.followUpPriorityId, second.followUpPriorityId);
  assert.deepEqual(reply.followUpPriorityAcknowledged, [first.followUpPriorityId]);
  const projected = harness.project([first, reply, second]);
  assert.equal(priorityCount(projected), 1);
  assert.equal(projected[0].content, "same question");
  assert.match(projected[2].content, /pending-user-follow-up/);
});

test("one reply acknowledges only explicitly completed follow-ups", () => {
  const harness = steeringHarness();
  const first = harness.queue("question one");
  const second = harness.queue("question two");
  assert.equal(priorityCount(harness.project([first, second])), 2);
  harness.emit("before_provider_request");
  const reply = harness.reply("Only the newest item is complete", "stop", [second.followUpPriorityId]);
  assert.deepEqual(reply.followUpPriorityAcknowledged, [second.followUpPriorityId]);
  const projected = harness.project([first, second, reply]);
  assert.equal(priorityCount(projected), 1);
  assert.match(projected[0].content, /priority="P1\/1"/);
  assert.equal(projected[1].content, "question two");
});

test("switching to a branch before the reply restores that branch's unanswered interjection", () => {
  const branch: any[] = [];
  const harness = steeringHarness(branch);
  const question = harness.queue();
  harness.project([question]);
  harness.emit("before_provider_request");
  harness.reply("Answer", "stop", [question.followUpPriorityId]);
  assert.equal(priorityCount(harness.project([question])), 0);
  harness.emit("session_before_tree");
  branch.splice(1);
  assert.equal(priorityCount(harness.project([question])), 1);
});
