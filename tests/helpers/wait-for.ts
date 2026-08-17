/**
 * Poll `condition` until it returns a truthy value, with a diagnostic timeout.
 *
 * Bare `while (!x) await sleep(...)` loops hang the test file forever when the
 * condition never becomes true; this helper bounds the wait and fails with a
 * message that names what was being awaited.
 */
export async function waitFor<T>(
  condition: () => T | undefined | null | false,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<T> {
  const { timeoutMs = 5_000, intervalMs = 5, description = "condition" } = options;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = condition();
    if (value) return value;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/**
 * Await `promise`, but fail with a diagnostic timeout instead of hanging
 * forever when it never settles (e.g. an event listener that never fires).
 */
export async function waitForPromise<T>(
  promise: Promise<T>,
  options: { timeoutMs?: number; description?: string } = {},
): Promise<T> {
  const { timeoutMs = 5_000, description = "promise to settle" } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`waitForPromise timed out after ${timeoutMs}ms waiting for: ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
