import { type TSchema } from "typebox";
import type { AgentUsage } from "./agent.js";
import { type AgentRunOptions, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import { type AgentRegistry } from "./agent-registry.js";
import { WorkflowErrorCode } from "./errors.js";
import { SharedStore } from "./shared-store.js";
import { type AgentTeamSnapshot } from "./agent-team.js";
export interface WorkflowMetaPhase {
    title: string;
    detail?: string;
    model?: string;
}
export interface WorkflowMeta {
    name: string;
    description: string;
    phases?: WorkflowMetaPhase[];
    /** Default model for agents whose phase has no route and that set no model/tier. */
    model?: string;
}
/** One cached agent() result, keyed by its deterministic call index. */
export interface JournalEntry {
    index: number;
    /**
     * The runId of the frame (top-level run, or a nested workflow()'s own run)
     * this entry's `index` is scoped to. A nested workflow() restarts its own
     * callSeq at 0, so `index` alone collides between a parent's and a child's
     * same-numbered calls — see `resumeJournal`'s key format, which namespaces
     * on this the same way SharedStore's deltaKey already does. Absent on
     * journal entries persisted before this field existed; such legacy entries
     * are treated as belonging to the run's own top-level runId (see
     * WorkflowManager.resume()) — a legacy entry that actually belonged to a
     * nested frame simply cache-misses on resume (safe degradation: it re-runs
     * live, it does not apply to the wrong call).
     */
    runId?: string;
    /** sha256 of the call's identity (prompt + model + phase + agentType + schema). */
    hash: string;
    result: unknown;
    /**
     * Per-agent write delta (keys set by this agent) for additive replay on resume.
     * Replaces the former full-map snapshot to fix parallel-agent ordering: applying
     * deltas in callSeq order accumulates all agents' writes correctly regardless of
     * which agent finished first. Absent on older journal entries.
     */
    storeDelta?: Record<string, unknown>;
}
/**
 * Global resources shared across a run and any workflow() nested inside it, so
 * the 16-concurrent / 1000-total caps and the token budget hold across nesting
 * instead of each level getting its own limiter and counters.
 */
export interface SharedRuntime {
    limiter: <T>(fn: () => Promise<T>) => Promise<T>;
    agentCount: number;
    spent: number;
    tokenUsage: {
        input: number;
        output: number;
        total: number;
        cost: number;
        cacheRead: number;
        cacheWrite: number;
    };
    depth: number;
    /**
     * Monotonic count of every workflow() call anywhere in this run tree,
     * regardless of nesting depth — used (instead of `depth`) to build each
     * nested run's runId suffix (see workflowFn below). `depth` alone is NOT
     * enough: it returns to 0 after each nested call finishes, so two
     * SEQUENTIAL nested workflow() calls at the same depth (`await
     * workflow('a'); await workflow('b')`) would otherwise both compute the
     * exact same `${runId}-nested1` suffix. That collision matters because a
     * child's own callSeq restarts at 0, so its deltaKey (`${childRunId}:
     * ${callIndex}`) — the same id used as SharedStore's delta key AND as the
     * onAgentStart/onAgentEnd/onAgentHistory event id (see item 2's identity
     * model) — would collide between the two children's same-callIndex calls.
     * That's a real, not just theoretical, collision risk: an un-awaited
     * stray agent() call from the first child (still in SharedRuntime.inFlight,
     * not yet drained — only the top-level frame drains) can still be pending
     * when the second child starts and mints the very same id.
     */
    nestedCallSeq: number;
    /**
     * Fires exactly once a run-fatal error is determined: an error that escaped
     * the TOP-level script's own execution completely uncaught (see runWorkflow's
     * catch below) — i.e. nothing anywhere in the call chain, at any nesting
     * depth, caught it, so the run really is failing. Shared (not per-nesting-
     * level) so a nested workflow()'s in-flight siblings wind down too, the
     * instant the fate of the WHOLE run is sealed — not the instant any single
     * fan-out rejects, which would break parallel()'s null-on-recoverable-error
     * contract and a script's own try/catch around agent()/workflow(). Every
     * agent() call (this level and any nested workflow()) links its per-attempt
     * AbortController to this signal, alongside the caller's own options.signal,
     * so already-in-flight sibling subagent sessions actually abort instead of
     * running to completion on a run whose outcome is already decided. Wrapped
     * in an AbortController (not a bare boolean) purely so workflow.ts never
     * needs write access to the caller-owned options.signal/AbortController.
     */
    runFatalController: AbortController;
    /**
     * Every logical agent() promise and its provider-attempt promises spawned
     * anywhere in this run (this level's script and nested workflow()s), added on
     * admission and removed on settle. Drained by the TOP-level runWorkflow's
     * finally before the SharedStore is disposed — so forgotten calls and late
     * timed-out-attempt callbacks cannot mutate the store (or report results)
     * after the run has been marked complete and torn down. See the drain below.
     */
    inFlight: Set<Promise<unknown>>;
    /**
     * Frame admission state (FQ-003 / FRAME-CLOSE-001). "open" while the run
     * accepts new work; "closing" once the top-level drain begins (reject new
     * admissions, keep draining already-admitted promises); "closed" after the
     * store is disposed. Every runtime entry point (agent/parallel/pipeline/
     * workflow/team.spawn via trackInFlight, plus helper entry points) rejects
     * once admission is not "open", so a retained VM closure (e.g. a script that
     * stashed `args.late = () => agent(...)`) cannot schedule work or mutate a
     * completed run after the fact.
     */
    admission: "open" | "closing" | "closed";
}
/** Runtime instrumentation for workflow boundaries, quality helpers, and control attempts. */
export type WorkflowRuntimeEvent = {
    type: "phase";
    title: string;
    budget: number | null;
} | {
    type: "workflow";
    stage: "start" | "end";
    name: string;
    args: unknown;
} | {
    type: "quality";
    stage: "start" | "end";
    helper: "verify" | "judgePanel" | "completenessCheck";
} | {
    type: "control-attempt";
    helper: "retry" | "gate";
    attempt: number;
    accepted: boolean;
};
/** Minimal injected agent surface used by the workflow runtime and deterministic tests. */
export interface WorkflowAgentRunner {
    run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
}
export interface WorkflowRunOptions extends WorkflowAgentOptions {
    args?: unknown;
    agent?: WorkflowAgentRunner;
    /** The session's main model (provider/id), shown in /workflows for default agents. */
    mainModel?: string;
    /**
     * Named subagent definitions for `agent({ agentType })`. Snapshotted once per
     * run for determinism. Defaults to scanning `.pi/agents` (project) +
     * `~/.pi/agent/agents` (user, primary) + `~/.pi/agents` (user, deprecated
     * fallback). Injectable for tests.
     */
    agentRegistry?: AgentRegistry;
    concurrency?: number;
    /** Retry attempts after a recoverable agent failure. Default 0. */
    agentRetries?: number;
    tokenBudget?: number | null;
    signal?: AbortSignal;
    /** Maximum number of agents allowed in this run. Default: 1000 */
    maxAgents?: number;
    /** Timeout per agent in milliseconds. null/omitted means no hard timeout. */
    agentTimeoutMs?: number | null;
    /** Whether to persist logs to disk. Default: true */
    persistLogs?: boolean;
    /** Run ID for persistence. Auto-generated if not provided. */
    runId?: string;
    /**
     * Resume: cached agent/checkpoint results keyed by `${runId}:${callIndex}`
     * — the same namespacing SharedStore's deltaKey uses — so a nested
     * workflow() call's callIndex-0 (its callSeq restarts at 0) can never
     * collide with the parent's own callIndex-0 entry. A legacy entry with no
     * `runId` (persisted before namespacing existed) is looked up under the
     * run's own top-level runId only; see `JournalEntry.runId`.
     */
    resumeJournal?: Map<string, JournalEntry>;
    /** Resume: the run being resumed (informational; enables resume mode). */
    resumeFromRunId?: string;
    /** Called after each live agent completes so the caller can persist the journal. */
    onAgentJournal?: (entry: JournalEntry) => void;
    /**
     * Called once per FAILED-AND-RETRIED attempt (not the final attempt of an
     * agent() call, which reports its own tokens via onAgentEnd as before),
     * with that attempt's token cost. recordTokens() already folds a retried
     * attempt's spend into shared.spent/shared.tokenUsage (so the run-wide
     * budget was never leaky) — but onAgentEnd only ever reports the FINAL
     * attempt's tokens, so a caller accumulating a persisted total purely from
     * onAgentEnd (see WorkflowManager) would under-count by exactly the
     * wasted retried attempts' spend. This is a separate, silent channel
     * specifically so retried-attempt spend can be accounted for without
     * changing onAgentEnd's one-call-per-agent-call cadence (a contract other
     * code depends on).
     */
    onRetrySpend?: (tokens: number) => void;
    /** Internal: shared runtime inherited by a nested workflow() call. */
    sharedRuntime?: SharedRuntime;
    /**
     * Seed the FRESH SharedRuntime's cumulative spend/tokenUsage counters from a
     * previously-persisted total (resume()), instead of starting at zero. Used
     * only on the fresh-SharedRuntime branch below — never applied when
     * `sharedRuntime` is supplied (a nested workflow() call inherits the
     * parent's live, already-correct counters and must not be re-seeded).
     * Without this, a resumed run's tokenBudget cap silently resets: it would
     * enforce the ceiling against only what THIS execution spends, ignoring
     * whatever was already spent before the pause.
     */
    initialTokenUsage?: {
        input: number;
        output: number;
        total: number;
        cost: number;
        cacheRead: number;
        cacheWrite: number;
    };
    /**
     * Shared store for this run. One instance is created per top-level run and
     * propagated into nested workflow() calls. Pass an existing instance to share
     * state across a parent and child run; omit to create a fresh isolated store.
     */
    sharedStore?: SharedStore;
    /** Resolve a saved-workflow name to its script, enabling `workflow('name', args)`. */
    loadSavedWorkflow?: (name: string) => string | undefined;
    /**
     * Ask the human a checkpoint() question and resolve to their reply. Threaded from
     * a UI-bearing tool context. Absent => headless: checkpoint() takes its declared
     * default (and journals it), so a detached/background run never hangs.
     */
    confirm?: (promptText: string, options: CheckpointOptions) => Promise<unknown>;
    onLog?: (message: string) => void;
    /**
     * Bridge for the runtime `deliver(message)` global: forwards a workflow-script
     * message into the host conversation. Absent => deliver() no-ops.
     */
    onDeliver?: (message: string) => void | Promise<void>;
    /** Consume host messages before the next live agent() call. */
    takePendingMessages?: () => string[];
    /** Called when a workflow-scoped Agent Team is created. */
    onTeamCreated?: (team: AgentTeamSnapshot) => void;
    onPhase?: (title: string) => void;
    /** Runtime behavior trace used by diagnostics and comprehension evidence. */
    onRuntimeEvent?: (event: WorkflowRuntimeEvent) => void;
    onAgentStart?: (event: {
        id: string;
        label: string;
        phase?: string;
        prompt: string;
        model?: string;
    }) => void;
    /** Register the live child session so the host can send a targeted reply. */
    onAgentSession?: (event: {
        id: string;
        label: string;
        session: {
            sendUserMessage(content: string, options?: {
                deliverAs?: "steer" | "followUp";
            }): Promise<void>;
        };
        send: (message: string) => Promise<void>;
    }) => void;
    /** Remove the live child session after success, failure, or abort. */
    onAgentSessionEnd?: (event: {
        id: string;
        session: {
            sendUserMessage(content: string, options?: {
                deliverAs?: "steer" | "followUp";
            }): Promise<void>;
        };
    }) => void;
    onAgentEnd?: (event: {
        /**
         * Unique per agent() CALL (not per label — concurrent agents routinely
         * share a label, e.g. parallel()'s default `"${phase} agent N"` labels or
         * an author-supplied label reused across a fan-out). Stable across this
         * call's start/end/history events. Callers must key any per-agent
         * bookkeeping on this, never on label, to avoid misattributing a
         * concurrent same-label agent's event to the wrong entry.
         */
        id: string;
        label: string;
        phase?: string;
        result: unknown;
        tokens?: number;
        tokenUsage?: AgentUsage;
        worktree?: string;
        model?: string;
        error?: string;
        errorCode?: WorkflowErrorCode;
        recoverable?: boolean;
        /** True when the result came from the resume journal, not a live session. */
        replayed?: boolean;
    }) => void;
    onAgentHistory?: (event: {
        id: string;
        label: string;
        phase?: string;
        history: AgentHistoryEntry[];
    }) => void;
    onTokenUsage?: (usage: {
        input: number;
        output: number;
        total: number;
        cost: number;
        cacheRead?: number;
        cacheWrite?: number;
    }) => void;
}
export interface WorkflowRunResult<T = unknown> {
    meta: WorkflowMeta;
    result: T;
    logs: string[];
    phases: string[];
    agentCount: number;
    durationMs: number;
    runId?: string;
    tokenUsage?: {
        input: number;
        output: number;
        total: number;
        cost: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
}
export interface AgentOptions<TSchemaDef extends TSchema | undefined = TSchema | undefined> {
    label?: string;
    phase?: string;
    schema?: TSchemaDef;
    /**
     * Run this agent on a specific model (`provider/modelId` or a bare `modelId`).
     * The workflow author chooses per-agent models per the routing policy in the
     * tool guidelines (e.g. a lighter model for exploration, the main model for
     * analysis). When omitted, the session's main model is used.
     */
    model?: string;
    /**
     * Coarse model tier ("small" | "medium" | "big"), resolved from the user's
     * model-tiers config (see /workflows-models). An explicit `model` takes
     * precedence; a tier takes precedence over the phase model. When the tier has
     * no configured entry it falls back to the session's main model.
     */
    tier?: string;
    isolation?: "worktree";
    /**
     * Name of a registered subagent definition (`.pi/agents/<name>.md`, project >
     * user). Binds that definition's tool allow/denylist, model, and body prompt
     * to this agent. An explicit `model` overrides the definition's model; the
     * definition's model overrides `tier`/phase. An unknown name logs a warning
     * and falls back to default tools/model (with the name as a prose hint).
     */
    agentType?: string;
    /** Override timeout for this specific agent. null means no hard timeout. */
    timeoutMs?: number | null;
    /** Retry attempts after a recoverable failure for this specific agent. */
    retries?: number;
    /** Internal workflow-runtime identity for an Agent Team member. */
    teamMember?: string;
}
/** Options for a human checkpoint() — a deterministic, journaled, replayable gate. */
export interface CheckpointOptions {
    /** Reply used when no UI is available (headless/background) and headless != "abort". */
    default?: unknown;
    /** Headless behavior: "default" (take `default`/true) or "abort" (throw). Default "default". */
    headless?: "default" | "abort";
    /** Confirm | free-text input | pick-one. Affects the hash and the UI widget. */
    kind?: "confirm" | "input" | "select";
    /** For kind "select". */
    choices?: string[];
    /** Per-checkpoint timeout in ms for the interactive prompt. */
    timeoutMs?: number;
}
export declare function runWorkflow<T = unknown>(script: string, options?: WorkflowRunOptions): Promise<WorkflowRunResult<T>>;
export declare function parseWorkflowScript(script: string): {
    meta: WorkflowMeta;
    body: string;
};
