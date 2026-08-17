/**
 * Auto-resume for runs paused on a provider usage limit.
 *
 * A workflow run pauses (does not fail) when a provider quota/usage limit is hit
 * (see errors.ts PROVIDER_USAGE_LIMIT, workflow-manager.ts executeRun()'s catch
 * block). Left alone, the run just sits there until a human runs /workflows and
 * hits resume. This module watches the manager's public event stream and, for
 * runs that are auto-resume-eligible, arms a timer to call manager.resume() once
 * the provider's quota is likely to have refilled — with exponential backoff if
 * it keeps hitting the wall, and a hard attempt cap so it never retries forever.
 *
 * Deliberately standalone: it consumes ONLY WorkflowManager's public surface
 * (on/off, listAllRuns, resume, getPersistence) so it stays decoupled from
 * manager/persistence internals. It owns its own timers and its own bookkeeping
 * (in-memory, best-effort persisted) — it does not rely on manager.stop(), which
 * only operates on in-memory runs.
 */
import { assertSafeRunId } from "./run-persistence.js";
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MIN_DELAY_MS = 60_000;
const DEFAULT_FALLBACK_DELAY_MS = 300_000;
const DEFAULT_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
function validateSchedulerOption(name, value, minimum, integer = false) {
    if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
        const kind = integer ? "finite integer" : "finite number";
        throw new RangeError(`${name} must be a ${kind} greater than or equal to ${minimum}`);
    }
    return value;
}
/**
 * Best-effort parse of a provider's human reset hint ("Resets in ~3h",
 * "resets in 5m", "in 90s", "1h30m") into milliseconds. Sums every
 * (number, unit) pair found, so combined forms like "1h30m" work for free.
 * Returns undefined when nothing recognizable is found — callers should fall
 * back to a fixed delay rather than guess.
 */
export function parseResetHintMs(hint) {
    if (!hint)
        return undefined;
    // No trailing \b: combined forms like "1h30m" have a digit right after the
    // unit letter, which is itself a word character, so \b would never match
    // there. A negative lookahead for another letter is the correct boundary —
    // it still stops "hours" from partially matching as bare "h" mid-word while
    // allowing a unit to be followed immediately by the next (digit, unit) pair.
    const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
    let match;
    let totalMs = 0;
    let found = false;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec loop
    while ((match = re.exec(hint)) !== null) {
        const value = Number.parseFloat(match[1]);
        if (!Number.isFinite(value))
            continue;
        const unit = match[2].toLowerCase();
        found = true;
        if (unit.startsWith("h"))
            totalMs += value * 3_600_000;
        else if (unit.startsWith("m"))
            totalMs += value * 60_000;
        else if (unit.startsWith("s"))
            totalMs += value * 1_000;
    }
    return found ? totalMs : undefined;
}
/**
 * delay = clamp(minDelayMs, remaining * 2^(attempts-1), maxDelayMs), where
 * remaining = parsed(resetHint) ?? fallbackDelayMs, minus time already elapsed.
 * The exponent is capped defensively so a pathological attempt count can't
 * overflow the multiplication to Infinity/NaN before the maxDelayMs clamp runs.
 */
export function computeAutoResumeDelayMs(params) {
    const base = parseResetHintMs(params.resetHint) ?? params.fallbackDelayMs;
    const remaining = base - params.elapsedMs;
    const exponent = Math.min(Math.max(params.attempts - 1, 0), 30);
    const backoff = remaining * 2 ** exponent;
    return Math.min(params.maxDelayMs, Math.max(params.minDelayMs, backoff));
}
/**
 * Watches a WorkflowManager for usage-limit pauses and auto-resumes eligible
 * runs once the provider's quota is likely to have refilled.
 *
 * Event-driven "fire and watch": an attempt is consumed when a run ENTERS a
 * usage_limit pause (live via the "paused" event, or once at cold start for a
 * run that was already paused), never when a resume is merely fired. When an
 * armed timer fires, resume() is called; if it returns false (lease busy, run
 * already gone, etc.) no attempt is consumed and a short un-backed-off retry is
 * armed instead, unless the run has reached a terminal state on disk. If resume()
 * returns true, this scheduler steps back — the existing "paused" subscription
 * re-arms with backoff if the run hits the wall again, and "complete"/"error"/
 * "stopped" clean up its timer.
 */
