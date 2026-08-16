import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunPersistence } from "../src/run-persistence.js";

const paused = (runId: string, sessionId: string, outbox = false) => ({
  runId,
  workflowName: runId,
  script: "await agent('x')",
  sessionId,
  status: "paused" as const,
  phases: [],
  agents: [],
  logs: [],
  startedAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
  deliveryOutbox: outbox
    ? [
        {
          deliveryId: `${runId}:delivery`,
          sequence: 0,
          kind: "explicit" as const,
          status: "pending" as const,
          content: "keep",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ]
    : [],
});

test("paused prune validates limits, keeps dry-run default, and fences ownership/outbox", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-prune-"));
  try {
    const persistence = createRunPersistence(cwd);
    persistence.save(paused("old-a", "session-a"));
    persistence.save(paused("old-b", "session-b"));
    persistence.save(paused("outbox", "session-a", true));
    assert.throws(() => persistence.prunePausedRuns({ before: "not-a-date" }), /finite valid date/i);
    assert.throws(() => persistence.prunePausedRuns({ before: Date.now(), maxRuns: -1 }), /maxRuns/i);
    assert.throws(() => persistence.prunePausedRuns({ before: Date.now(), maxBytes: Infinity }), /maxBytes/i);
    const dry = persistence.prunePausedRuns({ before: "2099-01-01T00:00:00.000Z", maxRuns: 0, maxBytes: 0 });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.candidates, []);
    const filtered = persistence.prunePausedRuns({
      before: "2099-01-01T00:00:00.000Z",
      sessionId: "session-a",
      protectedRunIds: new Set(["old-a"]),
      dryRun: false,
    });
    assert.deepEqual(filtered.deleted, []);
    assert.ok(filtered.skipped.some((item) => item.runId === "old-a"));
    assert.ok(filtered.skipped.some((item) => item.runId === "outbox"));
    const deleted = persistence.prunePausedRuns({
      before: "2099-01-01T00:00:00.000Z",
      sessionId: "session-a",
      dryRun: false,
    });
    assert.deepEqual(deleted.deleted, ["old-a"]);
    assert.equal(persistence.load("old-a"), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
