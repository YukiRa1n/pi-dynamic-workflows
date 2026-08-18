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
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools.splice(0, activeTools.length, ...tools);
    },
    sendMessage: (message: any, options: any) => {
      if (send) return send(message, options);
      sent.push({ message, options });
      // Match stock Pi's fire-and-forget ExtensionAPI contract. Individual
      // compatibility tests inject an explicit Promise-returning sender.
      return undefined;
    },
  } as unknown as ExtensionAPI;
}

function startSession(
  handlers: Record<string, Handler[]>,
  isIdle: () => boolean = () => true,
  branchEntries: any[] = [],
): void {
  for (const handler of handlers.session_start ?? []) {
    handler(
      {},
      {
        cwd: process.cwd(),
        model: undefined,
        modelRegistry: {},
        sessionManager: { getSessionId: () => "compaction-test", getBranch: () => branchEntries },
        ui: { setWidget: () => {}, notify: () => {} },
        isIdle,
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

/** Run an arbitrary message list through the context projection only (no
 * before_provider_request), returning the provider-bound copy. */
function projectMessages(handlers: Record<string, Handler[]>, messages: any[], signal?: AbortSignal): any[] {
  let projected = messages;
  for (const handler of handlers.context ?? []) {
    const result = handler({ messages: projected }, { signal });
    if (Array.isArray(result?.messages)) projected = result.messages;
  }
  return projected;
}

function projectProviderRequest(handlers: Record<string, Handler[]>, messages: any[], signal?: AbortSignal): any[] {
  const projected = projectMessages(handlers, messages, signal);
  for (const handler of handlers.before_provider_request ?? []) handler({}, { signal });
  return projected;
}

function beginRealPrompt(handlers: Record<string, Handler[]>, prompt = "continue"): void {
  for (const handler of handlers.input ?? []) {
    handler({ text: prompt, source: "interactive" });
  }
  for (const handler of handlers.before_agent_start ?? []) {
    handler({ prompt });
  }
}

function startAgent(handlers: Record<string, Handler[]>, signal: AbortSignal): void {
  for (const handler of handlers.agent_start ?? []) {
    handler({ type: "agent_start" }, { signal });
  }
}

test("workflow deliveries stay out of Steering across compaction boundaries", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "the queued completion must flush at the settled safe point");
      assert.equal(sent[0]?.message.customType, "workflow-deliver");
      assert.deepEqual(sent[0]?.options, { triggerTurn: true, deliverAs: "steer" });
      for (const handler of handlers.before_agent_start ?? []) handler({ prompt: "threshold completion" });
      startAgent(handlers, new AbortController().signal);
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });

      const manual = new AbortController();
      for (const handler of handlers.session_before_compact ?? []) {
        handler({ ...beforeCompactEvent(manual.signal), reason: "manual" });
      }
      staged.manager.onDeliver?.("manual completion");
      for (const handler of handlers.session_compact ?? []) {
        handler({ type: "session_compact", reason: "manual" });
      }
      assert.equal(sent.length, 2, "the compacted branch may receive passive history immediately");
      assert.deepEqual(sent[1]?.options, { triggerTurn: false });

      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(sent.length, 2, "manual compaction must not guess at a timer-based autonomous safe point");

      const failed = new AbortController();
      for (const handler of handlers.session_before_compact ?? []) {
        handler({ ...beforeCompactEvent(failed.signal), reason: "manual" });
      }
      staged.manager.onDeliver?.("failed compaction completion");
      assert.equal(sent.length, 2, "a provider-side compaction failure must remain fenced while unwinding");
      failed.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(sent.length, 2, "an abort signal is not proof that the host controller has unwound");

      beginRealPrompt(handlers);
      const recovered = projectProviderRequest(handlers, [
        { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 3 },
      ]);
      assert.ok(
        recovered.some(
          (message: any) =>
            message?.role === "toolResult" &&
            message.content?.some?.(
              (part: any) => part?.type === "text" && part.text.includes("failed compaction completion"),
            ),
        ),
        "the next genuine prompt consumes the fail-closed backlog without a separate wake",
      );
      assert.equal(sent.length, 2, "compaction recovery never enters the host Steering queue");

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

test("an aborted delivery stays in custom history without an automatic resend", async () => {
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

      const run = new AbortController();
      startAgent(handlers, run.signal);
      run.abort();

      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
        });
      }
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The delivery woke a turn the user aborted. It is already structured
      // custom history; settled must not resend it or start another Working run.
      assert.equal(sent.length, 1, "settled recovery must not re-wake a turn the user aborted");

      // A real user keystroke releases the fence but never flushes: the bridge
      // cannot start its own turn off user input (that is what broke Esc).
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "continue please", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "user input releases the fence without a bridge-initiated wake");

      const probe = projectProviderRequest(handlers, [
        { role: "custom", ...sent[0]?.message, timestamp: 4 },
        { role: "user", content: [{ type: "text", text: "continue please" }], timestamp: 5 },
      ]);
      const workflowResults = probe.filter(
        (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
      );
      assert.equal(workflowResults.length, 1, "the next genuine prompt observes the original custom entry once");
      assert.equal(
        probe.some(
          (message: any) =>
            message?.role === "user" && JSON.stringify(message.content).includes("must wait after abort"),
        ),
        false,
        "workflow content must never be downgraded to user input",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      assert.equal(sent.length, 1, "acknowledgement must not create a second send");

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

test("reload reuses a canonical custom-history delivery instead of sending a duplicate", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-history-reload-"));
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

      let records: any[] = [];
      staged.manager.listPendingDeliveries = () => records as any;
      staged.manager.acknowledgeDelivery = (runId, deliveryId, generation, phase) => {
        const record = records.find((candidate) => candidate.runId === runId && candidate.deliveryId === deliveryId);
        if (!record) return false;
        if (phase === "acknowledged") records = records.filter((candidate) => candidate !== record);
        else {
          record.status = phase;
          record.generation = generation;
        }
        return true;
      };

      const firstHandlers: Record<string, Handler[]> = {};
      const firstSent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(firstHandlers, firstSent));
      startSession(firstHandlers);
      records.push({
        deliveryId: "wf_history_1",
        sequence: 1,
        kind: "explicit",
        status: "pending",
        content: "persisted once",
        alertKind: "critical_finding",
        createdAt: new Date().toISOString(),
        runId: "history-run",
        workflowName: "history",
        runStatus: "running",
      });
      staged.manager.onDeliver?.("persisted once", {
        runId: "history-run",
        workflowName: "history",
        alertKind: "critical_finding",
        deliveryId: "wf_history_1",
        sequence: 1,
      });
      assert.equal(firstSent.length, 1);

      const historyEntry = {
        type: "custom_message",
        customType: firstSent[0]?.message.customType,
        content: firstSent[0]?.message.content,
        details: firstSent[0]?.message.details,
        display: true,
      };
      firstHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const nextRuntime = takeWorkflowRuntime();
      assert.ok(nextRuntime);
      handoffWorkflowRuntime(nextRuntime);

      const nextHandlers: Record<string, Handler[]> = {};
      const nextSent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(nextHandlers, nextSent));
      startSession(nextHandlers, () => true, [historyEntry]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(nextSent.length, 0, "session_start must not resend an ID already present on the active branch");

      const projected = projectProviderRequest(nextHandlers, [
        { role: "custom", ...firstSent[0]?.message, timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 2 },
      ]);
      assert.equal(
        projected.filter((message: any) => message?.role === "toolResult" && message?.toolCallId === "wf_history_1")
          .length,
        1,
        "the existing history entry is re-admitted in the new generation",
      );
      for (const handler of nextHandlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 0, "successful projection retires the original durable record");
      assert.equal(nextSent.length, 0, "history acknowledgement never requires a duplicate send");

      nextHandlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an abort invalidates the old provider acknowledgement before a late 2xx", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-late-abort-ack-"));
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

      let records: any[] = [];
      staged.manager.listPendingDeliveries = () => records as any;
      staged.manager.acknowledgeDelivery = (runId, deliveryId, generation, phase) => {
        const record = records.find((candidate) => candidate.runId === runId && candidate.deliveryId === deliveryId);
        if (!record) return false;
        if (phase === "acknowledged") records = records.filter((candidate) => candidate !== record);
        else {
          record.status = phase;
          record.generation = generation;
        }
        return true;
      };

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers);
      records.push({
        deliveryId: "wf_abort_ack_1",
        sequence: 1,
        kind: "explicit",
        status: "pending",
        content: "must survive late response",
        alertKind: "critical_finding",
        createdAt: new Date().toISOString(),
        runId: "abort-ack-run",
        workflowName: "abort ack",
        runStatus: "running",
      });
      staged.manager.onDeliver?.("must survive late response", {
        runId: "abort-ack-run",
        workflowName: "abort ack",
        alertKind: "critical_finding",
        deliveryId: "wf_abort_ack_1",
        sequence: 1,
      });
      assert.equal(sent.length, 1);

      const run = new AbortController();
      startAgent(handlers, run.signal);
      projectSentDelivery(handlers, sent[0], 1);
      run.abort();
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 1, "a late response from the aborted request must not acknowledge delivery");
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 1, "a duplicate old response must not clear its own abort fence");
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "retry normally", source: "interactive" });
      }
      const projected = projectProviderRequest(handlers, [
        { role: "custom", ...sent[0]?.message, timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "retry normally" }], timestamp: 2 },
      ]);
      assert.equal(
        projected.filter((message: any) => message?.role === "toolResult" && message?.toolCallId === "wf_abort_ack_1")
          .length,
        1,
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 0, "the next non-aborted request may acknowledge the same stable ID");
      assert.equal(sent.length, 1, "retry uses canonical history and never sends a duplicate");

      records.push({
        deliveryId: "wf_abort_ack_overlap",
        sequence: 2,
        kind: "explicit",
        status: "pending",
        content: "must survive an overlapping late response",
        alertKind: "critical_finding",
        createdAt: new Date().toISOString(),
        runId: "abort-ack-run",
        workflowName: "abort ack",
        runStatus: "running",
      });
      staged.manager.onDeliver?.("must survive an overlapping late response", {
        runId: "abort-ack-run",
        workflowName: "abort ack",
        alertKind: "critical_finding",
        deliveryId: "wf_abort_ack_overlap",
        sequence: 2,
      });
      assert.equal(sent.length, 2);

      const overlappingRun = new AbortController();
      startAgent(handlers, overlappingRun.signal);
      projectSentDelivery(handlers, sent[1], 3);
      overlappingRun.abort();
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "start the replacement request", source: "interactive" });
      }
      const replacement = projectProviderRequest(handlers, [
        { role: "custom", ...sent[1]?.message, timestamp: 3 },
        { role: "user", content: [{ type: "text", text: "start the replacement request" }], timestamp: 4 },
      ]);
      assert.equal(
        replacement.filter(
          (message: any) => message?.role === "toolResult" && message?.toolCallId === "wf_abort_ack_overlap",
        ).length,
        1,
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(
        records.length,
        1,
        "an old 2xx arriving after the replacement request starts must not acknowledge the replacement",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(
        records.length,
        1,
        "without request identities, the overlapped generation fails closed until the agent settles",
      );

      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "retry after settled boundary", source: "interactive" });
      }
      const settledRetry = projectProviderRequest(handlers, [
        { role: "custom", ...sent[1]?.message, timestamp: 5 },
        { role: "user", content: [{ type: "text", text: "retry after settled boundary" }], timestamp: 6 },
      ]);
      assert.equal(
        settledRetry.filter(
          (message: any) => message?.role === "toolResult" && message?.toolCallId === "wf_abort_ack_overlap",
        ).length,
        1,
        "agent_settled releases the ambiguous response fence for the next real request",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 0, "the settled retry acknowledges without requiring a session reload");
      assert.equal(sent.length, 2, "recovery reuses canonical history instead of sending a duplicate");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("durable phase failures retry canonical history without duplicate sends", async () => {
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
      let recordPresent = true;
      const durableRecord = {
        deliveryId: "durable-phase-retry:1",
        sequence: 1,
        kind: "explicit" as const,
        status: "pending" as const,
        content: "durable retry",
        alertKind: "critical_finding" as const,
        createdAt: new Date().toISOString(),
        runId: "durable-phase-retry",
        workflowName: "durable phase retry",
        runStatus: "running" as const,
      };
      staged.manager.listPendingDeliveries = () => (recordPresent ? [durableRecord] : []) as any;
      staged.manager.acknowledgeDelivery = (_runId, _deliveryId, _generation, phase) => {
        if (phase === "submitted") return ++submittedAttempts > 1;
        if (phase === "projected") return ++projectedAttempts > 1;
        const acknowledged = ++acknowledgedAttempts > 1;
        if (acknowledged) recordPresent = false;
        return acknowledged;
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
      assert.equal(sent.length, 1, "phase failures must not append duplicate custom history");

      projectSentDelivery(handlers, sent[0], 2);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(submittedAttempts, 3);
      assert.equal(projectedAttempts, 2);
      assert.equal(acknowledgedAttempts, 2);
      assert.equal(sent.length, 1, "successful acknowledgement leaves exactly one canonical custom entry");

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

      // Esc during a tool call: agent_end's last assistant stopReason is
      // "toolUse", not "aborted". The live run signal is the authoritative
      // abort boundary and must fence any later safe-point wake.
      const run = new AbortController();
      startAgent(handlers, run.signal);
      run.abort();
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: "t1", name: "get_workflow_output" }],
              stopReason: "toolUse",
            },
            { role: "toolResult", toolCallId: "t1", content: [] },
          ],
        });
      }
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      // No ack-timeout resend, auto-drain, or user-role merge follows Esc.
      assert.equal(sent.length, 1, "settled recovery must not re-wake a turn the user aborted");

      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "go on", source: "interactive" });
      }
      const projected = projectProviderRequest(handlers, [
        { role: "custom", ...sent[0]?.message, timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "t1", name: "get_workflow_output" }],
          stopReason: "toolUse",
        },
        { role: "toolResult", toolCallId: "t1", toolName: "get_workflow_output", content: [] },
        { role: "user", content: [{ type: "text", text: "go on" }], timestamp: 2 },
      ]);
      assert.equal(
        projected.filter(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
        ).length,
        1,
        "the original custom delivery re-enters the next provider request once",
      );
      assert.ok(
        projected.some(
          (message: any) =>
            message?.role === "toolResult" &&
            message?.toolCallId === stableId &&
            message?.toolName === "workflow_message_notification",
        ),
        "the projected delivery keeps its stable provider-safe ID",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(sent.length, 1, "the next real input consumes history without a bridge-initiated send");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("Esc on a blocking workflow output consumes accumulated custom history exactly once", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-output-esc-consume-"));
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
      let hostIdle = false;
      installExtension(makePi(handlers, sent));
      startSession(handlers, () => hostIdle);

      const runId = "output-esc-run";
      const toolCallId = "wait-output-esc";
      for (const handler of handlers.tool_execution_start ?? []) {
        handler({
          type: "tool_execution_start",
          toolCallId,
          toolName: "get_workflow_output",
          args: { runId, block: true, timeoutMs: 600_000 },
        });
      }
      const run = new AbortController();
      startAgent(handlers, run.signal);
      staged.manager.onDeliver?.("first finding already shown", {
        runId,
        workflowName: "output Esc",
        alertKind: "critical_finding",
      });
      staged.manager.onDeliver?.("second finding already shown", {
        runId,
        workflowName: "output Esc",
        alertKind: "decision",
      });
      assert.equal(sent.length, 2);
      assert.ok(sent.every(({ options }) => options?.triggerTurn === false && options?.deliverAs === undefined));

      run.abort();
      for (const handler of handlers.tool_execution_end ?? []) {
        handler({
          type: "tool_execution_end",
          toolCallId,
          toolName: "get_workflow_output",
          result: { details: { runId, blocked: true, completed: false, interrupted: true } },
          isError: false,
        });
      }
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              content: [{ type: "toolCall", id: toolCallId, name: "get_workflow_output" }],
              stopReason: "toolUse",
            },
            {
              role: "toolResult",
              toolCallId,
              toolName: "get_workflow_output",
              content: [],
              details: { runId, blocked: true, completed: false, interrupted: true },
            },
          ],
        });
      }

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 3, "settled opens exactly one hidden consumption turn");
      assert.equal(sent[2]?.message.customType, "workflows");
      assert.equal(sent[2]?.message.display, false);
      assert.equal(sent[2]?.message.content, "");
      assert.deepEqual(sent[2]?.options, { triggerTurn: true, deliverAs: "steer" });
      assert.equal(
        sent.filter(({ message }) => /finding already shown/.test(String(message.content))).length,
        2,
        "the wake never resends either large canonical payload",
      );

      const continuation = new AbortController();
      startAgent(handlers, continuation.signal);
      const projected = projectProviderRequest(handlers, [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name: "get_workflow_output" }],
          stopReason: "toolUse",
          timestamp: 1,
        },
        { role: "custom", ...sent[0]?.message, timestamp: 2 },
        { role: "custom", ...sent[1]?.message, timestamp: 3 },
        {
          role: "toolResult",
          toolCallId,
          toolName: "get_workflow_output",
          content: [],
          details: { runId, blocked: true, completed: false, interrupted: true },
          timestamp: 4,
        },
        { role: "custom", ...sent[2]?.message, timestamp: 5 },
      ]);
      const workflowResults = projected.filter(
        (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
      );
      assert.equal(workflowResults.length, 2);
      const sourceToolResultIndex = projected.findIndex(
        (message: any) => message?.role === "toolResult" && message?.toolCallId === toolCallId,
      );
      const notificationAssistantIndexes = projected
        .map((message: any, index: number) => ({ message, index }))
        .filter(
          ({ message }) =>
            message?.role === "assistant" &&
            message?.content?.some?.((part: any) => part?.name === "workflow_message_notification"),
        );
      assert.equal(notificationAssistantIndexes.length, 1, "the accumulated notifications share one assistant batch");
      const notificationAssistantIndex = notificationAssistantIndexes[0]?.index;
      assert.ok(
        sourceToolResultIndex >= 0 &&
          typeof notificationAssistantIndex === "number" &&
          sourceToolResultIndex < notificationAssistantIndex,
        "the interrupted source tool result is paired before a notification assistant starts",
      );
      assert.equal(
        projected.slice(0, sourceToolResultIndex).filter((message: any) => message?.role === "assistant").length,
        1,
        "no notification assistant appears while get_workflow_output is unresolved",
      );
      assert.equal(
        projected.some((message: any) => message?.customType === "workflows"),
        false,
        "the control wake is absent from provider context",
      );
      assert.equal(
        projected.some(
          (message: any) =>
            message?.role === "user" && /finding already shown/.test(JSON.stringify(message.content ?? "")),
        ),
        false,
        "workflow text never crosses the provider boundary as user input",
      );

      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      // Transport ack alone does not remove the payload; only a final
      // stop+text turn (no further tool calls) marks the delivery consumed.
      for (const handler of handlers.turn_end ?? []) {
        handler({
          type: "turn_end",
          turnIndex: 0,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "finding acknowledged" }],
          },
          toolResults: [],
        });
      }
      const replayed = projectMessages(handlers, [
        { role: "custom", ...sent[0]?.message, timestamp: 6 },
        { role: "custom", ...sent[1]?.message, timestamp: 7 },
        { role: "custom", ...sent[2]?.message, timestamp: 8 },
      ]);
      assert.equal(
        replayed.some((message: any) => message?.toolName === "workflow_message_notification"),
        false,
        "acknowledged custom history remains visible in UI but leaves future provider context",
      );
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 3, "acknowledgement and repeated settled events cannot re-wake");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("a delivered output followed by Esc before provider continuation still consumes once", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-output-yield-esc-race-"));
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
      let hostIdle = false;
      installExtension(makePi(handlers, sent));
      startSession(handlers, () => hostIdle);

      const runId = "output-yield-esc-race";
      const toolCallId = "wait-output-yield-esc";
      for (const handler of handlers.tool_execution_start ?? []) {
        handler({
          type: "tool_execution_start",
          toolCallId,
          toolName: "get_workflow_output",
          args: { runId, block: true, timeoutMs: 600_000 },
        });
      }
      const run = new AbortController();
      startAgent(handlers, run.signal);
      staged.manager.onDeliver?.("delivery won immediately before Esc", {
        runId,
        workflowName: "yield Esc race",
        alertKind: "critical_finding",
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.options?.triggerTurn, false);

      for (const handler of handlers.tool_execution_end ?? []) {
        handler({
          type: "tool_execution_end",
          toolCallId,
          toolName: "get_workflow_output",
          result: { details: { runId, blocked: true, completed: false, delivered: true } },
          isError: false,
        });
      }
      run.abort();
      staged.manager.onDeliver?.("arrived after Esc but before settled", {
        runId,
        workflowName: "yield Esc race",
        alertKind: "decision",
      });
      assert.equal(sent.length, 2);
      assert.equal(sent[1]?.options?.triggerTurn, false);
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "toolUse" }],
        });
      }

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 3, "the delivery/tool-end/Esc race starts one hidden recovery turn");
      assert.equal(sent[2]?.message.customType, "workflows");
      assert.deepEqual(sent[2]?.options, { triggerTurn: true, deliverAs: "steer" });

      hostIdle = false;
      const continuation = new AbortController();
      startAgent(handlers, continuation.signal);
      const projected = projectProviderRequest(handlers, [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name: "get_workflow_output" }],
          stopReason: "toolUse",
          timestamp: 1,
        },
        { role: "custom", ...sent[0]?.message, timestamp: 2 },
        { role: "custom", ...sent[1]?.message, timestamp: 3 },
        {
          role: "toolResult",
          toolCallId,
          toolName: "get_workflow_output",
          content: [],
          details: { runId, blocked: true, completed: false, delivered: true },
          timestamp: 4,
        },
        { role: "custom", ...sent[2]?.message, timestamp: 5 },
      ]);
      assert.equal(
        projected.filter(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
        ).length,
        1,
      );
      assert.doesNotMatch(
        JSON.stringify(projected),
        /arrived after Esc but before settled/,
        "the recovery request is frozen to IDs that already existed at Esc",
      );
      assert.equal(
        projected.some((message: any) => message?.role === "user"),
        false,
      );

      staged.manager.onDeliver?.("arrived during the recovery provider turn", {
        runId,
        workflowName: "yield Esc race",
        alertKind: "decision",
      });
      assert.equal(sent.length, 4);
      assert.equal(sent[3]?.options?.triggerTurn, false, "later output remains passive behind the Esc fence");
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 4, "recovery never chains another autonomous Working turn");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("Esc before any workflow output keeps later completion behind the ordinary abort fence", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-empty-output-esc-fence-"));
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
      let hostIdle = false;
      installExtension(makePi(handlers, sent));
      startSession(handlers, () => hostIdle);

      const runId = "empty-output-esc";
      const toolCallId = "wait-empty-output-esc";
      for (const handler of handlers.tool_execution_start ?? []) {
        handler({
          type: "tool_execution_start",
          toolCallId,
          toolName: "get_workflow_output",
          args: { runId, block: true },
        });
      }
      const run = new AbortController();
      startAgent(handlers, run.signal);
      run.abort();
      staged.manager.onDeliver?.("completion raced after Esc but before tool end", {
        runId,
        workflowName: "empty output Esc",
        alertKind: "critical_finding",
      });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.options?.triggerTurn, false, "post-Esc output is frozen outside special recovery");
      for (const handler of handlers.tool_execution_end ?? []) {
        handler({
          type: "tool_execution_end",
          toolCallId,
          toolName: "get_workflow_output",
          result: { details: { runId, blocked: true, completed: false, interrupted: true } },
          isError: false,
        });
      }

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "tool end cannot retroactively arm output that arrived after Esc");

      staged.manager.onDeliver?.("completion arrived after the user stopped waiting", {
        runId,
        workflowName: "empty output Esc",
        alertKind: "critical_finding",
      });
      assert.equal(sent.length, 2);
      assert.equal(sent[1]?.options?.triggerTurn, false, "later output must not reopen the dismissed turn");
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "the stale interrupted-wait latch cannot create a hidden wake later");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("special Esc recovery reserves context for its run behind an older oversized backlog", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-output-esc-priority-page-"));
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
      let hostIdle = false;
      installExtension(makePi(handlers, sent));
      startSession(handlers, () => hostIdle);

      const oldCount = 40;
      for (let index = 0; index < oldCount; index++) {
        staged.manager.onDeliver?.(`old backlog ${index} ${"x".repeat(30_000)}`, {
          runId: "older-backlog-run",
          workflowName: "older backlog",
          alertKind: "critical_finding",
        });
      }
      const oldHistory = sent.map(({ message }, index) => ({ role: "custom", ...message, timestamp: index + 1 }));
      const overflowProbe = projectMessages(handlers, oldHistory);
      assert.ok(
        overflowProbe.filter((message: any) => message?.toolName === "workflow_message_notification").length < oldCount,
        "the older page must actually exceed the provider byte budget",
      );

      const runId = "priority-output-esc-run";
      const toolCallId = "wait-priority-output-esc";
      for (const handler of handlers.tool_execution_start ?? []) {
        handler({
          type: "tool_execution_start",
          toolCallId,
          toolName: "get_workflow_output",
          args: { runId, block: true },
        });
      }
      const run = new AbortController();
      startAgent(handlers, run.signal);
      staged.manager.onDeliver?.("priority finding must survive old backlog", {
        runId,
        workflowName: "priority output Esc",
        alertKind: "critical_finding",
      });
      const priorityIndex = sent.length - 1;
      run.abort();
      for (const handler of handlers.tool_execution_end ?? []) {
        handler({
          type: "tool_execution_end",
          toolCallId,
          toolName: "get_workflow_output",
          result: { details: { runId, blocked: true, completed: false, interrupted: true } },
          isError: false,
        });
      }

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const wakeIndex = sent.length - 1;
      assert.equal(
        sent[wakeIndex]?.message.customType,
        "workflows",
        "armed recovery bypasses ordinary backlog deferral",
      );

      hostIdle = false;
      const projected = projectProviderRequest(handlers, [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: toolCallId, name: "get_workflow_output" }],
          stopReason: "toolUse",
          timestamp: 20,
        },
        ...oldHistory,
        { role: "custom", ...sent[priorityIndex]?.message, timestamp: 21 },
        {
          role: "toolResult",
          toolCallId,
          toolName: "get_workflow_output",
          content: [],
          details: { runId, blocked: true, completed: false, interrupted: true },
          timestamp: 22,
        },
        { role: "custom", ...sent[wakeIndex]?.message, timestamp: 23 },
      ]);
      const workflowResults = projected.filter(
        (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
      );
      assert.ok(
        workflowResults.some((message: any) =>
          JSON.stringify(message.content).includes("priority finding must survive old backlog"),
        ),
        "the matching run gets a reserved slot in the special recovery request",
      );
      assert.ok(workflowResults.length < oldCount + 1, "the page remains bounded while prioritizing the matching run");
      assert.equal(
        projected.some((message: any) => message?.role === "user"),
        false,
      );

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("busy workflow history that misses the current request gets one idle continuation without Esc", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-late-history-wake-"));
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
      let hostIdle = false;
      installExtension(makePi(handlers, sent));
      startSession(handlers, () => hostIdle);

      staged.manager.onDeliver?.("late finding one", {
        runId: "late-history-run",
        workflowName: "late history",
        alertKind: "critical_finding",
      });
      staged.manager.onDeliver?.("late finding two", {
        runId: "late-history-run",
        workflowName: "late history",
        alertKind: "decision",
      });
      assert.equal(sent.length, 2);
      assert.ok(sent.every(({ options }) => options?.triggerTurn === false));

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 3);
      assert.equal(sent[2]?.message.customType, "workflows");
      assert.equal(sent[2]?.message.display, false);

      const continuation = new AbortController();
      startAgent(handlers, continuation.signal);
      const projected = projectProviderRequest(handlers, [
        { role: "custom", ...sent[0]?.message, timestamp: 1 },
        { role: "custom", ...sent[1]?.message, timestamp: 2 },
        { role: "custom", ...sent[2]?.message, timestamp: 3 },
      ]);
      assert.equal(
        projected.filter(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
        ).length,
        2,
      );
      assert.equal(
        projected.some((message: any) => message?.role === "user"),
        false,
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 3, "the coalesced idle continuation is one-shot");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("a large passive workflow burst is byte-paged and never replayed after acknowledgement", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-byte-paged-history-"));
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
      let hostIdle = false;
      installExtension(makePi(handlers, sent));
      startSession(handlers, () => hostIdle);

      const total = 40;
      for (let index = 0; index < total; index++) {
        staged.manager.onDeliver?.(`large-${index}-${"x".repeat(31_000)}`, {
          runId: "byte-paged-run",
          workflowName: "byte paged",
          alertKind: "critical_finding",
        });
      }
      assert.equal(sent.length, total);
      assert.ok(sent.every(({ options }) => options?.triggerTurn === false));
      const history = sent.map(({ message }, index) => ({ role: "custom", ...message, timestamp: index + 1 }));

      const firstPage = projectProviderRequest(handlers, history);
      const firstResults = firstPage.filter(
        (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
      );
      assert.ok(
        firstResults.length > 0 && firstResults.length < total,
        `the first request respects the aggregate byte cap (projected ${firstResults.length})`,
      );
      const firstIds = new Set(firstResults.map((message: any) => message.toolCallId));
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      // Transport ack only: the page stays eligible until a final text turn.
      for (const handler of handlers.turn_end ?? []) {
        handler({
          type: "turn_end",
          turnIndex: 0,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "first page consumed" }],
          },
          toolResults: [],
        });
      }

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, total, "overflow does not chain autonomous Working turns");

      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "continue the remaining workflow page", source: "interactive" });
      }
      const secondPage = projectProviderRequest(handlers, [
        ...history,
        {
          role: "user",
          content: [{ type: "text", text: "continue the remaining workflow page" }],
          timestamp: 20,
        },
      ]);
      const secondResults = secondPage.filter(
        (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
      );
      const secondIds = new Set(secondResults.map((message: any) => message.toolCallId));
      assert.equal(firstIds.size + secondIds.size, total);
      assert.ok(
        [...firstIds].every((id) => !secondIds.has(id)),
        "the second page contains no acknowledged replay",
      );
      assert.equal(
        secondPage.filter((message: any) => message?.role === "user").length,
        1,
        "only the real prompt crosses as user role",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.turn_end ?? []) {
        handler({
          type: "turn_end",
          turnIndex: 1,
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "second page consumed" }],
          },
          toolResults: [],
        });
      }
      const exhausted = projectMessages(handlers, history);
      assert.equal(
        exhausted.some((message: any) => message?.toolName === "workflow_message_notification"),
        false,
        "both acknowledged pages are absent from later provider requests",
      );

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("Esc does not register current-generation workflow text as editor input", async () => {
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

      const run = new AbortController();
      startAgent(handlers, run.signal);
      run.abort();
      for (const handler of handlers.agent_end ?? []) {
        handler({
          type: "agent_end",
          messages: [{ role: "assistant", content: [], stopReason: "aborted" }],
        });
      }

      // Current-generation workflow messages were started only from an idle
      // session and never occupied Pi's busy steering queue. Even if the user
      // independently types identical text, the extension must not swallow or
      // rewrite it as an Esc-recovery false positive.
      let inputResult: any;
      for (const handler of handlers.input ?? []) {
        const result = handler({ type: "input", text: deliveryText, source: "interactive" });
        if (result?.action === "handled") {
          inputResult = result;
          break;
        }
        inputResult = result;
      }
      assert.equal(inputResult?.action, undefined, "ordinary user text must pass through unchanged");
      await new Promise((resolve) => setTimeout(resolve, 20));
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "Esc and matching user text must not create a duplicate send");

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

test("a blocking get_workflow_output absorbs an accumulated burst without steering or extra Working turns", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-blocked-output-burst-"));
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

      const runId = "blocked-output-run";
      let records: any[] = [
        {
          deliveryId: "wf_blocked_1",
          sequence: 1,
          kind: "explicit",
          status: "pending",
          content: "check-1 finding",
          alertKind: "critical_finding",
          createdAt: new Date().toISOString(),
          runId,
          workflowName: "blocked output",
          runStatus: "completed",
        },
        {
          deliveryId: "wf_blocked_2",
          sequence: 2,
          kind: "explicit",
          status: "pending",
          content: "check-2 finding",
          alertKind: "critical_finding",
          createdAt: new Date().toISOString(),
          runId,
          workflowName: "blocked output",
          runStatus: "completed",
        },
        {
          deliveryId: "wf_blocked_3",
          sequence: 3,
          kind: "explicit",
          status: "pending",
          content: "check-3 decision",
          alertKind: "decision",
          createdAt: new Date().toISOString(),
          runId,
          workflowName: "blocked output",
          runStatus: "completed",
        },
        {
          deliveryId: "wf_blocked_terminal",
          sequence: 4,
          kind: "terminal",
          status: "pending",
          terminal: true,
          createdAt: new Date().toISOString(),
          runId,
          workflowName: "blocked output",
          runStatus: "completed",
        },
      ];
      const phases: string[] = [];
      staged.manager.listPendingDeliveries = () => records as any;
      staged.manager.acknowledgeDelivery = (recordRunId, deliveryId, generation, phase) => {
        const record = records.find(
          (candidate) => candidate.runId === recordRunId && candidate.deliveryId === deliveryId,
        );
        if (!record) return false;
        phases.push(`${deliveryId}:${phase}`);
        if (phase === "acknowledged") records = records.filter((candidate) => candidate !== record);
        else {
          record.status = phase;
          record.generation = generation;
        }
        return true;
      };
      staged.manager.discardDelivery = (recordRunId, deliveryId) => {
        const before = records.length;
        records = records.filter((candidate) => candidate.runId !== recordRunId || candidate.deliveryId !== deliveryId);
        return records.length < before;
      };

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      let hostIdle = false;
      startSession(handlers, () => hostIdle);

      // The host is inside the sequential blocking tool. Every arrival is
      // appended as passive custom history: visible in the transcript, but no
      // host steering row and no concurrent agent run.
      staged.manager.onDeliver?.("check-1 finding", {
        runId,
        workflowName: "blocked output",
        alertKind: "critical_finding",
        deliveryId: "wf_blocked_1",
        sequence: 1,
      });
      staged.manager.onDeliver?.("check-2 finding", {
        runId,
        workflowName: "blocked output",
        alertKind: "critical_finding",
        deliveryId: "wf_blocked_2",
        sequence: 2,
      });
      staged.manager.onDeliver?.("check-3 decision", {
        runId,
        workflowName: "blocked output",
        alertKind: "decision",
        deliveryId: "wf_blocked_3",
        sequence: 3,
      });
      assert.equal(sent.length, 4, "the three findings and terminal state are visible while the tool is blocked");
      assert.ok(
        sent.every(({ options }) => options?.triggerTurn === false && options?.deliverAs === undefined),
        "busy delivery may append history but must never enter Steering or start another turn",
      );

      // The same provider request that consumes get_workflow_output receives all
      // explicit messages. Its completed tool result makes the automatic
      // terminal notification redundant, so that record is discarded.
      const projected = projectProviderRequest(handlers, [
        { role: "user", content: [{ type: "text", text: "wait for it" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "wait_1", name: "get_workflow_output" }],
          stopReason: "toolUse",
          timestamp: 2,
        },
        {
          role: "toolResult",
          toolCallId: "wait_1",
          toolName: "get_workflow_output",
          content: [{ type: "text", text: "workflow complete" }],
          details: { runId, completed: true, blocked: true },
          timestamp: 3,
        },
      ]);
      const workflowResults = projected.filter(
        (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
      );
      assert.equal(workflowResults.length, 3, "one provider request absorbs the entire explicit burst");
      assert.equal(
        projected.some(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_result_notification",
        ),
        false,
        "get_workflow_output completion suppresses the duplicate terminal notification",
      );
      const projectedText = workflowResults.map((message: any) => JSON.stringify(message.content)).join("\n");
      assert.ok(projectedText.indexOf("check-1 finding") < projectedText.indexOf("check-2 finding"));
      assert.ok(projectedText.indexOf("check-2 finding") < projectedText.indexOf("check-3 decision"));
      assert.equal(sent.length, 4, "context admission does not create another bridge message or turn");

      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 0, "terminal and explicit records are retired after one successful request");
      assert.deepEqual(phases.filter((phase) => phase.endsWith(":acknowledged")).sort(), [
        "wf_blocked_1:acknowledged",
        "wf_blocked_2:acknowledged",
        "wf_blocked_3:acknowledged",
      ]);

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 4, "settled must not restart Working after the blocking output completed");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("context overflow waits for the next real prompt instead of chaining Working turns", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-context-overflow-"));
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

      let records: any[] = Array.from({ length: 65 }, (_, index) => ({
        deliveryId: `wf_overflow_${String(index).padStart(2, "0")}`,
        sequence: index,
        kind: "explicit",
        status: "pending",
        content: `overflow finding ${index}`,
        alertKind: "critical_finding",
        createdAt: new Date().toISOString(),
        runId: "overflow-run",
        workflowName: "overflow",
        runStatus: "running",
      }));
      staged.manager.listPendingDeliveries = () => records as any;
      staged.manager.acknowledgeDelivery = (runId, deliveryId, generation, phase) => {
        const record = records.find((candidate) => candidate.runId === runId && candidate.deliveryId === deliveryId);
        if (!record) return false;
        if (phase === "acknowledged") records = records.filter((candidate) => candidate !== record);
        else {
          record.status = phase;
          record.generation = generation;
        }
        return true;
      };

      const handlers: Record<string, Handler[]> = {};
      const sent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(handlers, sent));
      let hostIdle = false;
      startSession(handlers, () => hostIdle);

      const firstPage = projectProviderRequest(handlers, [
        { role: "user", content: [{ type: "text", text: "current turn" }], timestamp: 1 },
      ]);
      assert.equal(
        firstPage.filter(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
        ).length,
        64,
        "the first provider request is capped at the in-flight limit",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 1);

      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(
        sent.every(({ options }) => options?.triggerTurn === false),
        "overflow may become visible history but must not start an autonomous continuation after settle",
      );

      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "continue with remaining notifications", source: "interactive" });
      }
      const secondPage = projectProviderRequest(handlers, [
        {
          role: "user",
          content: [{ type: "text", text: "continue with remaining notifications" }],
          timestamp: 2,
        },
      ]);
      assert.equal(
        secondPage.filter(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
        ).length,
        1,
        "the next real prompt consumes the remaining durable record",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 0);
      assert.ok(
        sent.every(({ options }) => options?.triggerTurn === false),
        "both pages use existing provider requests and never touch host queues",
      );

      records = [
        ...Array.from({ length: 64 }, (_, index) => ({
          deliveryId: `wf_reload_explicit_${String(index).padStart(2, "0")}`,
          sequence: index,
          kind: "explicit",
          status: "pending",
          content: `reload finding ${index}`,
          alertKind: "critical_finding",
          createdAt: new Date().toISOString(),
          runId: "reload-overflow-run",
          workflowName: "reload overflow",
          runStatus: "running",
        })),
        {
          deliveryId: "wf_reload_terminal",
          sequence: 64,
          kind: "terminal",
          status: "pending",
          content: "reload overflow completed",
          createdAt: new Date().toISOString(),
          runId: "reload-overflow-run",
          workflowName: "reload overflow",
          runStatus: "completed",
        },
      ];
      const terminalPage = projectProviderRequest(handlers, [
        { role: "user", content: [{ type: "text", text: "process a second burst" }], timestamp: 3 },
      ]);
      assert.equal(
        terminalPage.filter(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_result_notification",
        ).length,
        1,
        "a terminal result is never starved behind 64 explicit messages",
      );
      assert.equal(
        terminalPage.filter(
          (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
        ).length,
        63,
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      assert.equal(records.length, 1);
      assert.equal(records[0]?.deliveryId, "wf_reload_explicit_63");

      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(
        sent.every(({ options }) => options?.triggerTurn === false),
        "the old generation may append history but still must not auto-drain overflow",
      );

      handlers.session_shutdown?.[0]?.({ reason: "reload" });
      const reloadedRuntime = takeWorkflowRuntime();
      assert.ok(reloadedRuntime);
      handoffWorkflowRuntime(reloadedRuntime);
      const reloadedHandlers: Record<string, Handler[]> = {};
      const reloadedSent: Array<{ message: any; options: any }> = [];
      installExtension(makePi(reloadedHandlers, reloadedSent));
      startSession(reloadedHandlers);
      assert.equal(reloadedSent.length, 1, "session replacement releases the old generation's overflow backpressure");
      assert.match(reloadedSent[0]?.message?.content ?? "", /reload finding 63/);
      projectSentDelivery(reloadedHandlers, reloadedSent[0], 4);
      for (const handler of reloadedHandlers.after_provider_response ?? []) {
        handler({ status: 200, headers: {} });
      }
      assert.equal(records.length, 0);

      reloadedHandlers.session_shutdown?.[0]?.({ reason: "quit" });
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

      const run = new AbortController();
      startAgent(handlers, run.signal);
      run.abort();
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

      // The message is settled, not lost: the next genuine prompt observes its
      // original structured history entry without another sendMessage call.
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "what was that finding?", source: "interactive" });
      }
      const projected = projectProviderRequest(handlers, [
        { role: "custom", ...sent[0]?.message, timestamp: 1 },
        { role: "user", content: [{ type: "text", text: "what was that finding?" }], timestamp: 2 },
      ]);
      assert.ok(
        projected.some(
          (message: any) =>
            message?.role === "toolResult" &&
            message?.toolCallId === stableId &&
            message?.toolName === "workflow_message_notification",
        ),
      );
      assert.equal(sent.length, 1, "real input consumes the existing custom entry without a resend");

      // And after acknowledgement, nothing can bring it back.
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "thanks", source: "interactive" });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 1, "an acknowledged delivery never replays");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("an aborted busy backlog rides the next prompt as passive history without Steering", async () => {
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
      let hostIdle = false;
      startSession(handlers, () => hostIdle);

      // Fence the bridge first, then queue two compatibility/in-memory
      // deliveries while the host is still busy.
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
      assert.equal(sent.length, 2, "fenced deliveries are immediately visible in custom history");
      assert.ok(
        sent.every(({ options }) => options?.triggerTurn === false && options?.deliverAs === undefined),
        "fenced deliveries must not wake the host or enter Steering",
      );

      for (const handler of handlers.input ?? []) {
        handler({ type: "input", text: "resume", source: "interactive" });
      }
      const projected = projectProviderRequest(handlers, [
        { role: "custom", ...sent[0]?.message, timestamp: 1 },
        { role: "custom", ...sent[1]?.message, timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "resume" }], timestamp: 3 },
      ]);
      const workflowResults = projected.filter(
        (message: any) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
      );
      assert.equal(workflowResults.length, 2, "one provider request absorbs both pending deliveries");
      const texts = workflowResults.map((message: any) => JSON.stringify(message.content)).join("\n");
      assert.ok(texts.indexOf("first held finding") < texts.indexOf("second held finding"));
      assert.equal(sent.length, 2, "context batching never creates duplicate custom messages");

      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
      hostIdle = true;
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(sent.length, 2, "acknowledged backlog does not restart Working at settle");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("streaming steer and follow-up input do not release an Esc abort fence", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-streaming-input-fence-"));
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
      const attempts: Array<{ message: any; options: any }> = [];
      installExtension(
        makePi(handlers, [], (message, options) => {
          attempts.push({ message, options });
          if (options?.triggerTurn === false) throw new Error("simulated passive history failure");
        }),
      );
      startSession(handlers, () => true);

      const run = new AbortController();
      startAgent(handlers, run.signal);
      run.abort();
      staged.manager.onDeliver?.("held after Esc", {
        runId: "streaming-input-fence-run",
        workflowName: "streaming input fence",
        alertKind: "critical_finding",
        sequence: 1,
      });
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0]?.options?.triggerTurn, false);

      for (const handler of handlers.input ?? []) {
        handler({
          type: "input",
          text: "queued steer",
          source: "interactive",
          streamingBehavior: "steer",
        });
        handler({
          type: "input",
          text: "queued follow-up",
          source: "interactive",
          streamingBehavior: "followUp",
        });
      }
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.ok(attempts.length >= 2, "the settled flush retries the failed passive history append");
      assert.ok(
        attempts.every(({ options }) => options?.triggerTurn === false),
        "streaming input must not turn a held delivery into an autonomous wake or Steering entry",
      );

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("workflow command UI history is omitted from provider context instead of becoming user input", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-ui-context-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");
      const handlers: Record<string, Handler[]> = {};
      installExtension(makePi(handlers, []));
      startSession(handlers);

      const projected = projectMessages(handlers, [
        {
          role: "custom",
          customType: "workflows",
          content: "Workflow paused: this is transcript UI, not a user message",
          display: true,
          timestamp: 1,
        },
        { role: "user", content: [{ type: "text", text: "real prompt" }], timestamp: 2 },
      ]);

      assert.equal(projected.length, 1);
      assert.equal(projected[0]?.role, "user");
      assert.match(JSON.stringify(projected[0]?.content), /real prompt/);
      assert.doesNotMatch(JSON.stringify(projected), /Workflow paused/);

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

test("persistent host failures use one capped retry lane instead of a hot loop", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-capped-retry-"));
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
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
      let attempts = 0;
      installExtension(
        makePi(handlers, [], () => {
          attempts++;
          if (attempts === 1) throw new Error("persistent synchronous host failure");
          return Promise.reject(new Error("persistent asynchronous host failure"));
        }),
      );
      startSession(handlers, () => true);
      staged.manager.onDeliver?.("must remain pending", {
        runId: "capped-retry-run",
        workflowName: "capped retry",
        alertKind: "critical_finding",
        sequence: 1,
      });

      for (let poll = 0; poll < 75 && !warnings.some((line) => line.includes("retry budget exhausted")); poll++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.ok(
        warnings.some((line) => line.includes("retry budget exhausted")),
        "retry budget must terminate",
      );
      assert.equal(attempts, 1 + 5, "one initial admission plus the finite exponential retry budget are attempted");
      const settledAttempts = attempts;
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(attempts, settledAttempts, "no timer survives exhaustion to create an event-loop retry storm");

      handlers.session_shutdown?.[0]?.({ reason: "quit" });
      discardWorkflowRuntime();
    });
  } finally {
    console.warn = originalWarn;
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
