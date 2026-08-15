/**
 * In-memory key-value store scoped to a single workflow run.
 *
 * One `SharedStore` instance is created at run start and disposed when the run
 * ends. Two MCP-compatible tool definitions (`store_put` / `store_get`) are
 * injected into every agent's tool list so parallel agents can share
 * intermediate state without coordinating through the script itself.
 *
 * Journal integration: callers capture `store.commitDelta(deltaKey)` alongside
 * each agent result in the journal. On resume, `store.applyDelta(delta)` rebuilds
 * the store state additively in callSeq order, so parallel-agent writes are
 * replayed correctly without the last-complete-wins ordering bug that a
 * whole-Map restore() would cause.
 *
 * `deltaKey` must be unique across every run and attempt that shares this store
 * instance, not just within one run's callSeq. A nested `workflow()` call
 * restarts its own callSeq while inheriting the parent's store, and retries must
 * not reuse an exhausted delta window. Callers therefore compose a run/call
 * identity and, for live attempts, append an attempt generation; the composite
 * key is unique across the whole store's lifetime. Both store reads and writes
 * are fenced to that live delta window, so a late callback cannot observe or
 * mutate a retry after its attempt has been retired.
 */

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export class SharedStore {
  private readonly map = new Map<string, unknown>();
  // Per-agent write deltas for delta-journaling; keyed by a run-unique
  // `${runId}:${callIndex}` string (see class doc) so nested workflow() runs
  // sharing this store can't collide on a bare callIndex.
  // Deltas use a null-prototype object so prototype-sensitive keys like
  // `__proto__` are stored as own data properties (JSON round-trips them).
  private readonly agentDeltas = new Map<string, Record<string, unknown>>();
  // Pre-write shadow values for the CURRENT delta-key's in-progress writes,
  // so a failed retry attempt's mutations can be rolled back (see
  // `discardDelta`) instead of leaking into the live store or a later
  // successful attempt's recorded delta. Populated lazily by `trackPut` (only
  // the first write to a given key within the current delta window is
  // shadowed — later writes to the same key within the same attempt are
  // already covered by that first shadow) and cleared whenever the delta is
  // finalized, either way, via `commitDelta`/`discardDelta`.
  private readonly priorValues = new Map<string, Map<string, { existed: boolean; value: unknown }>>();
  // Per-key last-writer record: which deltaKey owns the CURRENT value. Used by
  // `discardDelta` to decide rollback ownership by identity (not value
  // equality), so a failing attempt can never erase a sibling's same-valued
  // write (FQ-004). Cleared on commit/discard/dispose for keys this delta owns.
  private readonly keyOwners = new Map<string, { deltaKey: string }>();
  // Delta windows are one-shot. Retiring a window prevents a late tool callback
  // from an exhausted/committed retry attempt from reopening it and contaminating
  // the next attempt (or a disposed run).
  private readonly retiredDeltas = new Set<string>();
  private disposed = false;

  private assertLive(): void {
    if (this.disposed) throw new Error("shared store is disposed");
  }

  /** Reject callbacks from an exhausted/committed attempt before any read/write. */
  assertDeltaLive(deltaKey: string, message = "store callback belongs to a completed agent attempt"): void {
    this.assertLive();
    if (this.retiredDeltas.has(deltaKey)) throw new Error(message);
  }

  /** Store a value under `key`. Overwrites any existing value. */
  put(key: string, value: unknown): void {
    this.assertLive();
    this.map.set(key, value);
    // Untracked (script-level) writes do not participate in delta ownership.
    this.keyOwners.delete(key);
  }

  /**
   * Store a value and record the write in the per-agent delta for `deltaKey`
   * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
   * per-agent tools created via `createAgentStoreTools` so that each agent's
   * writes can be journaled and replayed independently.
   */
  trackPut(key: string, value: unknown, deltaKey: string): void {
    this.assertDeltaLive(deltaKey, "store write belongs to a completed agent attempt");
    let priors = this.priorValues.get(deltaKey);
    if (!priors) {
      priors = new Map();
      this.priorValues.set(deltaKey, priors);
    }
    // Only shadow the value from BEFORE this delta window started writing to
    // this key — a second write to the same key within the same attempt must
    // not overwrite the shadow with its own (already-in-window) value.
    if (!priors.has(key)) {
      priors.set(
        key,
        this.map.has(key) ? { existed: true, value: this.map.get(key) } : { existed: false, value: undefined },
      );
    }
    this.map.set(key, value);
    this.keyOwners.set(key, { deltaKey });
    let delta = this.agentDeltas.get(deltaKey);
    if (!delta) {
      delta = Object.create(null) as Record<string, unknown>;
      this.agentDeltas.set(deltaKey, delta);
    }
    delta[key] = value;
  }

  /** Retrieve the value for `key`, or `undefined` when absent. */
  get(key: string): unknown {
    this.assertLive();
    return this.map.get(key);
  }

  /** Whether `key` is present in the store. */
  has(key: string): boolean {
    this.assertLive();
    return this.map.has(key);
  }

  /** Return a deep-copied plain-object snapshot of all entries. */
  snapshot(): Record<string, unknown> {
    this.assertLive();
    return structuredClone(Object.fromEntries(this.map));
  }

  /**
   * Extract and clear the write delta accumulated for `deltaKey`.
   * Called after an agent completes to get the set of keys it wrote.
   */
  commitDelta(deltaKey: string): Record<string, unknown> {
    this.assertLive();
    if (this.retiredDeltas.has(deltaKey)) throw new Error("agent attempt delta is already completed");
    const delta = this.agentDeltas.get(deltaKey) ?? Object.create(null);
    this.retiredDeltas.add(deltaKey);
    // Drop ownership records for keys this delta owns (they are now durable).
    for (const key of Object.keys(delta)) {
      const owner = this.keyOwners.get(key);
      if (owner?.deltaKey === deltaKey) this.keyOwners.delete(key);
    }
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
    // Return a normal plain object for API/test compatibility while retaining
    // null-prototype storage internally against prototype-sensitive writes.
    return Object.fromEntries(Object.entries(delta));
  }

  /**
   * Undo the writes recorded for `deltaKey` and discard its bookkeeping,
   * without touching any other key. Used when a retry attempt fails: that
   * attempt's writes must not remain visible in the live store (e.g. to a
   * concurrently-running sibling agent's store_get, or to script code reading
   * `store.get` directly) and must not merge into the delta eventually
   * recorded when a later attempt of the SAME call succeeds — otherwise a
   * failed attempt's mutations would silently survive into the run's live
   * state while being absent from the journaled delta that resume replay
   * reconstructs from, leaving live execution and replay permanently
   * inconsistent. Each key touched during this delta window is restored to
   * whatever it held immediately before the window started (or deleted, if
   * it did not exist yet) — never to some other attempt's or caller's value.
   *
   * Per-key guard: a key is only rolled back if the store's CURRENT value is
   * still OWNED by this attempt's delta window (tracked by `keyOwners`, not by
   * value equality). If a concurrently-running sibling (a different `deltaKey`,
   * e.g. another agent in the same parallel() batch) legitimately overwrote the
   * same key AFTER this attempt wrote it but BEFORE it failed — including a
   * write of the exact same primitive or object reference — that sibling's
   * write is left untouched; rolling back unconditionally would silently erase
   * a live, unrelated write that this attempt never made.
   *
   * A no-op if `deltaKey` never wrote anything (nothing to roll back).
   */
  discardDelta(deltaKey: string): void {
    if (this.disposed || this.retiredDeltas.has(deltaKey)) return;
    this.retiredDeltas.add(deltaKey);
    const delta = this.agentDeltas.get(deltaKey);
    if (!delta) return;
    const priors = this.priorValues.get(deltaKey);
    for (const key of Object.keys(delta)) {
      // Ownership check by identity: only roll back if THIS delta still owns
      // the current value (FQ-004 — same-valued sibling writes must survive).
      if (this.keyOwners.get(key)?.deltaKey !== deltaKey) continue;
      const prior = priors?.get(key);
      if (prior?.existed) this.map.set(key, prior.value);
      else this.map.delete(key);
      this.keyOwners.delete(key);
    }
    this.agentDeltas.delete(deltaKey);
    this.priorValues.delete(deltaKey);
  }

  /**
   * Apply a write delta additively — sets each key without clearing others.
   * Used during resume replay so parallel-agent deltas applied in callSeq
   * order accumulate correctly regardless of original completion order.
   * Replay deltas arrive as JSON-parsed plain objects, where `__proto__` is an
   * ordinary own data property; iterating with Object.keys and Map#set keeps
   * prototype-sensitive keys safe (no prototype pollution).
   */
  applyDelta(delta: Record<string, unknown>): void {
    this.assertLive();
    for (const [k, v] of Object.entries(delta)) {
      this.map.set(k, v);
    }
  }

  /**
   * Replace all entries with a snapshot (for full resets).
   * Prefer `applyDelta` for resume replay — see journal integration above.
   */
  restore(snap: Record<string, unknown>): void {
    this.assertLive();
    // A full restore invalidates every in-progress delta window. Retire the
    // keys before clearing their bookkeeping so late tool callbacks cannot
    // reopen an old window and mutate the newly restored snapshot.
    for (const deltaKey of this.agentDeltas.keys()) this.retiredDeltas.add(deltaKey);
    for (const deltaKey of this.priorValues.keys()) this.retiredDeltas.add(deltaKey);
    this.map.clear();
    this.agentDeltas.clear();
    this.priorValues.clear();
    this.keyOwners.clear();
    for (const [k, v] of Object.entries(snap)) {
      this.map.set(k, v);
    }
  }

  /** Clear all entries (called when the run ends). */
  dispose(): void {
    this.disposed = true;
    this.map.clear();
    this.agentDeltas.clear();
    this.priorValues.clear();
    this.keyOwners.clear();
    this.retiredDeltas.clear();
  }
}

