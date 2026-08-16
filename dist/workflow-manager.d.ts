/**
 * Workflow manager for background execution, pause/resume, and run management.
 */
import { EventEmitter } from "node:events";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowAgent } from "./agent.js";
import { type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { WorkflowError } from "./errors.js";
import { type DeliveryBudgetState, type PersistedDeliveryRecord, type PersistedRunState, type RunLease, type RunPersistence, type RunStatus } from "./run-persistence.js";
import { type JournalEntry, type WorkflowRunResult, type WorkflowSteeringKind, type WorkflowSteeringMessage } from "./workflow.js";
import { type ExecutionReservation, type ResourceDiagnostics, WorkflowResourceCoordinator, type WorkflowResourceCoordinatorOptions } from "./workflow-resource-coordinator.js";
export interface ManagedRun {
    runId: string;
    status: RunStatus;
    snapshot: WorkflowSnapshot;
    result?: WorkflowRunResult;
    error?: WorkflowError;
    controller: AbortController;
    startedAt: Date;
    /** The real script, kept so the run can be resumed. */
    script: string;
    args?: unknown;
    /** Accumulated agent results for resume (deterministic call index -> result). */
    journal: JournalEntry[];
    /** The current execution promise; resume waits for a paused generation to drain. */
    execution?: Promise<unknown>;
    /**
     * True only after the current executeRun() promise has fully settled. Status
     * alone cannot answer this: manual pause() publishes "paused" immediately
     * while the aborted provider generation may still be unwinding.
     */
    executionSettled?: boolean;
    /** Last retention class published by the settled-tail cleanup. */
    settledCleanupStatus?: "paused" | "terminal";
    /** Monotonic manager-local start/resume order for unqualified message routing. */
    activitySeq: number;
    /** Cross-process execution lease for this run, when it is actively executing. */
    lease?: RunLease;
    /**
     * True when the run was started in the background (or resumed) and the caller is
     * not awaiting its result inline. Only background runs deliver their result back
     * into the conversation; a foreground sync run already returns it as the tool
     * result, so re-delivering would duplicate it.
     */
    background: boolean;
    /**
     * Pi session that owned this run at start (or the session it was explicitly
     * adopted into on an in-process session replacement). Frozen on the live
     * object and written on every persist — never re-read from the manager's
     * current sessionId, or a mid-flight setSessionId() would silently re-home
     * the run and hide it from stranded-pause / the originating session's panel.
     */
    sessionId?: string;
    /**
     * Auto-resume eligibility for this run (see ExecOptions.autoResume). Set once
     * at creation and carried through resume() so it survives pause/resume cycles.
     * Undefined means eligible (default-on); false opts out.
     */
    autoResume?: boolean;
    /**
     * The run's resolved hard token budget (per-run value, else the manager
     * default), fixed at run start and carried through resume() — a resumed run
     * must keep the budget it started with, not re-resolve against the current
     * default (an explicit `null` opt-out would otherwise regain a budget).
     */
    tokenBudget?: number | null;
    /**
     * Named toolset tag for this run (see WorkflowManagerOptions.toolsets).
     * ToolDefinitions are functions and can't be persisted, so the tag is what
     * survives on disk — resume() re-resolves it so e.g. a resumed
     * `/deep-research` run keeps its web tools instead of silently degrading to
     * the default coding tools.
     */
    toolset?: string;
    /**
     * Real per-agent start/end timestamps, captured at onAgentStart/onAgentEnd
     * (never fabricated), keyed by the agent's snapshot id. A running agent has
     * an entry with no endedAt; persistRun() reads from here instead of stamping
     * every agent with the run's startedAt / "now".
     */
    agentTimestamps: Map<number, {
        startedAt: string;
        endedAt?: string;
    }>;
    /**
     * Live snapshot-agent lookup keyed by the agent CALL's unique id (see
     * WorkflowRunOptions.onAgentStart/onAgentEnd/onAgentHistory's `id` field in
     * workflow.ts — unique per call, never per label). onAgentEnd/onAgentHistory
     * must resolve the snapshot entry to update through this map, never by
     * scanning managed.snapshot.agents for a label match: two concurrent agents
     * routinely share a label (e.g. parallel()'s default `"${phase} agent N"`
     * labeling, or an author-supplied label reused across a fan-out), and a
     * label+status scan would update whichever same-label entry it happens to
     * find first — misattributing one agent's end/history event to a different,
     * still-running sibling.
     */
    agentsById: Map<string, WorkflowAgentSnapshot>;
    /**
     * The run's cap on total agents (per-run value, else left undefined so
     * runWorkflow applies its own MAX_AGENTS_PER_RUN default), fixed at run
     * start/resume and carried through resume() — mirrors ManagedRun.tokenBudget
     * exactly: a resumed run must keep the cap it started with, not silently
     * regain the (much larger) default because ExecOptions.maxAgents isn't
     * threaded through resume()'s executeRun() call.
     */
    maxAgents?: number;
    /**
     * The run's resolved per-agent timeout (per-run value, else the manager
     * default at the time), fixed at run start/resume — same rationale as
     * tokenBudget/maxAgents: resume() must not re-resolve against the manager's
     * CURRENT defaultAgentTimeoutMs.
     */
    agentTimeoutMs?: number | null;
    /** Finite logical wall-clock deadline, fixed at run start and carried through resume. */
    workflowTimeoutMs?: number;
    /**
     * The run's resolved concurrency (per-run value, else the manager's
     * concurrency at the time), fixed at run start/resume for the same reason
     * as tokenBudget.
     */
    concurrency?: number;
    /**
     * The run's resolved agent-retry count (per-run value, else the manager
     * default at the time), fixed at run start/resume for the same reason as
     * tokenBudget.
     */
    agentRetries?: number;
    /** Last durable revision successfully written for this run. */
    revision?: number;
    /** Stop already emitted its lifecycle event; prevents success/abort duplicates. */
    stopRequested?: boolean;
    /** Durable explicit/terminal delivery records for this run. */
    deliveryOutbox: PersistedDeliveryRecord[];
    /** Monotonic stable-ID sequence, retained after acknowledgements remove records. */
    nextDeliverySequence: number;
    /** Finite explicit-delivery accounting, retained after acknowledgements. */
    deliveryBudget: DeliveryBudgetState;
    /** Manager-wide execution reservation owned by this generation. */
    resourceExecutionHeld?: boolean;
    resourceExecutionReleased?: boolean;
    /** Exact single-use coordinator capability for this execution generation. */
    resourceExecutionReservation?: ExecutionReservation;
    /** Distinguishes isolated worktree ownership across resume generations. */
    executionGeneration?: string;
    persistenceBlocked?: boolean;
}
/** Per-execution options shared by sync, background, and resume runs. */
export interface ExecOptions {
    /**
     * Replay these journaled agent/checkpoint results for the unchanged prefix
     * (resume), keyed by `${runId}:${index}` — see
     * WorkflowRunOptions.resumeJournal in workflow.ts.
     */
    resumeJournal?: Map<string, JournalEntry>;
    /** Cap on total agents for this run. */
    maxAgents?: number;
    /** Per-agent timeout in milliseconds. null/omitted means no per-agent hard timeout. */
    agentTimeoutMs?: number | null;
    /** Finite logical wall-clock deadline for this execution. */
    workflowTimeoutMs?: number;
    /** Host signal (e.g. tool/Esc) that should abort this run when fired. */
    externalSignal?: AbortSignal;
    /** Called with the live snapshot on every progress event. */
    onProgress?: (snapshot: WorkflowSnapshot) => void;
    /** Hard token budget for this run; once spent reaches it, agent() throws. */
    tokenBudget?: number | null;
    /**
     * Tool set for this run's subagents, replacing the default coding tools —
     * e.g. built-in `/deep-research` appends web tools. Omit for the default.
     * Not persistable (functions): pair with `toolset` so a resumed run can
     * re-resolve the same tools.
     */
    tools?: ToolDefinition[];
    /**
     * Named toolset tag, resolved via WorkflowManagerOptions.toolsets. Persisted
     * with the run and re-resolved on resume(). When both `tools` and `toolset`
     * are given, `tools` wins for this execution and `toolset` is what resumes use.
     */
    toolset?: string;
    /** Max concurrent agents for this execution. */
    concurrency?: number;
    /** Retry attempts after recoverable agent failures for this execution. */
    agentRetries?: number;
    /** Resolve a checkpoint() question with a human reply (only for UI-bearing runs). */
    confirm?: (promptText: string, options: unknown) => Promise<unknown>;
    /**
     * Whether this run is eligible for auto-resume when it pauses on a provider
     * usage limit. Default-on: omit or pass true to stay eligible, pass false to
     * opt out. Persisted on the run so a cold-start UsageLimitScheduler respects
     * it too. See usage-limit-scheduler.ts.
     */
    autoResume?: boolean;
    /**
     * Seed for the execution's cumulative token counters — passed through to
     * runWorkflow's WorkflowRunOptions.initialTokenUsage. Only resume() sets
     * this (from the persisted run's tokenUsage-at-pause), so the resumed
     * execution's fresh SharedRuntime starts counting from the already-spent
     * total instead of zero (see A2 in workflow-manager's resume()).
     */
    initialTokenUsage?: {
        input: number;
        output: number;
        total: number;
        cost: number;
        cacheRead: number;
        cacheWrite: number;
    };
}
export interface WorkflowManagerOptions {
    cwd?: string;
    concurrency?: number;
    /** Bounded manager-wide execution/provider resources. */
    resourceLimits?: WorkflowResourceCoordinatorOptions;
    /** Convenience aliases for resourceLimits (kept explicit for host settings). */
    maxActiveExecutions?: number;
    maxProviderConcurrency?: number;
    maxQueuedProviderAttempts?: number;
    maxLateAttempts?: number;
    maxPausedRunsOnDisk?: number;
    maxPausedBytesOnDisk?: number;
    /** Inject a coordinator so reloads/tests can retain one resource budget. */
    resourceCoordinator?: WorkflowResourceCoordinator;
    /** Namespace used when an explicitly shared coordinator is injected. */
    resourceNamespace?: string;
    /** Resolve a saved-workflow name to its script, enabling nested `workflow('name')`. */
    loadSavedWorkflow?: (name: string) => string | undefined;
    /** Inject a custom agent runner (tests); defaults to a real subagent session. */
    agent?: Pick<WorkflowAgent, "run">;
    /** The session's main model (provider/id), for auto-tiering explore agents. */
    mainModel?: string;
    /**
     * The host Pi session's model registry. When provided, workflow subagents
     * resolve models against the same registry as the main session, including
     * extension-registered providers such as ollama-cloud.
     */
    modelRegistry?: ModelRegistry;
    /** The pi session id to tag runs with (see setSessionId). */
    sessionId?: string;
    /** Default per-agent timeout when a run does not pass agentTimeoutMs. null means no per-agent hard timeout. */
    defaultAgentTimeoutMs?: number | null;
    /** Default finite logical wall-clock deadline for a workflow frame. */
    defaultWorkflowTimeoutMs?: number;
    /** Default retry attempts after recoverable agent failures. */
    defaultAgentRetries?: number;
    /** Default hard token budget when a run does not pass tokenBudget. null/omitted means no budget. */
    defaultTokenBudget?: number | null;
    /**
     * Named toolsets resolvable by ExecOptions.toolset — e.g.
     * `{ "web-research": () => [...createCodingTools(cwd), ...createWebTools()] }`.
     * Called lazily per execution (including on resume). An unknown tag resolves
     * to the default coding tools.
     */
    toolsets?: Record<string, () => ToolDefinition[]>;
    /**
     * Extra tool NAMES to deny in every subagent session, on top of the always-on
     * workflow-family defaults (see DEFAULT_EXCLUDED_SUBAGENT_TOOLS).
     * Host wiring passes settings.excludeSubagentTools here so users can also block
     * other recursive-orchestration tools (#107).
     */
    excludeSubagentTools?: string[];
    /**
     * Bridge for the workflow runtime's classified deliver() global. Host wiring
     * (extensions/workflow.ts) sets this per generation so messages land in the
     * current session's conversation. Delivery identity is supplied by the
     * manager's durable outbox and must be preserved by the host.
     */
    onDeliver?: (message: string, source?: {
        runId: string;
        workflowName: string;
        alertKind: "blocker" | "critical_finding" | "decision";
        deliveryId?: string;
        sequence?: number;
    }) => void | Promise<void>;
    /** Optional observer for each live subagent result. Hosts should normally keep this persistence/UI-only. */
    onAgentMessage?: (event: {
        runId: string;
        id: string;
        label: string;
        phase?: string;
        result: unknown;
        error?: string;
    }) => void;
    /**
     * Persist each subagent transcript as a real pi session file under the
     * standard sessions directory. Default false (in-memory, discarded).
     */
    persistAgentSessions?: boolean;
    /**
     * How many terminal (completed/failed/aborted) runs to retain full
     * in-memory state for before the oldest is evicted from `runs` (see the
     * class-level doc comment on that field). Defaults to
     * DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY; exposed mainly for tests that want
     * to observe eviction without creating dozens of runs.
     */
    maxTerminalRunsInMemory?: number;
    /** How many settled paused run snapshots to retain in memory; disk remains resumable. */
    maxPausedRunsInMemory?: number;
}
/** Options that a fresh extension generation may safely refresh on a live
 * manager handed across `/reload`. Execution identity (`cwd`, persistence,
 * injected agent, and in-memory runs) is intentionally excluded. */
export type WorkflowManagerReloadOptions = Pick<WorkflowManagerOptions, "concurrency" | "loadSavedWorkflow" | "defaultAgentTimeoutMs" | "defaultWorkflowTimeoutMs" | "defaultAgentRetries" | "defaultTokenBudget" | "toolsets" | "excludeSubagentTools" | "persistAgentSessions">;
/** Explicit deliver() admission budgets. Terminal lifecycle records do not
 * consume these budgets and are always admitted with priority. */
export declare const MAX_EXPLICIT_DELIVERIES_PER_RUN = 32;
export declare const MAX_EXPLICIT_DELIVERY_BYTES_PER_RUN: number;
export declare const MAX_EXPLICIT_DELIVERIES_PER_WINDOW = 8;
export declare const EXPLICIT_DELIVERY_RATE_WINDOW_MS = 10000;
export declare class WorkflowManager extends EventEmitter {
    /**
     * Lifecycle contract for `runs`:
     *
     *  - An entry is added when a run starts (startInBackground/runSync) or is
     *    resumed (resume()), always with a live AbortController and (usually)
     *    an active RunLease.
     *  - While status is "running", or "paused" with executeRun() still
     *    unwinding, the entry is NEVER evicted. An abort-ignoring provider may
     *    still own callbacks and the execution lease during that interval.
     *  - Once a paused execution has settled and released its lease, it enters a
     *    separate bounded FIFO (recordPausedRun()). A persistence-blocked pause
     *    may still point at the last durable running checkpoint; eviction removes
     *    only the in-memory snapshot and stale recovery keeps it resumable.
     *  - Once terminal, an entry becomes eviction-ELIGIBLE (recordTerminalRun())
     *    but is not necessarily evicted immediately: up to
     *    maxTerminalRunsInMemory terminal entries are kept, oldest evicted
     *    first, so a `getRun()` call immediately after completion (e.g. the
     *    "complete" event's own synchronous listeners — task-panel's result
     *    delivery, `/workflows watch`) still sees the live object. Once
     *    evicted, the entry is simply removed from `runs`; nothing else reads
     *    or writes it again.
     *  - Every caller of getRun()/getSnapshot() must treat "undefined"/null as
     *    "no live in-memory copy right now" and fall back to listRuns() (backed
     *    by run-persistence.ts, which is what's authoritative for a run once
     *    the in-memory copy is gone) — this mirrors how those callers already
     *    treat any run this process never had in memory (e.g. one started by a
     *    different process and only ever seen via listRuns()). resume() never
     *    depends on `runs` for a run's state either: it always reloads from
     *    persistence, so an evicted runId resumes exactly like one from a
     *    prior process.
     *  - isCurrent(managed) composes with eviction the same way it composes
     *    with resume()/deleteRun() replacing or removing an entry: eviction
     *    removes the map entry outright, so a stale execution's later settle
     *    (isCurrent() check) sees `this.runs.get(runId) !== managed` (in fact
     *    undefined) and correctly no-ops, exactly as it would after
     *    resume()/deleteRun().
     */
    private runs;
    /**
     * FIFO of runIds that reached IN_MEMORY_TERMINAL_STATUSES, oldest first —
     * the eviction order for `runs` (see its doc comment). A runId can appear
     * more than once (e.g. resumed after eviction, then terminates again);
     * evicting is idempotent (recordTerminalRun() re-checks the CURRENT status
     * of the current map entry for that id before deleting), so duplicates
     * are harmless.
     */
    private terminalRunQueue;
    /** Settled paused generations, not just runIds: a stale queue entry from a
     * prior resume must never evict the current generation for the same runId. */
    private pausedRunQueue;
    private maxTerminalRunsInMemory;
    private maxPausedRunsInMemory;
    private activitySeq;
    private persistence;
    private cwd;
    private concurrency;
    private loadSavedWorkflow?;
    private agent?;
    /** The session's main model (provider/id), for auto-tiering explore agents. */
    private mainModel?;
    /** The host Pi session's model registry, shared with subagents. */
    private modelRegistry?;
    /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
    private sessionId?;
    private defaultAgentTimeoutMs;
    private defaultWorkflowTimeoutMs;
    private defaultAgentRetries;
    private defaultTokenBudget;
    private toolsets?;
    private excludeSubagentTools?;
    private persistAgentSessions;
    private readonly resources;
    private readonly resourceNamespace;
    private readonly maxPausedRunsOnDisk;
    private readonly ownedWorktreeTokens;
    private readonly maxPausedBytesOnDisk;
    /** Runtime deliver() bridge; refreshed by host wiring each generation. */
    onDeliver?: WorkflowManagerOptions["onDeliver"];
    /** Optional host observer for live subagent results; not provider delivery by default. */
    onAgentMessage?: WorkflowManagerOptions["onAgentMessage"];
    private pendingMessages;
    private pendingMessageCount;
    private pendingMessageBytes;
    private activeAgentSenders;
    constructor(options?: WorkflowManagerOptions);
    /** Mark a generation as blocked on durable publication without reopening it.
     * An aborted controller cannot be restarted, so restoring `running` here
     * would leave a ghost entry that rejects both resume and new work. */
    private markPersistenceBlocked;
    /** Bind the manager to the current pi session, so new runs are tagged with it and
     * the navigator/task-panel show only this session's runs (set on session_start). */
    setSessionId(id: string | undefined): void;
    /** Current Pi session binding used for ownership-scoped lifecycle actions. */
    getSessionId(): string | undefined;
    /** Queue a host-session message for one explicitly identified running workflow. */
    enqueueUserMessage(message: string, runId: string, kind: WorkflowSteeringKind): string | undefined;
    /** Atomically take messages queued for a run before its next agent() call. */
    takePendingMessages(runId: string): WorkflowSteeringMessage[];
    private dropPendingMessages;
    /** Send immediately to a child in one explicitly identified running workflow. */
    sendToAgent(message: string, agentId: string, runId: string, kind: WorkflowSteeringKind): Promise<string | undefined>;
    /** Project cwd this manager was constructed for (persistence + agent tools). */
    getCwd(): string;
    /**
     * Every live in-memory run, regardless of the navigator's session filter.
     * Stranded-pause / cross-session recovery must use this — listRuns() hides
     * runs whose frozen sessionId no longer matches the bound session.
     */
    listLiveRuns(): ManagedRun[];
    /**
     * After an in-process session replacement keeps this manager, re-home every
     * still-running (or paused-in-memory) run onto the new session so the panel,
     * workflow_control, and a later stranded-pause all see them. Completed runs
     * keep their original sessionId so history stays with the session that ran
     * them. No-op when `sessionId` is undefined.
     */
    adoptLiveRunsToSession(sessionId: string | undefined): number;
    /**
     * On startup, any persisted run still marked "running" belongs to a process
     * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
     * to "paused" — never "failed" — so its journal is preserved and resume() can
     * replay the completed prefix and finish the rest.
     */
    private recoverStaleRuns;
    /**
     * Refresh host configuration after Pi reloads the extension while retaining
     * this manager's live runs, controllers, leases, and event listeners.
     * Existing executions keep the options they captured at start; subsequent
     * runs and resumes use these refreshed defaults.
     */
    reconfigureAfterReload(options: WorkflowManagerReloadOptions): void;
    /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
    setMainModel(spec: string | undefined): void;
    /** Set the host session's model registry so subagents resolve models consistently. */
    setModelRegistry(registry: ModelRegistry): void;
    /**
     * Expose the host session's model registry to integrations sharing this
     * manager. Workflow execution reads the same registry internally.
     */
    getModelRegistry(): ModelRegistry | undefined;
    /**
     * Start a workflow in the background.
     * Returns immediately with a run ID; the workflow executes asynchronously.
     */
    startInBackground(script: string, args?: unknown, exec?: ExecOptions): {
        runId: string;
        promise: Promise<WorkflowRunResult>;
    };
    /**
     * Execute a workflow synchronously (blocking) while still tracking it like a
     * background run, so the `/workflows` navigator and the live task panel see it.
     * `onProgress` fires on every progress event with the current snapshot, letting
     * a caller (e.g. the workflow tool) drive its own inline display.
     */
    runSync(script: string, args?: unknown, exec?: ExecOptions): Promise<WorkflowRunResult>;
    private assertPausedDurableCapacity;
    private admitArgs;
    /** Build a fresh managed run with an empty snapshot. */
    private createManaged;
    /** Admit an explicit deliver() call into the durable outbox. The counters
     * are cumulative for the run, while the sliding window bounds continuation
     * storms. Terminal notifications intentionally bypass this admission path. */
    private admitExplicitDelivery;
    /** Reserve one terminal record before publishing terminal state. It is
     * idempotent, so duplicate lifecycle events cannot create duplicate wakes. */
    private ensureTerminalDelivery;
    private persistRunStrict;
    /** Durable outbox records awaiting provider inclusion or acknowledgement.
     * This reads disk so reloads and evicted terminal runs are replayable. */
    listPendingDeliveries(): Array<PersistedDeliveryRecord & {
        runId: string;
        workflowName: string;
        runStatus: RunStatus;
    }>;
    /** Advance outbox state under the run's CAS/lease fence. Generation is
     * checked on every transition and never changes logical delivery identity. */
    acknowledgeDelivery(runId: string, deliveryId: string, generation: number, phase: "submitted" | "projected" | "acknowledged"): boolean;
    private executeRun;
    /**
     * True when `managed` is still the live, current entry for its runId in
     * `this.runs` — false once resume() has replaced it with a new ManagedRun
     * object for the same runId, or deleteRun() has removed it entirely. A
     * superseded ManagedRun's async completion (executeRun's promise settling
     * well after something else already took over or tore down that runId)
     * must not write to disk or touch lease state on the newer execution's
     * behalf — see writeRunToDisk() and executeRun()'s post-await persist calls.
     */
    private releaseExecutionCapacity;
    private isCurrent;
    /** A bound session may only recover/control records explicitly owned by it.
     * Legacy unowned records fail closed once a session is known. */
    private ownsPersistedRun;
    /**
     * Emit an event on behalf of `managed`, but only while it's still the
     * current entry for its runId (see isCurrent()) — mirrors the disk/lease
     * guard for the observer-facing side of the same problem. A superseded
     * execution's progress/terminal events (log, phase, agentStart/End,
     * tokenUsage, complete, error, paused) are not just stale-but-harmless:
     * "complete" in particular can drive background result delivery into the
     * conversation, so letting a deleted/superseded run's stale settle still
     * fire it would deliver a result for a run that, from the caller's POV, no
     * longer exists (or has since been superseded by a newer execution whose
     * own events already tell the true story). No event in this set has a
     * legitimate reason to still reach listeners once superseded — unlike
     * disk writes there's no "expected race, harmless no-op" nuance here, it's
     * simply wrong to notify twice (or for a run that's gone). Events emitted
     * directly by pause()/stop()/resume()/deleteRun() themselves are NOT routed
     * through this helper — those methods own the transition and ARE current
     * at the moment they fire, same precedent as their persist/lease calls.
     */
    private emitLive;
    /**
     * Emit with listener isolation (UIOBS-006): a throwing listener (e.g. a
     * delivery renderer formatting a non-serializable result) must never abort
     * the lifecycle code mid-transition — that would corrupt status/lease/
     * persistence. Listener failures are diagnosed and otherwise ignored.
     */
    private safeEmit;
    /**
     * Mark a settled paused run as in-memory eviction-eligible. Callers invoke
     * this only from executeRun's settled tail, after sender cleanup and lease
     * release. Re-read the current entry before deleting so a stale queue item
     * can never evict a resumed generation for the same runId. The durable record
     * may be stale when publication is persistence-blocked; recovery still treats
     * running/paused records as resumable boundaries.
     */
    private recordPausedRun;
    /**
     * Mark `runId` as eviction-eligible now that its execution has genuinely
     * settled to a terminal status, and evict the oldest eligible entries.
     * The current status is revalidated so stale queue entries cannot evict a
     * resumed live generation.
     */
    private recordTerminalRun;
    /**
     * Additively fold one agent-call's token cost into the run-wide persisted
     * aggregate (managed.snapshot.tokenUsage), seeded (on resume) from the
     * persisted total-at-pause — see A2. Shared by onAgentEnd (a completed or
     * finally-failed agent call) and onRetrySpend (a failed attempt that WILL
     * be retried, whose cost recordTokens() already folded into
     * shared.spent/tokenUsage in workflow.ts, but which onAgentEnd never sees —
     * see WorkflowRunOptions.onRetrySpend for why that needs its own channel).
     */
    private accumulateTokenUsage;
    private cleanupManagedSenders;
    /**
     * Release every resource owned by a generation whose executeRun() tail has
     * settled. This is intentionally idempotent: pause()/stop() can observe an
     * already-settled generation while the normal catch/finally path may also
     * be unwinding. The current-object check preserves generation fencing; a
     * stale generation may release only resources already detached by
     * deleteRun()/resume(), never a replacement run with the same runId.
     */
    private cleanupSettledGeneration;
    private releaseRunLease;
    /** Trailing-edge throttle window for high-frequency progress persists (see schedulePersist). */
    private static readonly PERSIST_THROTTLE_MS;
    /** Pending trailing-edge persist timers for high-frequency progress events, keyed by runId. */
    private persistTimers;
    /**
     * Coalesce rapid progress persists (currently: onAgentJournal, which fires
     * once per completed agent and can burst under concurrency) to at most one
     * disk write per PERSIST_THROTTLE_MS (trailing edge) instead of one write
     * per tick — persistRun() does a full JSON.stringify of the run plus up to
     * 3 sync writes, so firing it once per agent in a long run is O(N^2).
     *
     * Lifecycle-critical writes (status transitions, run end, pause/resume/stop)
     * must NOT use this — call persistRun() directly, which flushes (and cancels)
     * any pending timer first so a stale trailing write can never fire after, and
     * resurrect, a terminal state.
     */
    private schedulePersist;
    /**
     * Persist immediately and synchronously. Cancels any pending throttled write
     * for this run first, so the write that lands is always the caller's current
     * (final) state — never superseded by a stale deferred write. Use this for
     * every lifecycle-critical persist: run start, status transitions, run end,
     * pause()/resume()/stop().
     */
    private persistRun;
    private persistedStateFor;
    private writeRunToDisk;
    /**
     * Pause a running workflow.
     */
    pause(runId: string): boolean;
    /**
     * Resume an interrupted run: replay journaled results for the unchanged prefix
     * and run the rest live. Returns false if there is nothing resumable.
     *
     * `opts.script` lets the orchestrating model resume with an EDITED script
     * (cached-prefix reuse / iteration): unchanged agent() calls whose content
     * hash still matches the journal entry at their positional callIndex replay
     * from cache, while the first changed or newly inserted call — and everything
     * after it — re-runs live. When `opts.script` is omitted, resume behaves
     * exactly as before and uses the persisted script (auto-resume, TUI resume);
     * this keeps the existing single-arg `resume(runId)` callers (e.g. the
     * UsageLimitScheduler) unchanged. `opts.args` overrides the persisted args
     * only when provided; otherwise the persisted args are kept.
     */
    resume(runId: string, opts?: {
        script?: string;
        args?: unknown;
    }): Promise<boolean>;
    /**
     * Stop a running workflow.
     *
     * Fast path: the run is live in this process (`this.runs`) — abort its
     * controller and persist "aborted" as before. Fallback: the run is not in
     * memory but is persisted as "running" or "paused" — e.g. it belongs to a
     * prior pi session that this process's recoverStaleRuns() flipped to
     * "paused" on disk without repopulating this.runs (see workflow-control-tool's
     * findRun(), which resolves candidates from disk via listRuns()). There is no
     * live controller to abort in that case — the run simply isn't executing in
     * this process — so mark it aborted on disk directly, mirroring resume()'s
     * persisted-fallback lease handling.
     */
    stop(runId: string): boolean;
    /**
     * Get status of a specific run.
     */
    getRun(runId: string): ManagedRun | undefined;
    /** Fresh, bounded resource view for operators and regression tests. */
    getResourceDiagnostics(): ResourceDiagnostics & {
        inMemoryRuns: number;
        persistedRunCount: number;
        persistedRunBytes: number;
        durableHighWaterBytes?: number;
        durableHighWaterCount?: number;
        ownedWorktrees: number;
    };
    /**
     * List all runs (active + persisted).
     */
    /**
     * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
     * that session's runs are returned — runs from other sessions stay on disk and
     * reappear when you switch back. Unbound (tests/legacy) returns everything.
     */
    listRuns(): PersistedRunState[];
    /** All persisted runs regardless of session (used by cross-session recovery). */
    listAllRuns(): PersistedRunState[];
    /** Explicit dry-run-by-default cleanup for abandoned paused records. */
    prunePausedRuns(options?: {
        before?: Date | string | number;
        maxRuns?: number;
        maxBytes?: number;
        dryRun?: boolean;
    }): import("./run-persistence.js").PausedPruneResult;
    /**
     * Get snapshot of a run.
     */
    getSnapshot(runId: string): WorkflowSnapshot | null;
    /**
     * Delete a persisted run.
     *
     * If `runId` is still live in this process (running or paused-in-memory),
     * abort its controller FIRST, before any teardown below — a live run left
     * un-aborted would otherwise keep executing in the background indefinitely
     * (burning API calls/tokens/holding a worktree) after its record is gone.
     * Aborting first, while `managed` is still `this.runs.get(runId)`, costs
     * nothing extra: the abort signal is fire-and-forget (cooperative — the
     * execution winds down on its own schedule), so the exact instant we flip
     * `this.runs`/release the lease/delete files relative to it doesn't matter
     * for correctness. What DOES matter is that once this method returns, the
     * aborted execution's eventual settle (executeRun's success/catch path,
     * asynchronously, possibly much later) must be a harmless no-op rather than
     * a resurrection — that's what isCurrent() guarantees: `this.runs.delete()`
     * below means executeRun's later persistRun()/releaseRunLease() calls on
     * this same `managed` object find `this.runs.get(runId) !== managed` (in
     * fact `undefined`, since the entry is gone) and skip writing/releasing.
     */
    deleteRun(runId: string): boolean;
    /**
     * Get the persistence layer (for saving workflows).
     */
    getPersistence(): RunPersistence;
    /** Update the in-memory CAS fence after an external side-channel save. */
    syncPersistedRevision(runId: string, revision: number | undefined): void;
}
