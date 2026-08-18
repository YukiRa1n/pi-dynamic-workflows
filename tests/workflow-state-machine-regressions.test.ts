import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discardWorkflowRuntime, handoffWorkflowRuntime, takeWorkflowRuntime } from "../src/extension-reload.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

type Handler = (...args: any[]) => any;
type SentMessage = { message: any; options: any };

function makePi(handlers: Record<string, Handler[]>, sent: SentMessage[]): ExtensionAPI {
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
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
}

function startSession(handlers: Record<string, Handler[]>, isIdle: () => boolean, branchEntries: any[] = []): void {
  for (const handler of handlers.session_start ?? []) {
    handler(
      {},
      {
        cwd: process.cwd(),
        model: undefined,
        modelRegistry: {},
        sessionManager: {
          getSessionId: () => "workflow-state-machine-regression",
          getBranch: () => branchEntries,
        },
        ui: { setWidget: () => {}, notify: () => {} },
        isIdle,
      },
    );
  }
}

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

function emit(handlers: Record<string, Handler[]>, event: string, value: any, ctx?: any): void {
  for (const handler of handlers[event] ?? []) handler(value, ctx);
}

async function withHarness<T>(
  testName: string,
  callback: (harness: {
    handlers: Record<string, Handler[]>;
    sent: SentMessage[];
    staged: any;
    setHostIdle: (value: boolean) => void;
  }) => Promise<T> | T,
): Promise<T> {
  const fakeHome = mkdtempSync(join(tmpdir(), `pi-dw-${testName}-`));
  try {
    return await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers, () => false);
      emit(seedHandlers, "session_shutdown", { reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged, "the seed extension must hand off its runtime");
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: SentMessage[] = [];
      let hostIdle = false;
      installExtension(makePi(handlers, sent));
      startSession(handlers, () => hostIdle);
      try {
        return await callback({
          handlers,
          sent,
          staged,
          setHostIdle: (value) => {
            hostIdle = value;
          },
        });
      } finally {
        emit(handlers, "session_shutdown", { reason: "quit" });
        discardWorkflowRuntime();
      }
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function notificationResults(messages: any[]): any[] {
  return messages.filter(
    (message) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
  );
}

test("streaming assistant context ends with notification toolResult without user downgrade", async () => {
  await withHarness("streaming-shape", ({ handlers, sent, staged }) => {
    staged.manager.onDeliver?.("arrived while assistant was streaming", {
      runId: "streaming-shape-run",
      workflowName: "streaming shape",
      alertKind: "critical_finding",
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]?.options, { triggerTurn: false });

    const projected = projectMessages(handlers, [
      { role: "user", content: [{ type: "text", text: "continue" }], timestamp: 1 },
      { role: "custom", ...sent[0]?.message, timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "text", text: "partial assistant output" }],
        stopReason: "stop",
        timestamp: 3,
      },
    ]);

    const notifications = notificationResults(projected);
    assert.equal(notifications.length, 1);
    assert.equal(projected.at(-1)?.role, "toolResult");
    assert.equal(
      projected.some((message) => message?.role === "user" && /arrived while assistant/.test(JSON.stringify(message))),
      false,
      "workflow content must not be converted to role=user",
    );
    assert.equal(
      projected.some((message) => message?.role === "custom"),
      false,
    );
  });
});

test("no-Esc cadence allows one autonomous hidden wake and does not chain Working turns", async () => {
  await withHarness("no-esc-cadence", async ({ handlers, sent, staged, setHostIdle }) => {
    const runId = "no-esc-cadence-run";
    staged.manager.onDeliver?.("first notification", {
      runId,
      workflowName: "no Esc cadence",
      alertKind: "critical_finding",
      sequence: 1,
    });
    const first = { role: "custom", ...sent[0]?.message, timestamp: 1 };
    const firstRequest = projectProviderRequest(handlers, [
      { role: "user", content: [{ type: "text", text: "start" }], timestamp: 0 },
      first,
    ]);
    assert.equal(notificationResults(firstRequest).length, 1);
    emit(handlers, "after_provider_response", { status: 200, headers: {} });

    staged.manager.onDeliver?.("second notification after context", {
      runId,
      workflowName: "no Esc cadence",
      alertKind: "decision",
      sequence: 2,
    });
    assert.equal(sent.length, 2);

    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent.length, 3);
    assert.equal(sent[2]?.message?.customType, "workflows");
    assert.deepEqual(sent[2]?.options, { triggerTurn: true, deliverAs: "steer" });

    // The hidden wake is now the active run. Its context consumes the second
    // notification; no further hidden wake is allowed in this autonomous run.
    setHostIdle(false);
    emit(handlers, "before_agent_start", { prompt: "" });
    const hiddenRequest = projectProviderRequest(handlers, [
      { role: "custom", ...sent[1]?.message, timestamp: 2 },
      { role: "custom", ...sent[2]?.message, timestamp: 3 },
    ]);
    assert.equal(notificationResults(hiddenRequest).length, 1);
    emit(handlers, "after_provider_response", { status: 200, headers: {} });
    emit(handlers, "agent_settled", { type: "agent_settled" });

    // A third arrival after that context is admitted passively. Even when the
    // host is idle and settled again, autonomousWakeSpent prevents N Working.
    staged.manager.onDeliver?.("third notification after hidden context", {
      runId,
      workflowName: "no Esc cadence",
      alertKind: "blocker",
      sequence: 3,
    });
    assert.equal(sent.length, 4);
    assert.equal(sent[3]?.message?.customType, "workflow-deliver");
    assert.equal(sent[3]?.options?.triggerTurn, false);
    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      sent.filter(({ message }) => message?.customType === "workflows").length,
      1,
      "one real prompt cadence cannot create a chain of autonomous hidden wakes",
    );
  });
});

