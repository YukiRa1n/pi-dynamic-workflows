import assert from "node:assert/strict";
import test from "node:test";
import { memoryPressureReason } from "../scripts/validation-memory.mjs";

const GiB = 1024 ** 3;
test("validation refuses commit exhaustion even when physical memory appears available", () => {
  assert.match(memoryPressureReason({ freePhysical: 6 * GiB, committed: 29 * GiB, limit: 32 * GiB }), /committed/);
  assert.match(memoryPressureReason({ freePhysical: 6 * GiB, committed: 26 * GiB, limit: 32 * GiB }), /80%/);
});
test("validation checks physical headroom and fails closed on invalid commit counters", () => {
  assert.match(memoryPressureReason({ freePhysical: GiB, committed: 10 * GiB, limit: 32 * GiB }), /physical/);
  assert.match(memoryPressureReason({ freePhysical: 6 * GiB, committed: NaN, limit: 32 * GiB }), /unavailable/);
  assert.equal(memoryPressureReason({ freePhysical: 6 * GiB, committed: 18 * GiB, limit: 32 * GiB }), undefined);
});
