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
import { type PersistedRunState, type RunPersistence } from "./run-persistence.js";
/** Narrow surface this scheduler depends on — satisfied by WorkflowManager. */
export interface SchedulableWorkflowManager {
    on(event: string, listener: (...args: any[]) => void): unknown;
    off(event: string, listener: (...args: any[]) => void): unknown;
    listAllRuns(): PersistedRunState[];
    resume(runId: string): Promise<boolean>;
    getPersistence(): RunPersistence;
    syncPersistedRevision(runId: string, revision: number | undefined): void;
}
/** Opaque timer handle so tests can inject a fake clock/timer. */
export type TimerHandle = unknown;
export interface UsageLimitSchedulerOptions {
    /** Current Pi session. Cold-start recovery is deferred until bindSession(). */
    sessionId?: string;
    /** Injectable clock (default Date.now). */
    now?: () => number;
    /** Injectable timer scheduler (default setTimeout). */
    setTimer?: (fn: () => void, ms: number) => TimerHandle;
    /** Injectable timer canceller (default clearTimeout). */
    clearTimer?: (handle: TimerHandle) => void;
    /** Max auto-resume attempts per pause-cycle before giving up. Default 5. */
    maxAttempts?: number;
    /** Delay floor — never arm sooner than this. Default 60_000 (1m). */
    minDelayMs?: number;
    /** Delay used when the provider's resetHint can't be parsed. Default 300_000 (5m). */
    fallbackDelayMs?: number;
    /** Delay ceiling — backoff is clamped here. Default 6h. */
    maxDelayMs?: number;
    /** Maximum simultaneously armed auto-resume timers. */
    maxArmedTimers?: number;
    /** Diagnostics sink; defaults to console.warn. Never throws back into the caller. */
    onDiagnostic?: (message: string, detail?: unknown) => void;
}
/**
 * Best-effort parse of a provider's human reset hint ("Resets in ~3h",
 * "resets in 5m", "in 90s", "1h30m") into milliseconds. Sums every
 * (number, unit) pair found, so combined forms like "1h30m" work for free.
 * Returns undefined when nothing recognizable is found — callers should fall
 * back to a fixed delay rather than guess.
 */
export declare function parseResetHintMs(hint?: string): number | undefined;
export interface AutoResumeDelayParams {
    /** The provider's verbatim reset hint for this pause, if any. */
    resetHint?: string;
    /** 1-indexed attempt number for the pause currently being armed. */
    attempts: number;
    /** Milliseconds already elapsed since the pause began (0 for a live pause). */
    elapsedMs: number;
    minDelayMs: number;
    fallbackDelayMs: number;
    maxDelayMs: number;
}
/**
 * delay = clamp(minDelayMs, remaining * 2^(attempts-1), maxDelayMs), where
 * remaining = parsed(resetHint) ?? fallbackDelayMs, minus time already elapsed.
 * The exponent is capped defensively so a pathological attempt count can't
 * overflow the multiplication to Infinity/NaN before the maxDelayMs clamp runs.
 */
export declare function computeAutoResumeDelayMs(params: AutoResumeDelayParams): number;
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
export declare class UsageLimitScheduler {
    private readonly manager;
    private readonly now;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly maxAttempts;
    private readonly minDelayMs;
    private readonly fallbackDelayMs;
    private readonly maxDelayMs;
    private readonly maxArmedTimers;
    private readonly diagnostic;
    private boundSessionId;
    private sessionBound;
    private readonly state;
    private disposed;
    /** Resolves on dispose so an in-flight resume wait can stop retaining this scheduler. */
    private readonly shutdownPromise;
    private readonly resolveShutdown;
    /**
     * Runs this scheduler is currently auto-resuming (its own timer fired). Used to
     * tell an auto-resume's "resumed" event apart from a manual one: an auto-resume
     * must keep the backoff counter (it IS the backoff), a manual resume resets it.
     */
    private readonly autoResumingRunIds;
    private readonly onPaused;
    private readonly onTerminal;
    private readonly onResumed;
    constructor(manager: SchedulableWorkflowManager, options?: UsageLimitSchedulerOptions);
    /**
     * Bind recovery to the host session after session_start has supplied the
     * authoritative session id. This is intentionally separate from construction:
     * extension factories run before Pi has selected/resumed the target session.
     */
    bindSession(sessionId: string | undefined): void;
    /** Clear every armed timer and unsubscribe from the manager. Idempotent. */
    dispose(): void;
    /** Test/diagnostic helper: in-memory attempt count tracked for a run, if any. */
    getAttemptCount(runId: string): number | undefined;
    /** Test/diagnostic helper: whether a resume timer is currently armed for a run. */
    hasArmedTimer(runId: string): boolean;
    private handlePaused;
    private cleanup;
    /**
     * A run was resumed. If WE resumed it (auto-resume timer fired), leave the
     * backoff counter alone — that's the sequence doing its job, and it must still
     * be able to reach the cap. If a human resumed it (via /workflows), treat that
     * as a deliberate fresh start: drop the in-memory given-up state and reset the
     * persisted counter so a later pause re-enters the normal backoff from attempt 1
     * instead of staying silently given-up forever.
     */
    private handleResumed;
    private coldStartRearm;
    private ownsBoundSession;
    private arm;
    private onTimerFire;
    private safeLoad;
    private safeStatus;
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
    private persistAttempts;
    private safe;
}
