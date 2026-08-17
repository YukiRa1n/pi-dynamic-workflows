import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowErrorCode } from "../src/errors.js";
import { MAX_EXPLICIT_DELIVERIES_PER_WINDOW, WorkflowManager } from "../src/workflow-manager.js";
import { waitFor } from "./helpers/wait-for.js";

const script = `export const meta = { name: "delivery-governance", description: "delivery test" }
const value = await agent("produce", { label: "producer" })
return value`;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "pi-dw-delivery-"));
}

function manager(cwd: string): WorkflowManager {
  return new WorkflowManager({
    cwd,
    agent: { run: async () => "complete" },
  });
}

test("explicit delivery admission is finite while terminal delivery remains reserved", async () => {
  const cwd = tempDir();
  try {
    const m = manager(cwd);
    const delivered: string[] = [];
    m.onDeliver = (message) => {
      delivered.push(message);
    };
    const burst = `export const meta = { name: "burst", description: "burst" }
for (let i = 0; i < ${MAX_EXPLICIT_DELIVERIES_PER_WINDOW + 1}; i++) await deliver({ kind: "critical_finding", message: "delivery-" + i })
return "done"`;
    const run = m.startInBackground(burst);
    await assert.rejects(run.promise, (error: unknown) => {
      return error instanceof Error && /delivery budget exceeded/i.test(error.message);
    });
    const state = m.getPersistence().load(run.runId);
    assert.equal(delivered.length, MAX_EXPLICIT_DELIVERIES_PER_WINDOW);
    assert.equal(state?.status, "failed");
    assert.equal(
      state?.deliveryOutbox?.filter((item) => item.kind === "explicit").length,
      MAX_EXPLICIT_DELIVERIES_PER_WINDOW,
    );
    assert.ok(
      state?.deliveryOutbox
        ?.filter((item) => item.kind === "explicit")
        .every((item) => item.alertKind === "critical_finding"),
    );
    assert.equal(state?.deliveryOutbox?.filter((item) => item.terminal).length, 1);
    assert.equal(new Set(state?.deliveryOutbox?.map((item) => item.deliveryId)).size, state?.deliveryOutbox?.length);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("outbox acknowledgement is generation-fenced and removes only the same stable ID", async () => {
  const cwd = tempDir();
  try {
    const m = manager(cwd);
    const run = m.startInBackground(script);
    await run.promise;
    const pending = m.listPendingDeliveries();
    assert.equal(pending.length, 1, "background completion has one terminal outbox record");
    const item = pending[0];
    assert.equal(m.acknowledgeDelivery(item.runId, item.deliveryId, 4, "submitted"), true);
    assert.equal(
      m.acknowledgeDelivery(item.runId, item.deliveryId, 3, "submitted"),
      false,
      "stale submission cannot rewind generation",
    );
    assert.equal(m.acknowledgeDelivery(item.runId, item.deliveryId, 4, "projected"), true);
    assert.equal(m.acknowledgeDelivery(item.runId, item.deliveryId, 3, "acknowledged"), false);
    assert.equal(m.listPendingDeliveries().length, 1, "stale generation cannot acknowledge current delivery");
    assert.equal(m.acknowledgeDelivery(item.runId, item.deliveryId, 4, "acknowledged"), true);
    assert.equal(m.listPendingDeliveries().length, 0);
    assert.equal(m.getPersistence().load(item.runId)?.result, "complete");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("acknowledged explicit delivery cannot reuse its stable ID for terminal completion", async () => {
  const cwd = tempDir();
  try {
    const m = manager(cwd);
    let explicit: { runId?: string; deliveryId?: string } | undefined;
    m.onDeliver = (_message, source) => {
      explicit = source;
    };
    const run = m.startInBackground(`export const meta = { name: "sequence", description: "monotonic delivery ids" }
await deliver({ kind: "decision", message: "early" })
return await agent("finish", { label: "finisher" })`);
    await waitFor(() => explicit?.deliveryId, { description: "explicit delivery id to be allocated" });
    assert.equal(m.acknowledgeDelivery(run.runId, explicit.deliveryId, 1, "submitted"), true);
    assert.equal(m.acknowledgeDelivery(run.runId, explicit.deliveryId, 1, "projected"), true);
    assert.equal(m.acknowledgeDelivery(run.runId, explicit.deliveryId, 1, "acknowledged"), true);
    await run.promise;
    const terminal = m.listPendingDeliveries().find((item) => item.kind === "terminal");
    assert.ok(terminal);
    assert.notEqual(terminal.deliveryId, explicit.deliveryId);
    assert.ok(terminal.sequence > 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("outbox replay obeys session ownership", async () => {
  const cwd = tempDir();
  try {
    const m = manager(cwd);
    m.setSessionId("session-a");
    const run = m.startInBackground(script);
    await run.promise;
    m.setSessionId("session-b");
    assert.equal(m.listPendingDeliveries().length, 0);
    m.setSessionId("session-a");
    assert.equal(m.listPendingDeliveries().length, 1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("delivery budget rejection is classified without changing explicit steering semantics", () => {
  assert.equal(WorkflowErrorCode.DELIVERY_BUDGET_EXCEEDED, "DELIVERY_BUDGET_EXCEEDED");
});
