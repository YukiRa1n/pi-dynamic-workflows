import { constants, setPriority } from "node:os";
import { isMainThread } from "node:worker_threads";
import { assertValidationMemory } from "./validation-memory.mjs";

// Let interactive applications win CPU contention during local validation.
// This changes only this process; it does not change system configuration.
if (!process.env.CI && isMainThread) {
  try {
    assertValidationMemory();
  } catch (error) {
    console.error(`[validation] ${error.message}`);
    process.exit(2);
  }
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Sandboxed hosts may deny priority changes; validation must still run.
  }
}
