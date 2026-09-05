import { constants, setPriority } from "node:os";

// Let interactive applications win CPU contention during local validation.
// This changes only this process; it does not change system configuration.
if (!process.env.CI) {
  try {
    setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Sandboxed hosts may deny priority changes; validation must still run.
  }
}