test("Esc recovery scope excludes post-Esc IDs through a second hidden-run provider request", async () => {
  await withHarness("esc-scope-second-request", async ({ handlers, sent, staged, setHostIdle }) => {
    const runId = "esc-scope-second-request-run";
    const toolCallId = "wait-esc-scope-second-request";
    emit(handlers, "tool_execution_start", {
      type: "tool_execution_start",
      toolCallId,
      toolName: "get_workflow_output",
      args: { runId, block: true },
    });
    const parentRun = new AbortController();
    emit(handlers, "agent_start", { type: "agent_start" }, { signal: parentRun.signal });
    staged.manager.onDeliver?.("already visible at Esc", {
      runId,
      workflowName: "Esc scope",
      alertKind: "critical_finding",
      sequence: 1,
    });
    assert.equal(sent.length, 1);
    parentRun.abort();

    // This arrival is after the abort boundary and must not be admitted to the
    // one hidden recovery run, even though it shares the same workflow run ID.
    staged.manager.onDeliver?.("arrived after Esc", {
      runId,
      workflowName: "Esc scope",
      alertKind: "decision",
      sequence: 2,
    });
    assert.equal(sent.length, 2);
    emit(handlers, "tool_execution_end", {
      type: "tool_execution_end",
      toolCallId,
      toolName: "get_workflow_output",
      result: { details: { runId, blocked: true, completed: false, interrupted: true } },
      isError: false,
    });
    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sent[2]?.message?.customType, "workflows");

    setHostIdle(false);
    emit(handlers, "before_agent_start", { prompt: "" });
    const firstHiddenRequest = projectProviderRequest(handlers, [
      { role: "custom", ...sent[0]?.message, timestamp: 1 },
      { role: "custom", ...sent[1]?.message, timestamp: 2 },
      { role: "custom", ...sent[2]?.message, timestamp: 3 },
    ]);
    assert.equal(notificationResults(firstHiddenRequest).length, 1);
    assert.doesNotMatch(JSON.stringify(firstHiddenRequest), /arrived after Esc/);
    emit(handlers, "after_provider_response", { status: 200, headers: {} });
    // Transport ack alone does not consume; only a final stop+text turn does.
    emit(handlers, "turn_end", {
      type: "turn_end",
      turnIndex: 0,
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "already visible at Esc acknowledged" }],
      },
      toolResults: [],
    });

    // Keep the same hidden agent run alive for another provider request. The
    // recovery scope must still exclude the post-Esc entry at this boundary.
    const secondHiddenRequest = projectProviderRequest(handlers, [
      { role: "custom", ...sent[0]?.message, timestamp: 4 },
      { role: "custom", ...sent[1]?.message, timestamp: 5 },
      { role: "custom", ...sent[2]?.message, timestamp: 6 },
    ]);
    assert.equal(notificationResults(secondHiddenRequest).length, 0);
    assert.doesNotMatch(JSON.stringify(secondHiddenRequest), /arrived after Esc/);
    assert.equal(
      secondHiddenRequest.some(
        (message) => message?.role === "user" && /arrived after Esc/.test(JSON.stringify(message)),
      ),
      false,
    );
  });
});

test("aborted context signals never establish projected or included workflow associations", async () => {
  await withHarness("aborted-context-association", ({ handlers, sent, staged }) => {
    staged.manager.onDeliver?.("must remain recoverable", {
      runId: "aborted-context-run",
      workflowName: "aborted context",
      alertKind: "critical_finding",
    });
    assert.equal(sent.length, 1);
    const aborted = new AbortController();
    aborted.abort();
    const projected = projectProviderRequest(
      handlers,
      [{ role: "custom", ...sent[0]?.message, timestamp: 1 }],
      aborted.signal,
    );
    assert.equal(notificationResults(projected).length, 1, "context shape remains valid for an aborted old loop");

    const bridge = (staged.manager as any).__workflowBridge;
    assert.deepEqual(bridge?.projectedForNextRequest, []);
    assert.deepEqual(bridge?.includedInProviderRequest, []);
    assert.equal(bridge?.awaitingAck?.has(sent[0]?.message?.details?.deliveryId), true);
  });
});
