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
      return undefined;
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
        sessionManager: { getSessionId: () => "backlog-tree-preflight", getBranch: () => branchEntries },
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

function beginRealPrompt(handlers: Record<string, Handler[]>, prompt = "continue"): void {
  for (const handler of handlers.input ?? []) handler({ text: prompt, source: "interactive" });
  for (const handler of handlers.before_agent_start ?? []) handler({ prompt });
}

async function withHarness(
  isIdle: () => boolean,
  run: (fixture: { handlers: Record<string, Handler[]>; sent: SentMessage[]; manager: any }) => Promise<void> | void,
): Promise<void> {
  const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-backlog-tree-preflight-"));
  try {
    await withFakeHomeAsync(fakeHome, async () => {
      discardWorkflowRuntime();
      const { default: installExtension } = await import("../extensions/workflow.js");

      const seedHandlers: Record<string, Handler[]> = {};
      installExtension(makePi(seedHandlers, []));
      startSession(seedHandlers, () => true);
      seedHandlers.session_shutdown?.[0]?.({ reason: "reload" });
      const staged = takeWorkflowRuntime();
      assert.ok(staged, "the seed generation must hand off a live manager");
      handoffWorkflowRuntime(staged);

      const handlers: Record<string, Handler[]> = {};
      const sent: SentMessage[] = [];
      installExtension(makePi(handlers, sent));
      startSession(handlers, isIdle);
      try {
        await run({ handlers, sent, manager: staged.manager });
      } finally {
        handlers.session_shutdown?.[0]?.({ reason: "quit" });
        discardWorkflowRuntime();
      }
    });
  } finally {
    discardWorkflowRuntime();
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

function workflowResultMessages(messages: any[]): any[] {
  return messages.filter(
    (message) => message?.role === "toolResult" && message?.toolName === "workflow_message_notification",
  );
}

test("the current blocking output delivery bypasses a full unrelated awaitingAck page", async () => {
  let hostIdle = false;
  await withHarness(
    () => hostIdle,
    async ({ handlers, sent, manager }) => {
      for (let index = 0; index < 64; index++) {
        manager.onDeliver?.(`old backlog ${index}`, { runId: `old-backlog-run-${index}` });
      }
      assert.equal(sent.length, 64, "the unrelated page should fill the in-flight admission ceiling");
      assert.ok(sent.every((item) => item.options?.triggerTurn === false));
      assert.equal(
        (manager as { __workflowBridge?: { awaitingAck: Map<string, unknown> } }).__workflowBridge?.awaitingAck.size,
        64,
      );

      const runId = "blocking-output-priority-run";
      const toolCallId = "blocking-output-priority-tool";
      for (const handler of handlers.tool_execution_start ?? []) {
        handler({
          type: "tool_execution_start",
          toolCallId,
          toolName: "get_workflow_output",
          args: { runId, block: true },
        });
      }
      manager.onDeliver?.("the blocking wait target", { runId });
      const target = sent.at(-1);
      assert.ok(target, "the matching delivery must be admitted despite 64 unrelated entries");
      assert.equal(target.options?.triggerTurn, false, "the target is passive while get_workflow_output blocks");
      assert.match(String(target.message.content), /blocking wait target/);
      assert.equal(
        (manager as { __workflowBridge?: { awaitingAck: Map<string, unknown> } }).__workflowBridge?.awaitingAck.size,
        65,
      );

      for (const handler of handlers.tool_execution_end ?? []) {
        handler({
          type: "tool_execution_end",
          toolCallId,
          toolName: "get_workflow_output",
          result: { details: { runId, blocked: true, completed: false, delivered: true } },
          isError: false,
        });
      }

      const projected = projectProviderRequest(
        handlers,
        sent.map(({ message }, index) => ({ role: "custom", ...message, timestamp: index + 1 })),
      );
      const notifications = workflowResultMessages(projected);
      assert.ok(
        notifications.some((message) => JSON.stringify(message.content).includes("blocking wait target")),
        "the next provider context must reserve the blocking wait target ahead of the old page",
      );
      assert.ok(notifications.length <= 64, "priority projection must remain bounded");
      hostIdle = true;
    },
  );
});

test("tree navigation is fail-closed until session_tree or a real prompt releases it", async () => {
  let hostIdle = false;
  await withHarness(
    () => hostIdle,
    async ({ handlers, sent, manager }) => {
      const beforeTree = new AbortController();
      for (const handler of handlers.session_before_tree ?? []) handler({ signal: beforeTree.signal });
      manager.onDeliver?.("delivery during active tree mutation", {});
      assert.equal(sent.length, 0, "active tree mutation must not append to the old branch");
      beforeTree.abort();

      for (const handler of handlers.session_tree ?? []) handler({ type: "session_tree" });
      assert.equal(sent.length, 1, "session_tree may flush the queued delivery passively");
      assert.equal(sent[0]?.options?.triggerTurn, false, "session_tree may not start an autonomous turn");

      const missingTree = new AbortController();
      for (const handler of handlers.session_before_tree ?? []) handler({ signal: missingTree.signal });
      manager.onDeliver?.("delivery after tree cancellation", {});
      missingTree.abort();
      for (const handler of handlers.agent_settled ?? []) handler({ type: "agent_settled" });
      assert.equal(sent.length, 1, "abort/cancel without session_tree must remain fail-closed");

      beginRealPrompt(handlers, "continue after tree cancellation");
      const recovered = projectProviderRequest(handlers, [
        { role: "user", content: [{ type: "text", text: "continue after tree cancellation" }], timestamp: 10 },
      ]);
      assert.ok(
        workflowResultMessages(recovered).some((message) =>
          JSON.stringify(message.content).includes("delivery after tree cancellation"),
        ),
        "the next genuine prompt must consume the fail-closed tree backlog",
      );
      assert.equal(sent.length, 1, "real prompt recovery must not create another triggerTurn delivery");
      hostIdle = true;
    },
  );
});

test("an aborted context preflight cannot acknowledge an omitted delivery on the next request", async () => {
  await withHarness(
    () => false,
    async ({ handlers, sent, manager }) => {
      manager.onDeliver?.("preflight-only delivery", {});
      assert.equal(sent.length, 1);
      const history = [{ role: "custom", ...sent[0]?.message, timestamp: 1 }];
      const aborted = new AbortController();
      aborted.abort();

      const preflight = projectMessages(handlers, history, aborted.signal);
      assert.ok(
        workflowResultMessages(preflight).some((message) =>
          JSON.stringify(message.content).includes("preflight-only delivery"),
        ),
        "the aborted preflight may shape a provider copy but must not establish acknowledgement state",
      );

      // Model the host's next request omitting the custom entry. This direct
      // lifecycle call is intentional: it catches a stale projected ID even
      // when no second context hook runs to clear it first.
      for (const handler of handlers.before_provider_request ?? []) handler({}, {});
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });

      const replay = projectProviderRequest(handlers, history);
      assert.ok(
        workflowResultMessages(replay).some((message) =>
          JSON.stringify(message.content).includes("preflight-only delivery"),
        ),
        "the omitted request must not falsely retire the delivery; it remains replayable",
      );
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });

      const acknowledged = projectMessages(handlers, history);
      assert.equal(
        workflowResultMessages(acknowledged).length,
        0,
        "only the request that actually included the delivery may acknowledge it",
      );
    },
  );
});
