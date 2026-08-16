import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowResourceCoordinator } from "../src/workflow-resource-coordinator.js";

test("resource coordinator grants provider waiters FIFO and removes aborted waiters", async () => {
  const coordinator = new WorkflowResourceCoordinator({ maxProviderConcurrency: 1, maxQueuedProviderAttempts: 4 });
  const first = await coordinator.acquireProvider("run-a", undefined, "project-a", "generation-1");
  assert.ok(first);
  const order: string[] = [];
  const second = coordinator.acquireProvider("run-b", undefined, "project-a", "generation-2").then((release) => {
    order.push("second");
    return release;
  });
  const thirdController = new AbortController();
  const third = coordinator.acquireProvider("run-c", thirdController.signal, "project-a", "generation-3");
  thirdController.abort();
  assert.equal(await third, null);
  first?.();
  const secondRelease = await second;
  assert.deepEqual(order, ["second"]);
  secondRelease?.();
  assert.equal(coordinator.queuedProviderAttempts, 0);
  assert.equal(coordinator.snapshot().providerAttempts, 0);
});

test("execution reservations are opaque, namespace/generation fenced, and single-use", () => {
  const coordinator = new WorkflowResourceCoordinator({ maxActiveExecutions: 1 });
  const first = coordinator.acquireExecution("same", "project-a", "generation-1");
  assert.ok(first);
  assert.equal(coordinator.acquireExecution("same", "project-a", "generation-2"), null);
  assert.equal(coordinator.acquireExecution("same", "project-b", "generation-1"), null);
  coordinator.releaseExecution(first);
  coordinator.releaseExecution(first);
  const second = coordinator.acquireExecution("same", "project-b", "generation-1");
  assert.ok(second);
  assert.notEqual(second.token, first.token);
  coordinator.releaseExecution(first);
  assert.equal(coordinator.snapshot().activeExecutions, 1);
  coordinator.releaseExecution(second);
  assert.equal(coordinator.snapshot().activeExecutions, 0);
});

test("boolean execution probes never consume capacity", () => {
  const coordinator = new WorkflowResourceCoordinator({ maxActiveExecutions: 1 });
  assert.equal(coordinator.tryAcquireExecution("probe-a"), true);
  assert.equal(coordinator.tryAcquireExecution("probe-b"), true);
  assert.equal(coordinator.snapshot().activeExecutions, 0);

  const reservation = coordinator.acquireExecution("real");
  assert.ok(reservation);
  assert.equal(coordinator.tryAcquireExecution("blocked"), false);
  assert.equal(coordinator.snapshot().activeExecutions, 1);
  coordinator.releaseExecution(reservation);
});

test("late marking is scoped to one execution generation", () => {
  const coordinator = new WorkflowResourceCoordinator({ maxLateAttempts: 4 });
  for (const [attemptId, runId, resourceGeneration] of [
    ["a", "run-a", "gen-a"],
    ["b", "run-b", "gen-b"],
  ] as const) {
    assert.ok(
      coordinator.registerLateAttempt({ attemptId, runId, callId: attemptId, generation: 1, resourceGeneration }),
    );
  }
  coordinator.markLateScope({ runId: "run-a", resourceGeneration: "gen-a" });
  assert.equal(coordinator.getLateAttempts().find((item) => item.attemptId === "a")?.lateAt !== undefined, true);
  assert.equal(coordinator.getLateAttempts().find((item) => item.attemptId === "b")?.lateAt, undefined);
});

test("late attempts are marked once, retain usage metadata, and settle removes them", () => {
  const coordinator = new WorkflowResourceCoordinator({ maxLateAttempts: 2 });
  const attempt = coordinator.registerLateAttempt({
    attemptId: "attempt-1",
    runId: "run",
    callId: "run:0",
    generation: 1,
    label: "worker",
  });
  assert.ok(attempt);
  coordinator.markLate("attempt-1");
  const first = coordinator.getLateAttempts()[0];
  coordinator.markLate("attempt-1");
  assert.equal(coordinator.getLateAttempts()[0]?.lateAt, first?.lateAt);
  attempt?.update({ usage: { total: 7 }, usageState: "reported" });
  assert.deepEqual(coordinator.getLateAttempts()[0]?.usage, { total: 7 });
  attempt?.settle();
  assert.equal(coordinator.getLateAttempts().length, 0);
});

test("late attempt settlement is identity-safe when an ID is reused", () => {
  const coordinator = new WorkflowResourceCoordinator({ maxLateAttempts: 2 });
  const first = coordinator.registerLateAttempt({
    attemptId: "reused",
    runId: "run",
    callId: "run:0",
    generation: 1,
    executionGeneration: "execution-a",
    resourceGeneration: "resource-a",
  });
  const second = coordinator.registerLateAttempt({
    attemptId: "reused",
    runId: "run",
    callId: "run:0",
    generation: 2,
    executionGeneration: "execution-b",
    resourceGeneration: "resource-b",
  });
  assert.ok(first);
  assert.ok(second);

  first?.update({ usage: { total: 1 } });
  assert.equal(coordinator.getLateAttempts()[0]?.usage, undefined);
  first?.settle();
  assert.deepEqual(coordinator.getLateAttempts()[0], {
    attemptId: "reused",
    runId: "run",
    callId: "run:0",
    generation: 2,
    executionGeneration: "execution-b",
    resourceGeneration: "resource-b",
    startedAt: coordinator.getLateAttempts()[0]?.startedAt,
    usageState: "unknown",
  });
  second?.settle();
  assert.equal(coordinator.getLateAttempts().length, 0);
});

test("late marking requires the matching execution and resource generation", () => {
  const coordinator = new WorkflowResourceCoordinator({ maxLateAttempts: 4 });
  for (const [attemptId, executionGeneration, resourceGeneration] of [
    ["a", "execution-a", "resource-a"],
    ["b", "execution-b", "resource-b"],
  ] as const) {
    assert.ok(
      coordinator.registerLateAttempt({
        attemptId,
        runId: "same-run",
        callId: attemptId,
        generation: 1,
        executionGeneration,
        resourceGeneration,
      }),
    );
  }
  coordinator.markLateScope({
    runId: "same-run",
    executionGeneration: "execution-a",
    resourceGeneration: "resource-a",
  });
  assert.equal(coordinator.getLateAttempts().find((item) => item.attemptId === "a")?.lateAt !== undefined, true);
  assert.equal(coordinator.getLateAttempts().find((item) => item.attemptId === "b")?.lateAt, undefined);
});