export class UsageLimitScheduler {
    manager;
    now;
    setTimer;
    clearTimer;
    maxAttempts;
    minDelayMs;
    fallbackDelayMs;
    maxDelayMs;
    maxArmedTimers;
    diagnostic;
    boundSessionId;
    sessionBound = false;
    state = new Map();
    disposed = false;
    /** Resolves on dispose so an in-flight resume wait can stop retaining this scheduler. */
    shutdownPromise;
    resolveShutdown;
    /**
     * Runs this scheduler is currently auto-resuming (its own timer fired). Used to
     * tell an auto-resume's "resumed" event apart from a manual one: an auto-resume
     * must keep the backoff counter (it IS the backoff), a manual resume resets it.
     */
    autoResumingRunIds = new Set();
    onPaused = (event) => {
        this.safe(() => this.handlePaused(event));
    };
    onTerminal = (event) => {
        this.safe(() => this.cleanup(event?.runId));
    };
    onResumed = (event) => {
        this.safe(() => this.handleResumed(event));
    };
    constructor(manager, options = {}) {
        this.manager = manager;
        this.now = options.now ?? Date.now;
        this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
        this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
        const maxAttempts = validateSchedulerOption("maxAttempts", options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, 1, true);
        const minDelayMs = validateSchedulerOption("minDelayMs", options.minDelayMs ?? DEFAULT_MIN_DELAY_MS, 0);
        const fallbackDelayMs = validateSchedulerOption("fallbackDelayMs", options.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS, 0);
        const maxDelayMs = validateSchedulerOption("maxDelayMs", options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, 0);
        const maxArmedTimers = validateSchedulerOption("maxArmedTimers", options.maxArmedTimers ?? 64, 1, true);
        if (maxDelayMs < minDelayMs) {
            throw new RangeError("maxDelayMs must be greater than or equal to minDelayMs");
        }
        this.maxArmedTimers = maxArmedTimers;
        this.maxAttempts = maxAttempts;
        this.minDelayMs = minDelayMs;
        this.fallbackDelayMs = fallbackDelayMs;
        this.maxDelayMs = maxDelayMs;
        this.boundSessionId = options.sessionId;
        this.diagnostic =
            options.onDiagnostic ??
                ((message, detail) => {
                    console.warn(message, detail ?? "");
                });
        let resolveShutdown;
        this.shutdownPromise = new Promise((resolve) => {
            resolveShutdown = resolve;
        });
        this.resolveShutdown = resolveShutdown;
        if (options.sessionId !== undefined) {
            this.sessionBound = true;
            this.safe(() => this.coldStartRearm());
        }
        this.manager.on("paused", this.onPaused);
        this.manager.on("resumed", this.onResumed);
        this.manager.on("complete", this.onTerminal);
        this.manager.on("error", this.onTerminal);
        this.manager.on("stopped", this.onTerminal);
        this.manager.on("deleted", this.onTerminal);
    }
    /**
     * Bind recovery to the host session after session_start has supplied the
     * authoritative session id. This is intentionally separate from construction:
     * extension factories run before Pi has selected/resumed the target session.
     */
    bindSession(sessionId) {
        if (this.disposed || this.sessionBound)
            return;
        this.boundSessionId = sessionId;
        this.sessionBound = true;
        this.safe(() => this.coldStartRearm());
    }
    /** Clear every armed timer and unsubscribe from the manager. Idempotent. */
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.resolveShutdown();
        this.manager.off("paused", this.onPaused);
        this.manager.off("resumed", this.onResumed);
        this.manager.off("complete", this.onTerminal);
        this.manager.off("error", this.onTerminal);
        this.manager.off("stopped", this.onTerminal);
        this.manager.off("deleted", this.onTerminal);
        for (const entry of this.state.values()) {
            if (entry.timer !== undefined)
                this.clearTimer(entry.timer);
        }
        this.state.clear();
        this.autoResumingRunIds.clear();
    }
    /** Test/diagnostic helper: in-memory attempt count tracked for a run, if any. */
    getAttemptCount(runId) {
        assertSafeRunId(runId);
        return this.state.get(runId)?.attempts;
    }
    /** Test/diagnostic helper: whether a resume timer is currently armed for a run. */
    hasArmedTimer(runId) {
        assertSafeRunId(runId);
        return this.state.get(runId)?.timer !== undefined;
    }
    // ---- event handlers -----------------------------------------------------
    handlePaused(event) {
        if (this.disposed || !event?.runId || event.reason !== "usage_limit")
            return;
        assertSafeRunId(event.runId);
        const runId = event.runId;
        // The "paused" event fires BEFORE the manager's own persistRun() write for
        // this pause (see executeRun()'s catch block: emit then persist). A disk
        // read here can therefore be stale for fields this exact pause is about to
        // set (status/pauseReason/resetHint) — but NOT for `autoResume`, which is
        // fixed at run-start and persisted on every persistRun() call since, so a
        // stale read of it is still correct. resetHint comes off the event itself,
        // not disk, to avoid that race.
        const persisted = this.safeLoad(runId);
        if (!this.ownsBoundSession(persisted))
            return;
        if (persisted?.autoResume === false) {
            this.diagnostic(`[usage-limit-scheduler] ${runId}: autoResume is disabled for this run, not arming`);
            return;
        }
        const priorAttempts = this.state.get(runId)?.attempts ?? persisted?.autoResumeAttempts ?? 0;
        this.arm(runId, {
            attempts: priorAttempts + 1,
            resetHint: event.resetHint ?? persisted?.resetHint,
            elapsedMs: 0,
        });
    }
    cleanup(runId) {
        if (!runId)
            return;
        assertSafeRunId(runId);
        const entry = this.state.get(runId);
        if (entry?.timer !== undefined)
            this.clearTimer(entry.timer);
        this.state.delete(runId);
    }
    /**
     * A run was resumed. If WE resumed it (auto-resume timer fired), leave the
     * backoff counter alone — that's the sequence doing its job, and it must still
     * be able to reach the cap. If a human resumed it (via /workflows), treat that
     * as a deliberate fresh start: drop the in-memory given-up state and reset the
     * persisted counter so a later pause re-enters the normal backoff from attempt 1
     * instead of staying silently given-up forever.
     */
    handleResumed(event) {
        if (this.disposed || !event?.runId)
            return;
        assertSafeRunId(event.runId);
        if (this.autoResumingRunIds.has(event.runId))
            return;
        this.cleanup(event.runId);
        this.persistAttempts(event.runId, 0);
    }
    coldStartRearm() {
        if (!this.sessionBound)
            return;
        const runs = this.manager.listAllRuns();
        for (const run of runs) {
            if (!this.ownsBoundSession(run))
                continue;
            if (run.status !== "paused" || run.pauseReason !== "usage_limit")
                continue;
            if (run.autoResume === false)
                continue;
            if (this.state.has(run.runId))
                continue;
            const priorAttempts = run.autoResumeAttempts ?? 0;
            const updatedAtMs = Date.parse(run.updatedAt);
            const elapsedMs = Number.isFinite(updatedAtMs) ? Math.max(0, this.now() - updatedAtMs) : 0;
            this.arm(run.runId, {
                attempts: priorAttempts + 1,
                resetHint: run.resetHint,
                elapsedMs,
            });
        }
    }
    ownsBoundSession(run) {
        if (!this.sessionBound || !run)
            return false;
        return run.sessionId === this.boundSessionId;
    }
    // ---- arming / firing ------------------------------------------------------
    arm(runId, params) {
        assertSafeRunId(runId);
        const existing = this.state.get(runId);
        if (existing?.timer !== undefined)
            this.clearTimer(existing.timer);
        if (params.attempts > this.maxAttempts) {
            const alreadyLogged = existing?.gaveUp === true;
            // Freeze the counter at a single sentinel (maxAttempts + 1) instead of
            // storing the raw overflow. coldStartRearm() reads the persisted count and
            // adds 1 on every restart; without this clamp a given-up run's counter
            // grew without bound (…6, 7, 8… → "giving up after 23") across cold starts
            // (#106). Clamping makes the persisted value idempotent — a rearm of an
            // already-given-up run rewrites the same 6.
            const frozen = this.maxAttempts + 1;
            this.state.set(runId, { attempts: frozen, gaveUp: true });
            this.persistAttempts(runId, frozen);
            // Log the give-up exactly once per crossing. In-process the gaveUp flag
            // guards it; across restarts a fresh scheduler has no memory, so also
            // suppress when this arm is merely re-giving-up an already-capped run
            // (params.attempts already past the sentinel, i.e. prior was ≥ frozen).
            if (!alreadyLogged && params.attempts <= frozen) {
                this.diagnostic(`[usage-limit-scheduler] ${runId}: giving up after ${this.maxAttempts} auto-resume attempt(s) ` +
                    `(max ${this.maxAttempts}); leaving paused for manual resume`);
            }
            return;
        }
        if (!existing && this.state.size >= this.maxArmedTimers) {
            this.diagnostic(`[usage-limit-scheduler] timer capacity (${this.maxArmedTimers}) reached; leaving ${runId} paused`);
            return;
        }
        const delay = computeAutoResumeDelayMs({
            resetHint: params.resetHint,
            attempts: params.attempts,
            elapsedMs: params.elapsedMs,
            minDelayMs: this.minDelayMs,
            fallbackDelayMs: this.fallbackDelayMs,
            maxDelayMs: this.maxDelayMs,
        });
        const timer = this.setTimer(() => this.safe(() => this.onTimerFire(runId)), delay);
        timer.unref?.();
        this.state.set(runId, { attempts: params.attempts, timer });
        this.persistAttempts(runId, params.attempts);
    }
    async onTimerFire(runId) {
        assertSafeRunId(runId);
        if (this.disposed)
            return;
        const entry = this.state.get(runId);
        if (!entry || entry.gaveUp)
            return;
        // The timer that just fired is spent; clear its handle while we await.
        this.state.set(runId, { ...entry, timer: undefined });
        let resumed = false;
        // Mark this as OUR resume so handleResumed() (fired synchronously inside
        // resume(), before it returns) doesn't mistake it for a manual resume and
        // reset the backoff counter mid-sequence.
        this.autoResumingRunIds.add(runId);
        try {
            // Capture only the manager-facing dependencies in the pending promise.
            // A manager.resume() may wait forever for an older generation to unwind;
            // that wait must retain the manager/resources it belongs to, but it must
            // not retain this scheduler after dispose() has released its listeners,
            // timers, and bookkeeping.
            const manager = this.manager;
            const diagnostic = this.diagnostic;
            const resumeAttempt = Promise.resolve()
                .then(() => manager.resume(runId))
                .then((value) => ({ kind: "resume", value }), (error) => {
                diagnostic(`[usage-limit-scheduler] ${runId}: resume() threw`, error);
                return { kind: "resume-error" };
            });
            const outcome = await Promise.race([
                resumeAttempt,
                this.shutdownPromise.then(() => ({ kind: "shutdown" })),
            ]);
            if (outcome.kind === "shutdown")
                return;
            resumed = outcome.kind === "resume" && outcome.value;
        }
        finally {
            this.autoResumingRunIds.delete(runId);
        }
        if (this.disposed)
            return;
        if (resumed) {
            // Don't consume/advance anything further here — the existing "paused"
            // subscription re-arms (with backoff) if this run hits the wall again,
            // and "complete"/"error"/"stopped" clean up on any terminal outcome.
            return;
        }
        // resume() returned false without throwing: it refused for a structural
        // reason (already running/aborted, no persisted script, or the lease is
        // held elsewhere) rather than a real failed attempt. Per the fix for bug
        // (a), that must NOT consume an attempt. Distinguish "gone for good" from
        // "try again shortly":
        const status = this.safeStatus(runId);
        if (status === undefined || status === "completed" || status === "aborted") {
            this.cleanup(runId);
            return;
        }
        const current = this.state.get(runId) ?? entry;
        const timer = this.setTimer(() => this.safe(() => this.onTimerFire(runId)), this.minDelayMs);
        this.state.set(runId, { attempts: current.attempts, timer });
    }
    // ---- helpers --------------------------------------------------------------
    safeLoad(runId) {
        assertSafeRunId(runId);
        try {
            return this.manager.getPersistence().load(runId) ?? undefined;
        }
        catch (err) {
            this.diagnostic(`[usage-limit-scheduler] ${runId}: persistence load failed`, err);
            return undefined;
        }
    }
    safeStatus(runId) {
        assertSafeRunId(runId);
        try {
            return this.manager.listAllRuns().find((r) => r.runId === runId)?.status;
        }
        catch (err) {
            this.diagnostic(`[usage-limit-scheduler] ${runId}: listAllRuns() failed`, err);
            return undefined;
        }
    }
    /**
     * Best-effort persist of the in-memory attempt counter, so a cold start after
     * a crash can approximately resume the backoff sequence instead of restarting
     * it. Deferred to a microtask so it lands AFTER the manager's own persistRun()
     * write for this same pause (which happens synchronously, right after the
     * "paused" event we're reacting to returns control to executeRun()) — writing
     * synchronously here would just get clobbered, since persistRun() writes a
     * fresh PersistedRunState object literal that doesn't know about this field.
     * This is still inherently racy across process crashes (see class docs); it
     * is a best-effort durability aid, not a correctness requirement for the live
     * (in-memory) path.
     */
    persistAttempts(runId, attempts) {
        assertSafeRunId(runId);
        queueMicrotask(() => {
            if (this.disposed)
                return;
            try {
                const persistence = this.manager.getPersistence();
                // Serialize this side-channel update with the same lease as lifecycle
                // writers, then re-read and CAS the exact revision we observed. This
                // prevents a delayed scheduler microtask from clobbering a newer pause,
                // resume, stop, journal, or terminal transition.
                const lease = persistence.acquireRunLease(runId);
                if (!lease)
                    return;
                try {
                    const current = persistence.load(runId);
                    if (current?.status !== "paused")
                        return;
                    const next = { ...current, autoResumeAttempts: attempts };
                    persistence.save(next, current.revision, lease);
                    this.manager.syncPersistedRevision(runId, next.revision);
                }
                finally {
                    persistence.releaseRunLease(lease);
                }
            }
            catch (err) {
                this.diagnostic(`[usage-limit-scheduler] ${runId}: failed to persist autoResumeAttempts`, err);
            }
        });
    }
    safe(fn) {
        try {
            const result = fn();
            if (result && typeof result.catch === "function") {
                result.catch((err) => {
                    this.diagnostic("[usage-limit-scheduler] async handler error", err);
                });
            }
        }
        catch (err) {
            this.diagnostic("[usage-limit-scheduler] handler error", err);
        }
    }
}
