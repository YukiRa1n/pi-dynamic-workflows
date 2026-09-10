import assert from "node:assert/strict";
import test from "node:test";
import { deliveryFromOutboxRecord } from "../extensions/workflow.js";
import type { WorkflowManager } from "../src/workflow-manager.js";

test("cold terminal replay carries semantic results and partial quality", () => {
  const manager = {
    getRun: () => undefined,
    getPersistence: () => ({
      getRunsDir: () => "C:/runs",
      load: () => ({ outcome: "partial", result: { report: "useful recovered findings" } }),
    }),
  } as unknown as WorkflowManager;
  const delivery = deliveryFromOutboxRecord(manager, {
    runId: "recovered-run",
    workflowName: "audit",
    runStatus: "completed",
    deliveryId: "delivery-1",
    sequence: 1,
    kind: "terminal",
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  assert.match(delivery.content, /partially completed/);
  assert.match(delivery.content, /useful recovered findings/);
  assert.match(delivery.content, /do not claim full completion/);
});

test("an already persisted delivery does not load or re-project its run", () => {
  const manager = {
    getRun: () => ({
      result: {
        get result() {
          throw new Error("must not inspect");
        },
      },
    }),
    getPersistence: () => {
      throw new Error("must not load");
    },
  } as unknown as WorkflowManager;
  const delivery = deliveryFromOutboxRecord(manager, {
    runId: "recovered-run",
    workflowName: "audit",
    runStatus: "completed",
    content: "canonical body",
    deliveryId: "delivery-1",
    sequence: 1,
    kind: "terminal",
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  assert.equal(delivery.content, "canonical body");
});

test("oversized recovery diagnostics cannot crowd out the actual result", () => {
  const manager = {
    getRun: () => undefined,
    getPersistence: () => ({
      getRunsDir: () => "C:/runs",
      load: () => ({
        failure: { message: "错误原因".repeat(4_000) },
        result: "final recovered finding",
      }),
    }),
  } as unknown as WorkflowManager;
  const delivery = deliveryFromOutboxRecord(manager, {
    runId: "recovered-run",
    workflowName: "名称".repeat(4_000),
    runStatus: "failed",
    deliveryId: "delivery-2",
    sequence: 2,
    kind: "terminal",
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  assert.match(delivery.content, /final recovered finding/);
  assert.ok(Buffer.byteLength(delivery.content) < 32_000);
});
