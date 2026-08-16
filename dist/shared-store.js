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
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_SHARED_STORE_KEY_BYTES, MAX_SHARED_STORE_KEYS, MAX_SHARED_STORE_TOTAL_BYTES, MAX_SHARED_STORE_VALUE_BYTES, } from "./config.js";
import { serializeBounded, serializeIdentity } from "./safe-serialize.js";
export class SharedStore {
    map = new Map();
    valueBytes = new Map();
    totalBytes = 0;
    limits;
    // Per-agent write deltas for delta-journaling; keyed by a run-unique
    // `${runId}:${callIndex}` string (see class doc) so nested workflow() runs
    // sharing this store can't collide on a bare callIndex.
    // Deltas use a null-prototype object so prototype-sensitive keys like
    // `__proto__` are stored as own data properties (JSON round-trips them).
    agentDeltas = new Map();
    // Per-key write-version chains preserve predecessor identity across
    // concurrent failures. A single current-owner marker cannot represent
    // `pre → A → B`: discarding A then B would otherwise restore A's failed
    // value. Nodes are marked committed/discarded and resolved lazily from the
    // head, so rollback skips every failed predecessor without clobbering a
    // later live sibling write. Consecutive writes by the same delta coalesce.
    keyVersionHeads = new Map();
    deltaVersions = new Map();
    // Delta windows are one-shot. Retiring a window prevents a late tool callback
    // from an exhausted/committed retry attempt from reopening it and contaminating
    // the next attempt (or a disposed run).
    retiredDeltas = new Set();
    disposed = false;
    constructor(options = {}) {
        this.limits = {
            maxKeys: positiveLimit(options.maxKeys, MAX_SHARED_STORE_KEYS),
            maxKeyBytes: positiveLimit(options.maxKeyBytes, MAX_SHARED_STORE_KEY_BYTES),
            maxValueBytes: positiveLimit(options.maxValueBytes, MAX_SHARED_STORE_VALUE_BYTES),
            maxTotalBytes: positiveLimit(options.maxTotalBytes, MAX_SHARED_STORE_TOTAL_BYTES),
        };
    }
    assertLive() {
        if (this.disposed)
            throw new Error("shared store is disposed");
    }
    /** Reject callbacks from an exhausted/committed attempt before any read/write. */
    assertDeltaLive(deltaKey, message = "store callback belongs to a completed agent attempt") {
        this.assertLive();
        if (this.retiredDeltas.has(deltaKey))
            throw new Error(message);
    }
    /** Store a value under `key`. Overwrites any existing value. */
    put(key, value) {
        this.assertLive();
        const admitted = this.admitValue(key, value);
        this.replaceValue(key, admitted.value, admitted.bytes);
        // An untracked script/replay write is a new stable baseline. Existing
        // transaction nodes become unreachable and can no longer roll it back.
        this.keyVersionHeads.delete(key);
    }
    /**
     * Store a value and record the write in the per-agent delta for `deltaKey`
     * (a run-unique `${runId}:${callIndex}` string — see class doc). Used by
     * per-agent tools created via `createAgentStoreTools` so that each agent's
     * writes can be journaled and replayed independently.
     */
    trackPut(key, value, deltaKey) {
        this.assertDeltaLive(deltaKey, "store write belongs to a completed agent attempt");
        const admitted = this.admitValue(key, value);
        const head = this.keyVersionHeads.get(key);
        let nextHead;
        if (head?.deltaKey === deltaKey && head.state === "active") {
            // No sibling write intervened, so the predecessor is unchanged and this
            // attempt's repeated write can update its existing node in place.
            head.value = admitted.value;
            head.bytes = admitted.bytes;
            nextHead = head;
        }
        else {
            nextHead = {
                kind: "write",
                deltaKey,
                state: "active",
                value: admitted.value,
                bytes: admitted.bytes,
                previous: head ??
                    {
                        kind: "baseline",
                        existed: this.map.has(key),
                        value: this.map.get(key),
                        bytes: this.valueBytes.get(key) ?? 0,
                    },
            };
            this.keyVersionHeads.set(key, nextHead);
            const versions = this.deltaVersions.get(deltaKey) ?? [];
            versions.push(nextHead);
            this.deltaVersions.set(deltaKey, versions);
        }
        this.replaceValue(key, admitted.value, admitted.bytes);
        let delta = this.agentDeltas.get(deltaKey);
        if (!delta) {
            delta = Object.create(null);
            this.agentDeltas.set(deltaKey, delta);
        }
        delta[key] = admitted.value;
    }
    /** Retrieve an owned copy of `key`, or `undefined` when absent. */
    get(key) {
        this.assertLive();
        const value = this.map.get(key);
        return value === undefined ? undefined : structuredClone(value);
    }
    /** Whether `key` is present in the store. */
    has(key) {
        this.assertLive();
        return this.map.has(key);
    }
    /** Return a deep-copied plain-object snapshot of all entries. */
    snapshot() {
        this.assertLive();
        return structuredClone(Object.fromEntries(this.map));
    }
    /**
     * Extract and clear the write delta accumulated for `deltaKey`.
     * Called after an agent completes to get the set of keys it wrote.
     */
    commitDelta(deltaKey) {
        this.assertLive();
        if (this.retiredDeltas.has(deltaKey))
            throw new Error("agent attempt delta is already completed");
        const delta = this.agentDeltas.get(deltaKey) ?? Object.create(null);
        this.retiredDeltas.add(deltaKey);
        const versions = this.deltaVersions.get(deltaKey) ?? [];
        for (const version of versions)
            version.state = "committed";
        for (const key of new Set(Object.keys(delta)))
            this.resolveVersionHead(key);
        this.agentDeltas.delete(deltaKey);
        this.deltaVersions.delete(deltaKey);
        // Return a normal plain object for API/test compatibility while retaining
        // null-prototype storage internally against prototype-sensitive writes.
        return structuredClone(Object.fromEntries(Object.entries(delta)));
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
     * Per-key guard: discarded version nodes are skipped from the current chain.
     * A later sibling head remains visible; if that sibling also fails, resolving
     * its predecessor skips every already-discarded node until it reaches a live
     * sibling, a committed value, or the original baseline.
     *
     * A no-op if `deltaKey` never wrote anything (nothing to roll back).
     */
    discardDelta(deltaKey) {
        if (this.disposed || this.retiredDeltas.has(deltaKey))
            return;
        this.retiredDeltas.add(deltaKey);
        const delta = this.agentDeltas.get(deltaKey);
        const versions = this.deltaVersions.get(deltaKey) ?? [];
        for (const version of versions)
            version.state = "discarded";
        for (const key of new Set(Object.keys(delta ?? {})))
            this.resolveVersionHead(key);
        this.agentDeltas.delete(deltaKey);
        this.deltaVersions.delete(deltaKey);
    }
    /**
     * Apply a write delta additively — sets each key without clearing others.
     * Used during resume replay so parallel-agent deltas applied in callSeq
     * order accumulate correctly regardless of original completion order.
     * Replay deltas arrive as JSON-parsed plain objects, where `__proto__` is an
     * ordinary own data property; iterating with Object.keys and Map#set keeps
     * prototype-sensitive keys safe (no prototype pollution).
     */
    applyDelta(delta) {
        this.assertLive();
        for (const [k, v] of Object.entries(delta)) {
            const admitted = this.admitValue(k, v);
            this.replaceValue(k, admitted.value, admitted.bytes);
            this.keyVersionHeads.delete(k);
        }
    }
    /**
     * Replace all entries with a snapshot (for full resets).
     * Prefer `applyDelta` for resume replay — see journal integration above.
     */
    restore(snap) {
        this.assertLive();
        // A full restore invalidates every in-progress delta window. Retire the
        // keys before clearing their bookkeeping so late tool callbacks cannot
        // reopen an old window and mutate the newly restored snapshot.
        for (const deltaKey of this.agentDeltas.keys())
            this.retiredDeltas.add(deltaKey);
        for (const deltaKey of this.deltaVersions.keys())
            this.retiredDeltas.add(deltaKey);
        this.map.clear();
        this.valueBytes.clear();
        this.totalBytes = 0;
        this.agentDeltas.clear();
        this.deltaVersions.clear();
        this.keyVersionHeads.clear();
        for (const [k, v] of Object.entries(snap)) {
            const admitted = this.admitValue(k, v);
            this.replaceValue(k, admitted.value, admitted.bytes);
        }
    }
    /** Clear all entries (called when the run ends). */
    dispose() {
        this.disposed = true;
        this.map.clear();
        this.valueBytes.clear();
        this.totalBytes = 0;
        this.agentDeltas.clear();
        this.deltaVersions.clear();
        this.keyVersionHeads.clear();
        this.retiredDeltas.clear();
    }
    admitValue(key, value) {
        if (typeof key !== "string" || Buffer.byteLength(key, "utf8") > this.limits.maxKeyBytes) {
            throw new Error(`SharedStore key exceeds its ${this.limits.maxKeyBytes}-byte limit`);
        }
        if (!this.map.has(key) && this.map.size >= this.limits.maxKeys) {
            throw new Error(`SharedStore reached its ${this.limits.maxKeys}-key limit`);
        }
        let json;
        try {
            // Descriptor-only, finite validation: never invoke getters, toJSON, or a
            // custom conversion hook, and fail before materializing an oversized value.
            json = serializeIdentity(value, {
                maxBytes: this.limits.maxValueBytes,
                maxItems: 100_000,
                maxNodes: 100_000,
                maxDepth: 128,
                maxStringBytes: this.limits.maxValueBytes,
            });
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : "";
            if (/overflow|limit exceeded/i.test(reason)) {
                throw new Error(`SharedStore value exceeds its ${this.limits.maxValueBytes}-byte limit`);
            }
            throw new Error("SharedStore values must be JSON-serializable finite plain data without accessors or cycles");
        }
        const bytes = Buffer.byteLength(json, "utf8");
        const nextTotal = this.totalBytes - (this.valueBytes.get(key) ?? 0) + bytes;
        if (nextTotal > this.limits.maxTotalBytes) {
            throw new Error(`SharedStore exceeds its ${this.limits.maxTotalBytes}-byte limit`);
        }
        // Store an owned immutable-by-reference JSON clone so caller mutation cannot
        // invalidate aggregate byte accounting or introduce a later getter/toJSON.
        return { bytes, value: JSON.parse(json) };
    }
    replaceValue(key, value, bytes) {
        this.totalBytes += bytes - (this.valueBytes.get(key) ?? 0);
        this.valueBytes.set(key, bytes);
        this.map.set(key, value);
    }
    removeValue(key) {
        this.totalBytes -= this.valueBytes.get(key) ?? 0;
        this.valueBytes.delete(key);
        this.map.delete(key);
    }
    /** Recompute one visible key after a delta commits or is discarded. */
    resolveVersionHead(key) {
        const originalHead = this.keyVersionHeads.get(key);
        if (!originalHead)
            return;
        let resolved = originalHead;
        while (resolved.kind === "write" && resolved.state === "discarded")
            resolved = resolved.previous;
        if (resolved.kind === "write" && resolved.state === "active") {
            if (resolved !== originalHead) {
                this.replaceValue(key, resolved.value, resolved.bytes);
                this.keyVersionHeads.set(key, resolved);
            }
            return;
        }
        // A committed visible version is the new durable baseline; predecessors
        // can never become visible again. Baselines use their captured byte count
        // so rollback itself cannot fail admission and leak the failed head.
        if (resolved.kind === "write")
            this.replaceValue(key, resolved.value, resolved.bytes);
        else if (resolved.existed)
            this.replaceValue(key, resolved.value, resolved.bytes);
        else
            this.removeValue(key);
        this.keyVersionHeads.delete(key);
    }
}
function positiveLimit(value, fallback) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
/**
 * Create per-agent store tools that attribute writes to `deltaKey`, a
 * run/attempt-unique string (see the `SharedStore` class doc for why a bare
 * callIndex or a reused retry key is unsafe once nested workflows/retries share
 * this store).
 * Used internally by `runWorkflow` so each agent's puts are tracked in the
 * store's delta journal and can be replayed additively on resume.
 */
export function createAgentStoreTools(store, deltaKey, isAdmitted) {
    const assertAdmitted = () => {
        if (isAdmitted && !isAdmitted())
            throw new Error("workflow attempt is no longer admitted");
    };
    const storePut = defineTool({
        name: "store_put",
        label: "Store Put",
        description: "Write a JSON value by key.",
        parameters: Type.Object({
            key: Type.String({ description: "Store key." }),
            value: Type.Any({ description: "JSON value." }),
        }),
        async execute(_id, params) {
            assertAdmitted();
            store.trackPut(params.key, params.value, deltaKey);
            return {
                content: [{ type: "text", text: `Stored value under key "${params.key}".` }],
                details: { key: params.key },
            };
        },
    });
    const storeGet = defineTool({
        name: "store_get",
        label: "Store Get",
        description: "Read a JSON value by key; null if absent.",
        parameters: Type.Object({
            key: Type.String({ description: "Store key." }),
        }),
        async execute(_id, params) {
            assertAdmitted();
            // Reads are fenced too: a timed-out attempt must not observe a retry's
            // state and continue acting on it after its own delta window retired.
            store.assertDeltaLive(deltaKey);
            const found = store.has(params.key);
            const value = store.get(params.key);
            const text = found
                ? `Value for key "${params.key}": ${serializeBounded(value, { maxBytes: 8_000, pretty: false })}`
                : `Key "${params.key}" not found in store.`;
            return {
                content: [{ type: "text", text }],
                details: { key: params.key, value: found ? value : null, found },
            };
        },
    });
    return [storePut, storeGet];
}
