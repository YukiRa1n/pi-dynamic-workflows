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
        hasPendingMessages: () => false,
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
    assert.deepEqual(sent[2]?.options, { triggerTurn: true });

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

test("Esc ordinal fencing changes wake eligibility, not body projection", async () => {
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
    assert.equal(notificationResults(firstHiddenRequest).length, 2);
    assert.match(JSON.stringify(firstHiddenRequest), /arrived after Esc/);
    emit(handlers, "after_provider_response", { status: 200, headers: {} });

    // Bodies remain projected in every provider context; the ordinal fence
    // controls autonomous wake eligibility, not provider visibility.
    const secondHiddenRequest = projectProviderRequest(handlers, [
      { role: "custom", ...sent[0]?.message, timestamp: 4 },
      { role: "custom", ...sent[1]?.message, timestamp: 5 },
      { role: "custom", ...sent[2]?.message, timestamp: 6 },
    ]);
    assert.equal(notificationResults(secondHiddenRequest).length, 2);
    assert.match(JSON.stringify(secondHiddenRequest), /arrived after Esc/);
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

test("Esc ordinal cutoff fences the old arrival but admits a newer ordinal", async () => {
  await withHarness("esc-ordinal-boundary", async ({ handlers, sent, staged, setHostIdle }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    staged.manager.onDeliver?.("ordinal A", {
      runId: "ordinal-boundary-run",
      workflowName: "ordinal boundary",
      alertKind: "critical_finding",
      sequence: 1,
    });
    const firstId = sent[0]?.message?.details?.deliveryId as string;
    assert.ok(firstId);
    const firstOrdinal = bridge.arrivalOrdinalById.get(firstId);
    assert.equal(typeof firstOrdinal, "number");

    const interrupted = new AbortController();
    emit(handlers, "agent_start", { type: "agent_start" }, { signal: interrupted.signal });
    interrupted.abort();
    const epoch = bridge.abortEpoch;
    assert.ok(epoch, "Esc must create an abort epoch");
    assert.equal(epoch.cutoffOrdinal, firstOrdinal);
    assert.equal(bridge.arrivalOrdinalById.get(firstId), epoch.cutoffOrdinal);

    staged.manager.onDeliver?.("ordinal B", {
      runId: "ordinal-boundary-run",
      workflowName: "ordinal boundary",
      alertKind: "decision",
      sequence: 2,
    });
    const secondId = sent[1]?.message?.details?.deliveryId as string;
    assert.ok(secondId);
    const secondOrdinal = bridge.arrivalOrdinalById.get(secondId);
    assert.equal(secondOrdinal, firstOrdinal + 1);
    assert.ok(secondOrdinal > epoch.cutoffOrdinal);
    assert.equal(bridge.arrivalOrdinalById.get(firstId), firstOrdinal, "replaying A never allocates a new ordinal");
    assert.equal(bridge.wakeState.wakePendingIds.has(firstId), true);
    assert.equal(bridge.wakeState.wakePendingIds.has(secondId), true);

    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const markers = sent.filter(({ message }) => message?.customType === "workflows");
    assert.equal(markers.length, 1, "only the post-cutoff arrival can open the hidden wake");
    assert.equal(markers[0]?.message?.details?.count, 1);
    assert.deepEqual([...bridge.wakeState.activeLoopIds], [secondId]);

    const projected = projectProviderRequest(
      handlers,
      sent
        .filter(({ message }) => message?.customType === "workflow-deliver")
        .map(({ message }, index) => ({ role: "custom", ...message, timestamp: index + 1 })),
    );
    assert.equal(bridge.wakeState.wakeAttemptedIds.has(firstId), false, "A at the cutoff is not a wake attempt");
    assert.equal(bridge.wakeState.wakeAttemptedIds.has(secondId), true, "B after the cutoff may spend the wake");
    assert.equal(
      notificationResults(projected).length,
      2,
      "the ordinal fence changes wake eligibility, not projection",
    );
  });
});

test("a 65-delivery page reserves wake capacity and leaves the overflow unattempted", async () => {
  await withHarness("wake-page-overflow", async ({ handlers, staged }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    let records: any[] = Array.from({ length: 65 }, (_, index) => ({
      deliveryId: `wf_page_${String(index).padStart(2, "0")}`,
      sequence: index,
      kind: "explicit",
      status: "pending",
      content: `page delivery ${index}`,
      alertKind: "critical_finding",
      createdAt: new Date().toISOString(),
      runId: "page-overflow-run",
      workflowName: "page overflow",
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

    // The durable outbox is the source of truth for all 65 deliveries. Seed
    // the first 64 as canonical passive history so only the final record needs
    // recovery admission during this provider context.
    const history = records.slice(0, 64).map((record, index) => ({
      role: "custom",
      customType: "workflow-deliver",
      content: record.content,
      display: false,
      details: {
        deliveryId: record.deliveryId,
        runId: record.runId,
        workflowName: record.workflowName,
        alertKind: record.alertKind,
        sequence: record.sequence,
      },
      timestamp: index + 1,
    }));
    const overflowId = records[64]?.deliveryId;
    assert.ok(overflowId);

    // Model the hidden marker's provider request. The context hook itself still
    // owns pagination; before_provider_request can mark only rows in this page.
    bridge.wakeState.inFlight = true;
    bridge.wakeState.inFlightRunToken = undefined;
    const projected = projectProviderRequest(handlers, [
      { role: "user", content: [{ type: "text", text: "page current prompt" }], timestamp: 0 },
      ...history,
    ]);
    assert.equal(bridge.wakeState.wakePendingIds.size, 65, "all 65 IDs retain wake-pending admission state");
    assert.equal(bridge.wakeState.wakeAttemptedIds.size, 64);
    assert.equal(
      bridge.wakeState.wakeAttemptedIds.has(overflowId),
      false,
      "the capacity-excluded ID stays unattempted for the next page",
    );
    assert.equal(notificationResults(projected).length, 64, "one provider page remains capped at 64 notifications");
    assert.equal(
      projected.some((message) => message?.role === "user" && JSON.stringify(message).includes("page delivery")),
      false,
      "delivery bodies stay passive provider projections rather than user input",
    );
  });
});

test("a non-2xx provider response discards the staged cursor and retries from the same page", async () => {
  await withHarness("cursor-preflight-failure", ({ handlers, sent, staged }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    staged.manager.onDeliver?.("cursor first");
    staged.manager.onDeliver?.("cursor second");
    const history = sent.map(({ message }, index) => ({ role: "custom", ...message, timestamp: index + 1 }));
    const ids = history.map((message) => message.details.deliveryId);
    const firstPage = projectMessages(handlers, history);
    assert.deepEqual(
      notificationResults(firstPage).map((message) => message.toolCallId),
      ids,
    );
    assert.equal(bridge.rotationCursor.stagedCursor, ids.at(-1));
    assert.equal(bridge.rotationCursor.committedCursor, undefined);

    for (const handler of handlers.before_provider_request ?? []) handler({}, {});
    assert.deepEqual(bridge.rotationCursor.associatedRequest?.deliveryIds, ids);
    assert.equal(bridge.rotationCursor.associatedRequest?.stagedCursor, ids.at(-1));
    for (const handler of handlers.after_provider_response ?? []) handler({ status: 500, headers: {} });
    assert.equal(bridge.rotationCursor.stagedCursor, undefined);
    assert.equal(bridge.rotationCursor.associatedRequest, undefined);
    assert.equal(bridge.rotationCursor.committedCursor, undefined);

    const retryPage = projectMessages(handlers, history);
    assert.deepEqual(
      notificationResults(retryPage).map((message) => message.toolCallId),
      ids,
      "a failed preflight response retries the same stable-ID page from the original cursor",
    );
    assert.equal(bridge.rotationCursor.stagedCursor, ids.at(-1));
    assert.equal(bridge.rotationCursor.committedCursor, undefined);
  });
});

test("after delivered-ledger eviction, pure history projection does not rebuild ack tracking", async () => {
  await withHarness("delivered-ledger-eviction", ({ handlers, sent, staged }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    staged.manager.onDeliver?.("eviction target");
    const target = sent[0]?.message;
    const targetId = target?.details?.deliveryId as string;
    const targetHistory = { role: "custom", ...target, timestamp: 1 };
    projectProviderRequest(handlers, [targetHistory]);
    for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
    assert.equal(bridge.awaitingAck.has(targetId), false);
    assert.equal(bridge.ackWatchdogs.has(targetId), false);
    assert.equal(bridge.delivered.has(targetId), true);

    // Four acknowledged 64-row batches push the target out of the bounded
    // rememberDelivery ledger without creating a durable outbox record.
    for (let batch = 0; batch < 4; batch++) {
      const start = sent.length;
      for (let index = 0; index < 64; index++) {
        staged.manager.onDeliver?.(`eviction batch ${batch} row ${index}`);
      }
      const batchHistory = sent
        .slice(start)
        .map(({ message }, index) => ({ role: "custom", ...message, timestamp: batch * 64 + index + 2 }));
      assert.equal(batchHistory.length, 64);
      projectProviderRequest(handlers, batchHistory);
      for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
    }
    assert.equal(bridge.delivered.size, 256);
    assert.equal(bridge.delivered.has(targetId), false, "the original ID was evicted after 256 newer acknowledgements");
    assert.equal(
      staged.manager.listPendingDeliveries().some((record: any) => record.deliveryId === targetId),
      false,
    );

    const projected = projectMessages(handlers, [targetHistory]);
    assert.equal(notificationResults(projected).length, 1, "history still projects the remembered body");
    assert.equal(bridge.awaitingAck.has(targetId), false, "history-only projection does not recreate awaitingAck");
    assert.equal(bridge.ackWatchdogs.has(targetId), false, "history-only projection does not recreate a watchdog");
    assert.equal(
      bridge.projectedForNextRequest.some((item: any) => item.id === targetId),
      false,
      "history-only projection has no transport association",
    );
    assert.equal(
      bridge.includedInProviderRequest.some((item: any) => item.id === targetId),
      false,
      "history-only projection has no provider request association",
    );
  });
});

test("a new wake-pending delivery outranks 64 old history rows in one page", async () => {
  await withHarness("wake-capacity-priority", ({ handlers, sent, staged }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    for (let index = 0; index < 64; index++) {
      staged.manager.onDeliver?.(`old history ${index}`);
    }
    const oldHistory = sent.map(({ message }, index) => ({ role: "custom", ...message, timestamp: index + 1 }));
    assert.equal(oldHistory.length, 64);
    projectProviderRequest(handlers, oldHistory);
    for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
    assert.equal(bridge.awaitingAck.size, 0);

    staged.manager.onDeliver?.("new wake-pending batch");
    const newest = sent.at(-1)?.message;
    const newestId = newest?.details?.deliveryId as string;
    const projected = projectMessages(handlers, [...oldHistory, { role: "custom", ...newest, timestamp: 65 }]);
    const notifications = notificationResults(projected);
    assert.equal(notifications.length, 64, "the provider page remains bounded");
    assert.ok(
      notifications.some((message) => message.toolCallId === newestId),
      "the new wake-pending batch is reserved a slot ahead of old history",
    );
    assert.equal(
      notifications.filter((message) => message.toolCallId !== newestId).length,
      63,
      "one new wake row displaces exactly one old history row",
    );
    assert.equal(
      projected.some((message) => message?.role === "user"),
      false,
      "capacity priority never changes workflow content into user input",
    );
  });
});

test("a real run settling while a marker is in-flight must not release the wake latch", async () => {
  await withHarness("settle-ownership", async ({ handlers, sent, staged, setHostIdle }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    // Deliver a wake-eligible body, then arm + spend the safe point so the
    // hidden marker becomes the in-flight owner.
    staged.manager.onDeliver?.("wake target", {
      runId: "settle-ownership-run",
      workflowName: "settle ownership",
      alertKind: "critical_finding",
      sequence: 1,
    });
    const targetId = sent[0]?.message?.details?.deliveryId as string;
    assert.ok(targetId);

    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const markers = () => sent.filter(({ message }) => message?.customType === "workflows");
    assert.equal(markers().length, 1, "the settled safe point spends exactly one hidden marker");
    assert.equal(bridge.wakeState.inFlight, true, "the marker owns the in-flight latch");

    // The marker begins its turn and records its run token.
    const markerRun = new AbortController();
    emit(handlers, "agent_start", { type: "agent_start" }, { signal: markerRun.signal });
    const markerToken = bridge.wakeState.inFlightRunToken;
    assert.equal(typeof markerToken, "number", "the marker claimed a run token");
    assert.equal(bridge.wakeState.settledMarkerRunTokens.has(markerToken), true);

    // The marker's own provider request completes: before_provider_request sees
    // the marker still owns the latch (activeRunToken === inFlightRunToken) and
    // transfers ownership, marking the marker's settle as consumed.
    projectProviderRequest(handlers, [{ role: "custom", ...sent[0]?.message, timestamp: 2 }]);
    emit(handlers, "after_provider_response", { status: 200, headers: {} });
    assert.equal(
      bridge.wakeState.settledMarkerRunTokens.has(markerToken),
      false,
      "the marker's own request consumes its settle ownership",
    );

    // The marker run now settles. The host serializes runs, so a marker that
    // were still live could not overlap a later start; this settle releases the
    // in-flight latch (the consumed marker settle) without a second marker,
    // because the delivery was already attempted in this request.
    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(bridge.wakeState.inFlight, false, "the marker's own settle releases the in-flight latch");
    assert.equal(
      markers().length,
      1,
      "an already-attempted delivery cannot spend a second marker after the marker settles",
    );
  });
});

test("a real run settling before the marker's provider request must not release the marker latch", async () => {
  await withHarness("settle-real-run-protection", async ({ handlers, sent, staged, setHostIdle }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    staged.manager.onDeliver?.("wake target", {
      runId: "settle-real-run",
      workflowName: "settle real run",
      alertKind: "critical_finding",
      sequence: 1,
    });
    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const markers = () => sent.filter(({ message }) => message?.customType === "workflows");
    assert.equal(markers().length, 1, "the settled safe point spends one hidden marker");

    // The marker begins and claims the latch.
    const markerRun = new AbortController();
    emit(handlers, "agent_start", { type: "agent_start" }, { signal: markerRun.signal });
    assert.equal(bridge.wakeState.inFlight, true);
    assert.equal(typeof bridge.wakeState.inFlightRunToken, "number");

    // A real user prompt arrives while the marker is still in flight (before
    // the marker's provider request). before_agent_start supersedes the marker's
    // ownership so a later real settle cannot consume the latch. A steering
    // input queues into the running loop without releasing wake admission.
    for (const handler of handlers.input ?? [])
      handler({ type: "input", text: "real work", source: "interactive", streamingBehavior: "steer" });
    for (const handler of handlers.before_agent_start ?? []) handler({ prompt: "real work" });
    const userRun = new AbortController();
    emit(handlers, "agent_start", { type: "agent_start" }, { signal: userRun.signal });
    assert.equal(
      bridge.wakeState.inFlightRunToken,
      undefined,
      "the real prompt releases the marker's stale latch ownership",
    );

    // The real run settles while the marker has not completed its request. The
    // settle must not release the marker's in-flight latch.
    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      bridge.wakeState.inFlight,
      true,
      "a real run's settle must not release the in-flight latch owned by the marker",
    );
    assert.equal(markers().length, 1, "no second marker may start while the first marker remains in flight");
  });
});

test("a provider-consumed body parked by an ack failure is not re-woken by context re-observation", async () => {
  await withHarness("provider-consumed-no-rewake", async ({ handlers, sent, staged, setHostIdle }) => {
    const bridge = (staged.manager as any).__workflowBridge as any;
    // The durable acknowledge always fails so the body stays parked as
    // provider-consumed uncertain, never reconciled.
    staged.manager.acknowledgeDelivery = (_runId: string, _deliveryId: string, _generation: number, phase: string) => {
      if (phase === "acknowledged") {
        return false;
      }
      return true;
    };
    staged.manager.onDeliver?.("consumed then ack-failed", {
      runId: "provider-consumed-run",
      workflowName: "provider consumed",
      alertKind: "critical_finding",
      deliveryId: "provider-consumed:1",
      sequence: 1,
    });
    const targetId = sent[0]?.message?.details?.deliveryId as string;
    assert.ok(targetId);
    const body = sent[0]?.message;

    // First provider request consumes the body and returns 2xx. The durable ack
    // fails, so the ID is parked as provider-consumed uncertain.
    projectProviderRequest(handlers, [{ role: "custom", ...body, timestamp: 1 }]);
    for (const handler of handlers.after_provider_response ?? []) handler({ status: 200, headers: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(bridge.uncertainAck.get(targetId)?.providerConsumed, true, "the body is parked provider-consumed");
    assert.equal(bridge.wakeState.wakePendingIds.has(targetId), false, "a consumed body leaves the wake set");

    // A later context re-observes the same canonical history entry. Part A keeps
    // the body projected, but it must NOT rebuild wake/ack tracking or admit the
    // ID back to wakePendingIds.
    const reobserved = projectMessages(handlers, [{ role: "custom", ...body, timestamp: 2 }]);
    assert.equal(notificationResults(reobserved).length, 1, "Part A: the consumed body still projects to the provider");
    assert.equal(
      bridge.wakeState.wakePendingIds.has(targetId),
      false,
      "re-observation must not re-admit a provider-consumed body to the wake set",
    );
    assert.equal(
      bridge.awaitingAck.has(targetId),
      false,
      "re-observation must not rebuild ack tracking for a provider-consumed body",
    );

    // Even with an idle host at a settled safe point, the parked body cannot be
    // spent on a second hidden marker before its durable ack reconciles.
    setHostIdle(true);
    emit(handlers, "agent_settled", { type: "agent_settled" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const markers = sent.filter(({ message }) => message?.customType === "workflows");
    assert.equal(
      markers.some((marker) => JSON.stringify(marker?.message?.details ?? {}).includes(targetId)),
      false,
      "no hidden marker may target a provider-consumed body",
    );
    assert.equal(bridge.uncertainAck.get(targetId)?.providerConsumed, true, "the body stays parked until reconcile");
  });
});
