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
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
export declare class SharedStore {
    private readonly map;
    private readonly agentDeltas;
    private readonly priorValues;
    private readonly keyOwners;
    private readonly retiredDeltas;
    private disposed;
    private assertLive;
    /** Reject callbacks from an exhausted/committed attempt before any read/write. */
    assertDeltaLive(deltaKey: string, message?: string): void;
    /** Store a value under `key`. Overwrites any existing value. */
    put(key: string, value: unknown): void;
    /**
     * Store a value and record the write in the per-agent delta for `deltaKey`
     * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
     * per-agent tools created via `createAgentStoreTools` so that each agent's
     * writes can be journaled and replayed independently.
     */
    trackPut(key: string, value: unknown, deltaKey: string): void;
    /** Retrieve the value for `key`, or `undefined` when absent. */
    get(key: string): unknown;
    /** Whether `key` is present in the store. */
    has(key: string): boolean;
    /** Return a deep-copied plain-object snapshot of all entries. */
    snapshot(): Record<string, unknown>;
    /**
     * Extract and clear the write delta accumulated for `deltaKey`.
     * Called after an agent completes to get the set of keys it wrote.
     */
    commitDelta(deltaKey: string): Record<string, unknown>;
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
    discardDelta(deltaKey: string): void;
    /**
     * Apply a write delta additively — sets each key without clearing others.
     * Used during resume replay so parallel-agent deltas applied in callSeq
     * order accumulate correctly regardless of original completion order.
     * Replay deltas arrive as JSON-parsed plain objects, where `__proto__` is an
     * ordinary own data property; iterating with Object.keys and Map#set keeps
     * prototype-sensitive keys safe (no prototype pollution).
     */
    applyDelta(delta: Record<string, unknown>): void;
    /**
     * Replace all entries with a snapshot (for full resets).
     * Prefer `applyDelta` for resume replay — see journal integration above.
     */
    restore(snap: Record<string, unknown>): void;
    /** Clear all entries (called when the run ends). */
    dispose(): void;
}
/**
 * Create per-agent store tools that attribute writes to `deltaKey`, a
 * run/attempt-unique string (see the `SharedStore` class doc for why a bare
 * callIndex or a reused retry key is unsafe once nested workflows/retries share
 * this store).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export declare function createAgentStoreTools(store: SharedStore, deltaKey: string): ToolDefinition[];
