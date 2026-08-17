import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discardWorkflowRuntime, handoffWorkflowRuntime, takeWorkflowRuntime } from "../src/extension-reload.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type Handler = (...args: any[]) => any;

function makePi(
  handlers: Record<string, Handler[]>,
  sent: Array<{ message: any; options: any }>,
  send?: (message: any, options: any) => void | Promise<void>,
): ExtensionAPI {
  const activeTools = ["bash", "read"];
  return {
    registerTool: () => {},
    registerCommand: () => {},
    getCommands: () => [],
    on: (event: string, handler: Handler) => {
      handlers[event] ??= [];
      handlers[event].push(handler);
    },
    once: (event: string, handler: Handler) => {
      handlers[event] ??= [];
      const wrapped: Handler = (...args: any[]) => {
        const list = handlers[event];
        if (list) {
          const index = list.indexOf(wrapped);
          if (index >= 0) list.splice(index, 1);
        }
        return handler(...args);
      };
      handlers[event].push(wrapped);
    },
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools.splice(0, activeTools.length, ...tools);
    },
    sendMessage: (message: any, options: any) => {
      if (send) return send(message, options);
      sent.push({ message, options });
      return Promise.resolve();
    },
  } as unknown as ExtensionAPI;
}

function startSession(handlers: Record<string, Handler[]>): void {
  for (const handler of handlers.session_start ?? []) {
    handler(
      {},
      {
        cwd: process.cwd(),
        model: undefined,
        modelRegistry: {},
        sessionManager: { getSessionId: () => "compaction-test" },
        ui: { setWidget: () => {}, notify: () => {} },
      },
    );
  }
}

function beforeCompactEvent(signal: AbortSignal): any {
  return {
    type: "session_before_compact",
    reason: "threshold",
    willRetry: false,
    signal,
    preparation: { messagesToSummarize: [], turnPrefixMessages: [] },
  };
}

function projectSentDelivery(
  handlers: Record<string, Handler[]>,
  sent: { message: any; options: any },
  timestamp: number,
): void {
  let messages: any[] = [{ role: "custom", ...sent.message, timestamp }];
  for (const handler of handlers.context ?? []) {
    const result = handler({ messages });
    if (Array.isArray(result?.messages)) messages = result.messages;
  }
  assert.ok(
    messages.some((message) => message?.role === "toolResult"),
    "delivery must enter provider context",
  );
  for (const handler of handlers.before_provider_request ?? []) handler({});
}

