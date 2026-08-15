/**
 * Workflow run state persistence for pause/resume support.
 */
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { MAX_DURABLE_RUN_BYTES } from "./config.js";
import type { WorkflowErrorCode } from "./errors.js";
import { type PersistenceFsLayer } from "./fs-persistence.js";
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";
export type DeliveryOutboxStatus = "pending" | "submitted" | "projected";
export type DeliveryOutboxKind = "explicit" | "terminal";
/** A durable, replayable logical delivery. The provider-facing projection is
 * deliberately not persisted here; `content` is the complete explicit text,
 * while terminal records point at the complete run result and are projected by
 * the host at send time. `generation` is fencing metadata, never identity. */
export interface PersistedDeliveryRecord {
    deliveryId: string;
    sequence: number;
    kind: DeliveryOutboxKind;
    status: DeliveryOutboxStatus;
    content?: string;
    terminal?: boolean;
    generation?: number;
    createdAt: string;
}
export interface DeliveryBudgetState {
    explicitCount: number;
    explicitBytes: number;
    windowStartedAt: number;
    windowCount: number;
}
export interface PersistedAgentState {
    id: number;
    /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
    callId?: string;
    label: string;
    phase?: string;
    prompt: string;
    status: "queued" | "running" | "done" | "error" | "skipped";
    result?: unknown;
    /** Compact result written by releases before full agent results were retained. */
    resultPreview?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    history?: AgentHistoryEntry[];
    startedAt?: string;
    endedAt?: string;
    /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
    tokens?: number;
    /** Per-agent token usage breakdown, when the provider reported one. */
    tokenUsage?: AgentUsage;
    /** The model this agent ran on (provider/id), when known. */
    model?: string;
}
export interface PersistedRunState {
    runId: string;
    workflowName: string;
    script: string;
    args?: unknown;
    /** The pi session this run belongs to. Runs persist on disk across sessions but
     * the navigator shows only the current session's runs (undefined = legacy/global). */
    sessionId?: string;
    status: RunStatus;
    /** Durable record version. It increases on every successful save. */
    revision?: number;
    /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
    pauseReason?: string;
    /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
    resetHint?: string;
    phases: string[];
    currentPhase?: string;
    agents: PersistedAgentState[];
    logs: string[];
    result?: unknown;
    startedAt: string;
    updatedAt: string;
    completedAt?: string;
    durationMs?: number;
    tokenUsage?: {
        input: number;
        output: number;
        total: number;
        cost?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    /**
     * Cached agent/checkpoint results for resume, keyed by deterministic call
     * index. `runId` namespaces `index` (a nested workflow() call restarts its
     * own callSeq at 0) — absent on journals persisted before that namespacing
     * existed; see JournalEntry.runId in workflow.ts for the resume-time
     * legacy-degradation behavior. `storeDelta` is this call's SharedStore
     * write delta, replayed additively on resume.
     */
    journal?: Array<{
        index: number;
        runId?: string;
        hash: string;
        result: unknown;
        model?: string;
        storeDelta?: Record<string, unknown>;
    }>;
    /**
     * Opt-out of auto-resume for this run (default true, i.e. eligible unless
     * explicitly set to false via ExecOptions.autoResume). Set once at run start
     * and carried through resumes; see UsageLimitScheduler.
     */
    autoResume?: boolean;
    /**
     * The run's resolved hard token budget, fixed at start (per-run value, else
     * the manager default at the time). Resume re-applies THIS value — never the
     * current default — so an explicit no-budget (`null`) or custom cap survives
     * a pause/resume cycle. Absent on legacy runs (resumed unbudgeted).
     */
    tokenBudget?: number | null;
    /**
     * Named toolset tag (WorkflowManagerOptions.toolsets). ToolDefinitions are
     * functions and can't be serialized, so this tag is how a resumed run (e.g.
     * /deep-research with web tools) re-resolves the tool set it started with.
     */
    toolset?: string;
    /**
     * The run's resolved cap on total agents, fixed at start (per-run value,
     * else undefined so runWorkflow applies its own MAX_AGENTS_PER_RUN default).
     * Resume re-applies THIS value — never the manager's current default — same
     * rationale as tokenBudget. Absent on legacy runs (resumed with no cap
     * carried forward, i.e. runWorkflow's own default applies).
     */
    maxAgents?: number;
    /**
     * The run's resolved per-agent timeout, fixed at start (per-run value, else
     * the manager default at the time). Absent on legacy runs — unlike
     * tokenBudget, a legacy run's real timeout was never "no timeout" by
     * omission; it was always the manager's default (pre-A1 resume always fell
     * back to it), so resume applies the manager's CURRENT default for such
     * runs rather than null, preserving both the run's original semantics and
     * pre-fix resume behavior.
     */
    agentTimeoutMs?: number | null;
    /**
     * The run's finite logical wall-clock deadline, fixed at start. Legacy
     * records without this field resume with the manager's current default.
     */
    workflowTimeoutMs?: number;
    /**
     * The run's resolved concurrency, fixed at start (per-run value, else the
     * manager's concurrency at the time). Same rationale as tokenBudget.
     */
    concurrency?: number;
    /**
     * The run's resolved agent-retry count, fixed at start (per-run value, else
     * the manager default at the time). Same rationale as tokenBudget.
     */
    agentRetries?: number;
    /**
     * Auto-resume attempt counter for the current usage_limit pause-cycle, owned
     * and persisted by UsageLimitScheduler (best-effort). Absent/0 means no
     * auto-resume attempt has been recorded yet.
     */
    autoResumeAttempts?: number;
    /** Stable-ID at-least-once delivery outbox. Acknowledged records are removed. */
    deliveryOutbox?: PersistedDeliveryRecord[];
    /** Monotonic sequence allocator retained even after acknowledged records leave the outbox. */
    nextDeliverySequence?: number;
    /** Cumulative explicit-delivery admission accounting, retained after ack. */
    deliveryBudget?: DeliveryBudgetState;
}
export interface RunPersistence {
    /**
     * Save current run state. If expectedRevision is supplied, the write is a
     * durable compare-and-swap and throws when the record has advanced. A
     * supplied state.revision is likewise treated as the caller's fence. The
     * state object is updated with the committed revision for callers that need
     * to carry the fence forward.
     */
    save(state: PersistedRunState, expectedRevision?: number, lease?: RunLease): void;
    /** Load a persisted run by ID. */
    load(runId: string): PersistedRunState | null;
    /** List all persisted runs. */
    list(): PersistedRunState[];
    /** Delete a persisted run, optionally fenced by its current revision. */
    delete(runId: string, expectedRevision?: number, lease?: RunLease): boolean;
    /**
     * Acquire an exclusive cross-process lease for a run. Returns null when another
     * live process owns the run; demonstrably stale, valid lock files are removed
     * and retried. Unreadable locks are treated as occupied conservatively.
     */
    acquireRunLease(runId: string): RunLease | null;
    /** Release a lease previously returned by acquireRunLease(). */
    releaseRunLease(lease: RunLease): void;
    /** Get runs directory path. */
    getRunsDir(): string;
}
export interface RunLease {
    runId: string;
    token: string;
}
/** Raised when a durable record has changed since the caller read it. */
export declare class PersistenceRevisionConflict extends Error {
    constructor(runId: string, expected: number | undefined, actual: number | undefined);
}
/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 * (Alias of the shared PersistenceFsLayer — see fs-persistence.ts.)
 */
export type FsLayer = PersistenceFsLayer;
/**
 * Retention policy for terminal (completed/failed/aborted) runs kept on
 * disk. Bounded so a long-lived project directory can't accumulate an
 * unbounded number of run files (each polled/listed on every list() call).
 * A run in "running" or "paused" status is NEVER counted against this cap
 * or evicted by it — only genuinely finished runs age out, oldest (by
 * updatedAt) first, once the terminal-run count exceeds the cap. 300 is
 * generous enough to cover weeks of typical usage while keeping list()'s
 * per-call directory scan bounded.
 */
export declare const DEFAULT_MAX_TERMINAL_RUNS_ON_DISK = 300;
/** Maximum complete UTF-8 JSON size for one persisted run record. */
export { MAX_DURABLE_RUN_BYTES };
/** Validate IDs before they reach any filesystem or in-memory run boundary. */
export declare function assertSafeRunId(runId: string): void;
export interface RunPersistenceOptions {
    /** Override DEFAULT_MAX_TERMINAL_RUNS_ON_DISK (tests; advanced tuning). */
    maxTerminalRunsOnDisk?: number;
    /** Override MAX_DURABLE_RUN_BYTES (tests; advanced tuning). */
    maxDurableRunBytes?: number;
}
export declare function createRunPersistence(cwd: string, fsOverride?: Partial<FsLayer>, options?: RunPersistenceOptions): RunPersistence;
/**
 * Generate a unique run ID.
 */
export declare function generateRunId(): string;
