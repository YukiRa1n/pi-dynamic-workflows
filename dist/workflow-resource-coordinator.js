/** Bounded process-local resource coordination shared by workflow executions. */
const positive = (value, fallback) => Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
/**
 * Execution admission and provider-attempt accounting. Provider permits are
 * deliberately released only by the release closure, which callers invoke in
 * the provider promise's finally (not when a logical timeout fires).
 */
export class WorkflowResourceCoordinator {
    maxActiveExecutions;
    maxProviderConcurrency;
    maxQueuedProviderAttempts;
    maxLateAttempts;
    executions = new Map();
    activeProviders = new Set();
    waiters = [];
    late = new Map();
    sequence = 0;
    constructor(options = {}) {
        this.maxActiveExecutions = positive(options.maxActiveExecutions, 32);
        this.maxProviderConcurrency = positive(options.maxProviderConcurrency, 16);
        this.maxQueuedProviderAttempts = positive(options.maxQueuedProviderAttempts, this.maxProviderConcurrency * 4);
        this.maxLateAttempts = positive(options.maxLateAttempts, this.maxProviderConcurrency * 4);
    }
    executionKey(runId, namespace = "default", generation = runId) {
        return `${namespace}\u0000${runId}\u0000${generation}`;
    }
    /** Acquire a generation-fenced capability. Callers must retain this exact
     * token; the key is intentionally not reconstructible as a release API. */
    acquireExecution(runId, namespace = "default", generation = runId) {
        const key = this.executionKey(runId, namespace, generation);
        if (this.executions.has(key) || this.executions.size >= this.maxActiveExecutions)
            return null;
        const reservation = Object.freeze({
            runId,
            namespace,
            generation,
            token: `${key}:${++this.sequence}`,
        });
        this.executions.set(key, reservation);
        return reservation;
    }
    /** Backwards-compatible, non-mutating eligibility probe. Actual admission
     * must use acquireExecution() and retain its opaque reservation. */
    tryAcquireExecution(runId, namespace = "default", generation = runId) {
        const key = this.executionKey(runId, namespace, generation);
        return !this.executions.has(key) && this.executions.size < this.maxActiveExecutions;
    }
    releaseExecution(reservationOrRunId, namespace = "default", generation) {
        if (typeof reservationOrRunId === "string") {
            this.executions.delete(this.executionKey(reservationOrRunId, namespace, generation ?? reservationOrRunId));
            return;
        }
        const key = this.executionKey(reservationOrRunId.runId, reservationOrRunId.namespace, reservationOrRunId.generation);
        if (this.executions.get(key) === reservationOrRunId)
            this.executions.delete(key);
    }
    /** Number of provider waiters, useful for deterministic admission tests. */
    get queuedProviderAttempts() {
        return this.waiters.length;
    }
    /** Return null if this waiter was cancelled or the bounded queue is full. */
    acquireProvider(runId, signal, namespace = "default", generation = runId) {
        const key = this.executionKey(runId, namespace, generation);
        if (signal?.aborted)
            return Promise.resolve(null);
        if (this.activeProviders.size < this.maxProviderConcurrency) {
            return Promise.resolve(this.grant(key, runId));
        }
        if (this.waiters.length >= this.maxQueuedProviderAttempts)
            return Promise.resolve(null);
        return new Promise((resolve) => {
            const waiter = { key, runId, signal, resolve };
            const abort = () => {
                const index = this.waiters.indexOf(waiter);
                if (index >= 0)
                    this.waiters.splice(index, 1);
                resolve(null);
            };
            waiter.onAbort = abort;
            signal?.addEventListener("abort", abort, { once: true });
            this.waiters.push(waiter);
        });
    }
    grant(key, _runId) {
        const token = `${key}:${++this.sequence}`;
        this.activeProviders.add(token);
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            this.activeProviders.delete(token);
            this.pump();
        };
    }
    pump() {
        while (this.activeProviders.size < this.maxProviderConcurrency && this.waiters.length) {
            const waiter = this.waiters.shift();
            if (!waiter)
                break;
            if (waiter.signal?.aborted) {
                waiter.resolve(null);
                continue;
            }
            if (waiter.onAbort)
                waiter.signal?.removeEventListener("abort", waiter.onAbort);
            waiter.resolve(this.grant(waiter.key, waiter.runId));
        }
    }
    registerLateAttempt(metadata) {
        if (this.late.size >= this.maxLateAttempts && !this.late.has(metadata.attemptId))
            return null;
        const record = {
            ...metadata,
            startedAt: metadata.startedAt ?? Date.now(),
            usageState: metadata.usageState ?? "unknown",
        };
        this.late.set(record.attemptId, record);
        return {
            update: (patch) => {
                const current = this.late.get(record.attemptId);
                if (current === record)
                    Object.assign(current, patch);
            },
            settle: () => {
                // A late attempt ID can only be retired by the exact registration that
                // created it. A stale provider promise must never settle a newer
                // execution's record that happens to reuse the same string key.
                if (this.late.get(record.attemptId) === record)
                    this.late.delete(record.attemptId);
            },
        };
    }
    markLate(attemptId) {
        const record = this.late.get(attemptId);
        if (record && !record.lateAt)
            record.lateAt = Date.now();
    }
    markLateScope(scope) {
        const now = Date.now();
        for (const record of this.late.values()) {
            const matchesRun = scope.runId === undefined || record.runId === scope.runId;
            const matchesExecution = scope.executionGeneration === undefined || record.executionGeneration === scope.executionGeneration;
            const matchesResource = scope.resourceGeneration === undefined || record.resourceGeneration === scope.resourceGeneration;
            if (matchesRun && matchesExecution && matchesResource && !record.lateAt) {
                record.lateAt = now;
            }
        }
    }
    getLateAttempts() {
        return [...this.late.values()].map((entry) => ({ ...entry }));
    }
    snapshot(extra = {}) {
        return {
            activeExecutions: this.executions.size,
            maxActiveExecutions: this.maxActiveExecutions,
            queuedProviderAttempts: this.waiters.length,
            providerAttempts: this.activeProviders.size,
            lateProviderAttempts: [...this.late.values()].filter((entry) => entry.lateAt !== undefined).length,
            activeAgentSenders: 0,
            pendingMessageRuns: 0,
            pendingMessageCount: 0,
            pendingMessageBytes: 0,
            retainedPausedRuns: 0,
            persistenceBlockedRuns: 0,
            lateAttempts: this.getLateAttempts(),
            ...extra,
        };
    }
}
/** Default process-wide budget used by managers created during extension reload. */
export const defaultWorkflowResourceCoordinator = new WorkflowResourceCoordinator();