test("workflow deliveries wait behind compaction and re-enter through steer", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-compaction-delivery-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged, "reload must expose the live manager for the next extension generation");
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      staged.manager.onAgentMessage?.({
        runId: "routine-agent-run",
        id: "routine-agent-run:0",
        label: "routine report",
        result: "ordinary completion",
      });
      assert.equal(
        sent.length,
        0,
        "routine subagent completions must stay in durable/UI state instead of steering the parent",
      );

      const contextEvent = {
        messages: [
          { role: "user", content: [{ type: "text", text: "new user task" }], timestamp: 1 },
          {
            role: "custom",
            customType: "workflow-agent",
            content: "routine completion",
            details: { runId: "routine-agent-run", agentId: "routine-agent-run:0" },
            timestamp: 2,
          },
        ],
      };
      let providerMessages: any[] = contextEvent.messages;
      for (const handler of handlers.context ?? []) {
        const result = handler({ messages: providerMessages });
        if (Array.isArray(result?.messages)) providerMessages = result.messages;
      }
      assert.equal(
        providerMessages.some?.((message: any) => message?.customType === "workflow-agent"),
        false,
        "routine workflow-agent entries must be absent from provider context",
      );

      const threshold = new AbortController();
      for (const handler of handlers.session_before_compact ?? []) {
        handler(beforeCompactEvent(threshold.signal));
      }
      staged.manager.onDeliver?.("threshold completion");
      assert.equal(sent.length, 0, "a completion must not start a provider turn during threshold compaction");

      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      assert.equal(sent.length, 1, "the queued completion must flush at the settled safe point");
      assert.equal(sent[0]?.message.customType, "workflow-deliver");
      assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });

      const manual = new AbortController();
      for (const handler of handlers.session_before_compact ?? []) {
        handler({ ...beforeCompactEvent(manual.signal), reason: "manual" });
      }
      staged.manager.onDeliver?.("manual completion");
      for (const handler of handlers.session_compact ?? []) {
        handler({ type: "session_compact", reason: "manual" });
      }
      assert.equal(sent.length, 1, "manual compaction must keep the fence until the host stack unwinds");

      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sent.length, 2, "manual compaction must flush its queued completion after unwind");
      assert.deepEqual(sent[1]?.options, { triggerTurn: true, deliverAs: "steer" });

      const failed = new AbortController();
      for (const handler of handlers.session_before_compact ?? []) {
        handler({ ...beforeCompactEvent(failed.signal), reason: "manual" });
      }
      staged.manager.onDeliver?.("failed compaction completion");
      assert.equal(sent.length, 2, "a provider-side compaction failure must remain fenced while unwinding");
      failed.abort();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sent.length, 3, "the host abort signal must release deliveries after a compaction failure");
      assert.deepEqual(sent[2]?.options, { triggerTurn: true, deliverAs: "steer" });

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("workflow delivery retries once after Pi rejects an abort-window send", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-abort-backpressure-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      let attempts = 0;
      installExtension(
        makePi(handlers, sent, (message, options) => {
          attempts++;
          if (attempts === 1) return Promise.reject(new Error("Agent abort is in progress"));
          sent.push({ message, options });
          return Promise.resolve();
        }),
      );
      startSession(handlers);

      staged.manager.onDeliver?.("critical retry", {
        runId: "abort-window-run",
        workflowName: "abort window",
        alertKind: "critical_finding",
      });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(attempts, 2, "abort backpressure gets one safe-point retry");
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.message.content, "critical retry");
      assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an aborted agent does not auto-drain the dismissed delivery after settle", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-abort-fence-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      staged.manager.onDeliver?.("must wait after abort", {
        runId: "abort-fence-run",
        workflowName: "abort fence",
        alertKind: "critical_finding",
      });
      assert.equal(sent.length, 1);
      const stableId = sent[0]?.message.details.deliveryId;

      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
        });
      }
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The delivery woke a turn the user aborted: it was SEEN and dismissed.
      // The settled boundary must stay silent — no auto-drain, no new wake.
      assert.equal(sent.length, 1, "settled recovery must not re-wake a turn the user aborted");

      // A real user keystroke releases the fence; the held-back delivery rides
      // the user's own turn (single pending record → no batch wrapper).
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "continue please", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "the next real user input flushes the held-back delivery");
      assert.equal(sent[1]?.message.customType, "workflow-deliver", "the flush keeps the customType (not user)");
      assert.equal(sent[1]?.message.details.deliveryId, stableId, "the flush keeps the stable delivery ID");
      assert.deepEqual(sent[1]?.options, { triggerTurn: true, deliverAs: "steer" });

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("provider retries acknowledge one delivery without creating a duplicate wake", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-provider-status-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);
      staged.manager.onDeliver?.("retry on 500");
      assert.equal(sent.length, 1);

      projectSentDelivery(handlers, sent[0], 1);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 500, headers: {} });
      assert.equal(sent.length, 1, "a failed provider response must not immediately create a new turn");
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sent.length, 1, "a provider retry must keep the original request association");

      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sent.length, 1, "a later 2xx acknowledges the original delivery without replaying it");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("a timed-out delivery can be acknowledged when its persisted message re-enters context", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-uncertain-reobserved-"));
  const previousTimeout = process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS;
  process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS = "10";
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const firstGeneration: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, firstGeneration));
      startSession(handlers);
      staged.manager.onDeliver?.("re-observed delivery");
      assert.equal(firstGeneration.length, 1);
      await new Promise((resolve) => setTimeout(resolve, 30));

      projectSentDelivery(handlers, firstGeneration[0], 1);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(firstGeneration.length, 1, "re-observation must not call sendMessage again");

      handlers.session_shutdown?.[0]?.({ reason: "reload" });
      const nextRuntime = takeWorkflowRuntime();
      assert.ok(nextRuntime);
      handoffWorkflowRuntime(nextRuntime);
      const nextHandlers: Record<string, Handler[]> = {};
      const nextGeneration: Array<{ message: any; options: any }> = [];
      installExtension(makePi(nextHandlers, nextGeneration));
      startSession(nextHandlers);
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(nextGeneration.length, 0, "an acknowledged message must not replay after reload");

      nextHandlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    if (previousTimeout === undefined) delete process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS;
    else process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS = previousTimeout;
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("compaction pauses ack deadlines instead of making an entry permanently uncertain", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-compaction-watchdog-"));
  const previousTimeout = process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS;
  process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS = "40";
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(
        makePi(handlers, sent, (message, options) => {
          sent.push({ message, options });
          return new Promise<void>(() => {});
        }),
      );
      startSession(handlers);
      staged.manager.onDeliver?.("wait through compaction");
      assert.equal(sent.length, 1);

      const compact = new AbortController();
      for (const handler of handlers.session_before_compact ?? []) handler(beforeCompactEvent(compact.signal));
      await new Promise((resolve) => setTimeout(resolve, 70));
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      // The watchdog had 40ms before compaction, but compaction lasted 70ms;
      // preserving the remaining duration means it is still pending now.
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(sent.length, 1, "compaction time must not consume the ack deadline");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    if (previousTimeout === undefined) delete process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS;
    else process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS = previousTimeout;
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an uncertain delivery waits for the next session generation instead of resending", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-uncertain-delivery-"));
  const previousTimeout = process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS;
  process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS = "10";
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const firstGeneration: Array<{ message: any; options: any }> = [];
      installExtension(
        makePi(handlers, firstGeneration, (message, options) => {
          firstGeneration.push({ message, options });
          return new Promise<void>(() => {});
        }),
      );
      startSession(handlers);
      staged.manager.onDeliver?.("uncertain delivery");
      await new Promise((resolve) => setTimeout(resolve, 30));

      assert.equal(firstGeneration.length, 1, "timeout must not resend in the same generation");
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(firstGeneration.length, 1, "later safe points must preserve the same-generation fence");
      const stableId = firstGeneration[0]?.message.details.deliveryId;

      handlers.session_shutdown?.[0]?.({ reason: "reload" });
      const nextRuntime = takeWorkflowRuntime();
      assert.ok(nextRuntime);
      handoffWorkflowRuntime(nextRuntime);
      const nextHandlers: Record<string, Handler[]> = {};
      const nextGeneration: Array<{ message: any; options: any }> = [];
      installExtension(makePi(nextHandlers, nextGeneration));
      startSession(nextHandlers);
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.equal(nextGeneration.length, 1, "the next generation replays the uncertain delivery once");
      assert.equal(nextGeneration[0]?.message.details.deliveryId, stableId, "replay keeps the stable delivery ID");
      nextHandlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    if (previousTimeout === undefined) delete process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS;
    else process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS = previousTimeout;
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("durable delivery phase failures release in-memory fences and retry at a safe point", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-delivery-phase-retry-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      let submittedAttempts = 0;
      let projectedAttempts = 0;
      let acknowledgedAttempts = 0;
      staged.manager.acknowledgeDelivery = (_runId, _deliveryId, _generation, phase) => {
        if (phase === "submitted") return ++submittedAttempts > 1;
        if (phase === "projected") return ++projectedAttempts > 1;
        return ++acknowledgedAttempts > 1;
      };

      staged.manager.onDeliver?.("durable retry", {
        runId: "durable-phase-retry",
        workflowName: "durable phase retry",
        alertKind: "critical_finding",
        deliveryId: "durable-phase-retry:1",
        sequence: 1,
      });
      assert.equal(sent.length, 0, "a failed submitted transition must not send an untracked message");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "a transient submitted failure gets one bounded safe-point retry");

      projectSentDelivery(handlers, sent[0], 1);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "a failed projected transition must release awaitingAck and resubmit");

      projectSentDelivery(handlers, sent[1], 2);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 3, "a failed acknowledged transition must release awaitingAck and resubmit");

      projectSentDelivery(handlers, sent[2], 3);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(submittedAttempts, 4);
      assert.equal(projectedAttempts, 3);
      assert.equal(acknowledgedAttempts, 2);
      assert.equal(sent.length, 3, "successful acknowledgement must clear the retry fence without another send");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an abort during tool execution fences the delivery without an ack-timeout resend", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-tool-abort-fence-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      staged.manager.onDeliver?.("dropped by tool abort", {
        runId: "tool-abort-run",
        workflowName: "tool abort",
        alertKind: "critical_finding",
      });
      assert.equal(sent.length, 1);
      const stableId = sent[0]?.message.details.deliveryId;

      // Esc during a tool call: agent_end's last assistant stopReason is "toolUse",
      // not "aborted", so the primary abort fence misses it. The settled fence must
      // recover the host-dropped delivery instead of letting the ack watchdog resend.
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [
            { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "get_workflow_output" }], stopReason: "toolUse" },
            { role: "toolResult", toolCallId: "t1", content: [] },
          ],
        });
      }
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The settled fence recovers the host-dropped delivery but does NOT
      // re-wake the host: the user just pressed Esc. No ack-timeout warn, no
      // auto-drain, no user-role merge — it waits for real input.
      assert.equal(sent.length, 1, "settled recovery must not re-wake a turn the user aborted");

      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "go on", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "the next real user input flushes the recovered delivery");
      assert.equal(sent[1]?.message.customType, "workflow-deliver", "the flush keeps the customType (not user)");
      assert.equal(sent[1]?.message.details.deliveryId, stableId, "the flush keeps the stable delivery ID");
      assert.deepEqual(sent[1]?.options, { triggerTurn: true, deliverAs: "steer" });

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an Esc-restored steering message is intercepted and re-sent with its custom metadata", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-esc-recovery-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      const deliveryText = "subagent finished its review";
      staged.manager.onDeliver?.(deliveryText, {
        runId: "esc-recovery-run",
        workflowName: "esc recovery",
        alertKind: "critical_finding",
      });
      assert.equal(sent.length, 1);
      const stableId = sent[0]?.message.details.deliveryId;

      // Esc aborts the run (stream abort: primary fence registers the fingerprint).
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
        });
      }

      // The host flattens the dropped message to plain editor text; the user hits
      // Enter. The input event must intercept that exact text and re-send the
      // original custom message instead of letting it become role:"user". The
      // real host short-circuits on the first "handled" result, so mirror that.
      let inputResult: any;
      for (const handler of handlers.input ?? []) {
        const result = handler({ type: "input", text: deliveryText, source: "interactive" });
        if (result?.action === "handled") {
          inputResult = result;
          break;
        }
        inputResult = result;
      }
      assert.equal(inputResult?.action, "handled", "the re-submitted delivery text must be intercepted");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "the intercepted input re-queues but defers the flush until the turn settles");

      // The re-submitted text starts the user's own turn; when it settles, the
      // deferred flush re-sends the original custom message (metadata intact).
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "the deferred flush re-sends the delivery after the user's turn settles");
      assert.equal(sent[1]?.message.customType, "workflow-deliver", "recovery preserves the customType");
      assert.equal(sent[1]?.message.details.deliveryId, stableId, "recovery preserves the stable delivery ID");
      assert.deepEqual(sent[1]?.options, { triggerTurn: true, deliverAs: "steer" });

      // A later unrelated user input must pass through untouched (no false positive).
      // No handler may short-circuit it with "handled"; a "continue" from the
      // keyword-arming handler is a pass-through, not an interception.
      let passthrough: any;
      for (const handler of handlers.input ?? []) {
        const result = handler({ type: "input", text: "an unrelated question", source: "interactive" });
        if (result?.action === "handled") {
          passthrough = result;
          break;
        }
      }
      assert.equal(passthrough?.action, undefined, "non-matching input must not be intercepted");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("multiple Esc-dropped deliveries wait for input, then flush as ONE merged custom batch", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-multi-esc-drain-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      // Three deliveries arrive while a turn is streaming (each enters awaitingAck).
      staged.manager.onDeliver?.("check-1 finding", { runId: "multi-run", workflowName: "multi", alertKind: "critical_finding", sequence: 1 });
      staged.manager.onDeliver?.("check-2 finding", { runId: "multi-run", workflowName: "multi", alertKind: "critical_finding", sequence: 2 });
      staged.manager.onDeliver?.("check-3 decision", { runId: "multi-run", workflowName: "multi", alertKind: "decision", sequence: 3 });
      assert.equal(sent.length, 3);

      // Esc aborts the streaming run: the host drops all three from the steering queue.
      for (const handler of handlers.agent_end ?? []) {
        handler({ type: "agent_end", messages: [{ role: "assistant", content: [], stopReason: "aborted" }] });
      }
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // Settled must stay silent: the user just pressed Esc, so no auto-drain.
      assert.equal(sent.length, 3, "settled recovery must not re-wake a turn the user aborted");

      // A real user keystroke releases the fence and flushes everything the
      // bridge held back as ONE merged custom message — never N wake turns,
      // never a user-role blob.
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "ok continue", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 4, "the three held-back deliveries flush as one merged batch on user input");
      const batch = sent[3];
      assert.equal(batch?.message.customType, "workflow-deliver", "the batch stays a custom message");
      assert.equal(batch?.message.role, undefined, "no user-role downgrade on the batch");
      assert.deepEqual(batch?.options, { triggerTurn: true, deliverAs: "steer" });
      const batchText: string = batch?.message.content ?? "";
      for (const needle of ["check-1 finding", "check-2 finding", "check-3 decision"]) {
        assert.ok(batchText.includes(needle), `merged batch must contain section: ${needle}`);
      }
      assert.ok(batchText.includes("multi-run / critical_finding / seq 1"), "each section keeps its run/kind/seq label");
      assert.ok(
        batchText.indexOf("check-1 finding") < batchText.indexOf("check-2 finding") &&
          batchText.indexOf("check-2 finding") < batchText.indexOf("check-3 decision"),
        "sections preserve the original arrival order",
      );

      // Acknowledging the batch retires every member: nothing may replay.
      projectSentDelivery(handlers, batch, 7);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 4, "an acknowledged batch must never resend its members");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("repeated Esc presses never create a resend storm (regression: 13-abort incident)", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-esc-storm-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      // Incident replay: a background workflow delivery arrives mid-turn, the
      // turn aborts (provider error + user Esc), and the user keeps pressing
      // Esc on every auto-woken turn. Session log 2026-08-17T17-46-52 showed
      // 13 aborted turns each followed by an identical re-delivery.
      staged.manager.onDeliver?.("critical finding the user keeps dismissing", {
        runId: "storm-run",
        workflowName: "storm",
        alertKind: "critical_finding",
      });
      assert.equal(sent.length, 1);
      const stableId = sent[0]?.message.details.deliveryId;

      for (let round = 0; round < 13; round++) {
        for (const handler of handlers.agent_end ?? []) {
          handler({
            type: "agent_end",
            messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
          });
        }
        for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(sent.length, 1, `abort round ${round + 1} must not resend the dismissed delivery`);
      }

      // The message is settled, not lost: the next genuine user input flushes
      // it exactly once, with its stable ID and custom role intact.
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "what was that finding?", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "one real user input flushes the held-back delivery exactly once");
      assert.equal(sent[1]?.message.details.deliveryId, stableId);
      assert.equal(sent[1]?.message.customType, "workflow-deliver");

      // And after acknowledgement, nothing can bring it back.
      projectSentDelivery(handlers, sent[1], 9);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "thanks", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "an acknowledged delivery never replays");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an aborted merged batch restores its members and re-merges on the next user input", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-batch-abort-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged);
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);

      // Fence the bridge first (as a prior abort would), then queue two
      // deliveries behind it — the pending backlog the batch path merges.
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
        });
      }
      staged.manager.onDeliver?.("first held finding", {
        runId: "batch-run",
        workflowName: "batch",
        alertKind: "blocker",
        sequence: 1,
      });
      staged.manager.onDeliver?.("second held finding", {
        runId: "batch-run",
        workflowName: "batch",
        alertKind: "critical_finding",
        sequence: 2,
      });
      assert.equal(sent.length, 0, "fenced deliveries queue instead of waking the host");

      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "resume", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "the held backlog flushes as one merged batch");
      const firstBatchText: string = sent[0]?.message.content ?? "";
      assert.ok(firstBatchText.includes("2 queued deliveries"));
      assert.ok((sent[0]?.message.details?.deliveryId ?? "").startsWith("wf_batch_"));

      // The batch's own turn gets aborted before any provider request.
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
        });
      }
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "an aborted batch must not auto-resend after settle");

      // Next real input: the members are restored and re-merged, still one
      // message, still carrying both findings in order.
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "again", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "the next user input re-sends the restored members as one batch");
      const secondText: string = sent[1]?.message.content ?? "";
      assert.ok(secondText.includes("first held finding") && secondText.includes("second held finding"));
      assert.ok(secondText.indexOf("first held finding") < secondText.indexOf("second held finding"));

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