/**
 * Create per-agent store tools that attribute writes to `deltaKey`, a
 * run/attempt-unique string (see the `SharedStore` class doc for why a bare
 * callIndex or a reused retry key is unsafe once nested workflows/retries share
 * this store).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export function createAgentStoreTools(store: SharedStore, deltaKey: string): ToolDefinition[] {
  const storePut = defineTool({
    name: "store_put",
    label: "Store Put",
    description:
      "Write a value to the shared run store. Any other agent in this workflow run can read it with store_get. Overwrites any existing value for the key. Note: when two parallel agents write the same key, the last write wins — no merge is performed.",
    promptSnippet: "Write a value to the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to store the value under." }),
      value: Type.Any({ description: "The value to store (any JSON-serializable value)." }),
    }),
    async execute(_id: string, params: { key: string; value: unknown }) {
      store.trackPut(params.key, params.value, deltaKey);
      return {
        content: [{ type: "text", text: `Stored value under key "${params.key}".` }],
        details: { key: params.key },
      };
    },
  }) as unknown as ToolDefinition;

  const storeGet = defineTool({
    name: "store_get",
    label: "Store Get",
    description:
      "Read a value from the shared run store previously written by store_put. Returns the stored value, or null when the key does not exist.",
    promptSnippet: "Read a value from the shared store",
    parameters: Type.Object({
      key: Type.String({ description: "The key to read." }),
    }),
    async execute(_id: string, params: { key: string }) {
      // Reads are fenced too: a timed-out attempt must not observe a retry's
      // state and continue acting on it after its own delta window retired.
      store.assertDeltaLive(deltaKey);
      const found = store.has(params.key);
      const value = store.get(params.key);
      const text = found
        ? `Value for key "${params.key}": ${JSON.stringify(value)}`
        : `Key "${params.key}" not found in store.`;
      return {
        content: [{ type: "text", text }],
        details: { key: params.key, value: found ? value : null, found },
      };
    },
  }) as unknown as ToolDefinition;

  return [storePut, storeGet];
}
