/**
 * Workflow manager for background execution, pause/resume, and run management.
 */

import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import type { ModelRegistry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentUsage, WorkflowAgent } from "./agent.js";
import {
  DEFAULT_MAX_PAUSED_BYTES_ON_DISK,
  DEFAULT_MAX_PAUSED_RUNS_IN_MEMORY,
  DEFAULT_MAX_PAUSED_RUNS_ON_DISK,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  MAX_AGENT_PROMPT_BYTES,
  MAX_PENDING_MESSAGE_BYTES,
  MAX_PENDING_MESSAGES,
} from "./config.js";
import { preview, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { isProviderUsageLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import {
  assertSafeRunId,
  createRunPersistence,
  type DeliveryBudgetState,
  generateRunId,
  type PersistedDeliveryRecord,
  type PersistedRunState,
  type RunLease,
  type RunPersistence,
  type RunStatus,
} from "./run-persistence.js";
import { serializeIdentity } from "./safe-serialize.js";
import {
  type JournalEntry,
  parseWorkflowScript,
  runWorkflow,
  type WorkflowRunResult,
  type WorkflowSteeringKind,
  type WorkflowSteeringMessage,
} from "./workflow.js";
import {
  type ExecutionReservation,
  type ResourceDiagnostics,
  WorkflowResourceCoordinator,
  type WorkflowResourceCoordinatorOptions,
} from "./workflow-resource-coordinator.js";

const WORKFLOW_STEERING_KINDS = new Set<WorkflowSteeringKind>([
  "same_task_correction",
  "blocker_answer",
  "changed_fact",
]);

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
  agentTimestamps: Map<number, { startedAt: string; endedAt?: string }>;
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
   * Called lazily per execution (including on resume). An unknown persisted tag
   * is fail-closed: resume throws rather than silently widening the run to the
   * default coding tools.
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
  onDeliver?: (
    message: string,
    source?: {
      runId: string;
      workflowName: string;
      alertKind: "blocker" | "critical_finding" | "decision";
      deliveryId?: string;
      sequence?: number;
    },
  ) => void | Promise<void>;
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
export type WorkflowManagerReloadOptions = Pick<
  WorkflowManagerOptions,
  | "concurrency"
  | "loadSavedWorkflow"
  | "defaultAgentTimeoutMs"
  | "defaultWorkflowTimeoutMs"
  | "defaultAgentRetries"
  | "defaultTokenBudget"
  | "toolsets"
  | "excludeSubagentTools"
  | "persistAgentSessions"
>;

/**
 * Terminal lifecycle statuses. Settled paused runs use a separate bounded
 * retention queue because they remain resumable on disk; an execution that
 * has only published "paused" but is still unwinding is never eligible.
 */
const IN_MEMORY_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

/**
 * How many terminal (completed/failed/aborted) runs' full in-memory state
 * (agents array, journal, snapshot, agentTimestamps) to retain in `runs`
 * before the oldest is evicted. Kept small: a terminal run's data is fully
 * on disk (run-persistence.ts) by the time it's eviction-eligible, so the
 * in-memory copy exists only to serve a `getRun()`/`getSnapshot()` caller
 * that wants the LIVE object (vs. listRuns()'s persisted view) for a run
 * that *just* finished — a handful is enough for that; unbounded retention
 * is exactly the leak this bounds (run-level analog of the subagent
 * memory-retention mitigation in agent.ts).
 */
const DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY = 20;
const MAX_IN_MEMORY_RETENTION = 10_000;
function boundedRetention(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MAX_IN_MEMORY_RETENTION)
    : fallback;
}

/** Explicit deliver() admission budgets. Terminal lifecycle records do not
 * consume these budgets and are always admitted with priority. */
export const MAX_EXPLICIT_DELIVERIES_PER_RUN = 32;
export const MAX_EXPLICIT_DELIVERY_BYTES_PER_RUN = 256 * 1024;
export const MAX_EXPLICIT_DELIVERIES_PER_WINDOW = 8;
export const EXPLICIT_DELIVERY_RATE_WINDOW_MS = 10_000;

function freshDeliveryBudget(now = Date.now()): DeliveryBudgetState {
  return { explicitCount: 0, explicitBytes: 0, windowStartedAt: now, windowCount: 0 };
}

function stableDeliveryId(runId: string, sequence: number): string {
  let left = 2166136261;
  let right = 0x9e3779b9;
  const value = `${runId}:${sequence}`;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ (code + i), 2246822519);
  }
  return `wf_${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

export class WorkflowManager extends EventEmitter {
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
  private runs = new Map<string, ManagedRun>();
  /**
   * FIFO of runIds that reached IN_MEMORY_TERMINAL_STATUSES, oldest first —
   * the eviction order for `runs` (see its doc comment). A runId can appear
   * more than once (e.g. resumed after eviction, then terminates again);
   * evicting is idempotent (recordTerminalRun() re-checks the CURRENT status
   * of the current map entry for that id before deleting), so duplicates
   * are harmless.
   */
  private terminalRunQueue: string[] = [];
  /** Settled paused generations, not just runIds: a stale queue entry from a
   * prior resume must never evict the current generation for the same runId. */
  private pausedRunQueue: ManagedRun[] = [];
  private maxTerminalRunsInMemory: number;
  private maxPausedRunsInMemory: number;
  private activitySeq = 0;
  private persistence: RunPersistence;
  private cwd: string;
  private concurrency: number;
  private loadSavedWorkflow?: (name: string) => string | undefined;
  private agent?: Pick<WorkflowAgent, "run">;
  /** The session's main model (provider/id), for auto-tiering explore agents. */
  private mainModel?: string;
  /** The host Pi session's model registry, shared with subagents. */
  private modelRegistry?: ModelRegistry;
  /** The current pi session id; runs are stamped with it and listRuns() filters by it. */
  private sessionId?: string;
  private defaultAgentTimeoutMs: number | null;
  private defaultWorkflowTimeoutMs: number;
  private defaultAgentRetries: number;
  private defaultTokenBudget: number | null;
  private toolsets?: Record<string, () => ToolDefinition[]>;
  private excludeSubagentTools?: string[];
  private persistAgentSessions: boolean;
  private readonly resources: WorkflowResourceCoordinator;
  private readonly resourceNamespace: string;
  private readonly maxPausedRunsOnDisk: number;
  private readonly ownedWorktreeTokens = new Set<string>();
  private readonly maxPausedBytesOnDisk: number;
  /** Runtime deliver() bridge; refreshed by host wiring each generation. */
  onDeliver?: WorkflowManagerOptions["onDeliver"];
  /** Optional host observer for live subagent results; not provider delivery by default. */
  onAgentMessage?: WorkflowManagerOptions["onAgentMessage"];
  private pendingMessages = new Map<string, WorkflowSteeringMessage[]>();
  private pendingMessageCount = 0;
  private pendingMessageBytes = 0;
  private activeAgentSenders = new Map<
    string,
    {
      runId: string;
      managed: ManagedRun;
      session: { sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> };
      send: (message: string, kind: WorkflowSteeringKind) => Promise<void>;
    }
  >();

  constructor(options: WorkflowManagerOptions = {}) {
    super();
    this.cwd = options.cwd ?? process.cwd();
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.agent = options.agent;
    this.mainModel = options.mainModel;
    this.modelRegistry = options.modelRegistry;
    this.sessionId = options.sessionId;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultWorkflowTimeoutMs = options.defaultWorkflowTimeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultTokenBudget = options.defaultTokenBudget ?? null;
    this.toolsets = options.toolsets;
    this.excludeSubagentTools = options.excludeSubagentTools;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
    this.maxPausedRunsOnDisk = Math.max(1, Math.floor(options.maxPausedRunsOnDisk ?? DEFAULT_MAX_PAUSED_RUNS_ON_DISK));
    this.maxPausedBytesOnDisk = Math.max(
      1,
      Math.floor(options.maxPausedBytesOnDisk ?? DEFAULT_MAX_PAUSED_BYTES_ON_DISK),
    );
    this.resourceNamespace = options.resourceNamespace ?? `${resolve(this.cwd)}:${generateRunId()}`;
    this.resources =
      options.resourceCoordinator ??
      new WorkflowResourceCoordinator({
        ...options.resourceLimits,
        maxActiveExecutions: options.maxActiveExecutions ?? options.resourceLimits?.maxActiveExecutions,
        maxProviderConcurrency: options.maxProviderConcurrency ?? options.resourceLimits?.maxProviderConcurrency,
        maxQueuedProviderAttempts:
          options.maxQueuedProviderAttempts ?? options.resourceLimits?.maxQueuedProviderAttempts,
        maxLateAttempts: options.maxLateAttempts ?? options.resourceLimits?.maxLateAttempts,
      });
    this.onDeliver = options.onDeliver;
    this.onAgentMessage = options.onAgentMessage;
    this.maxTerminalRunsInMemory = boundedRetention(
      options.maxTerminalRunsInMemory,
      DEFAULT_MAX_TERMINAL_RUNS_IN_MEMORY,
    );
    this.maxPausedRunsInMemory = boundedRetention(options.maxPausedRunsInMemory, DEFAULT_MAX_PAUSED_RUNS_IN_MEMORY);
    this.persistence = createRunPersistence(this.cwd);
    this.recoverStaleRuns();
  }

  /** Mark a generation as blocked on durable publication without reopening it.
   * An aborted controller cannot be restarted, so restoring `running` here
   * would leave a ghost entry that rejects both resume and new work. */
  private markPersistenceBlocked(managed: ManagedRun): void {
    managed.persistenceBlocked = true;
    managed.error = new WorkflowError(
      "Workflow state could not be durably published",
      WorkflowErrorCode.PERSISTENCE_ERROR,
      { recoverable: true },
    );
    // A stop can reach this path after the execution has already settled (for
    // example, a usage-limit paused run). Do not leave its lease, senders, or
    // pending-message queue behind just because the final write failed.
    if (managed.executionSettled === true) this.cleanupSettledGeneration(managed);
  }

  /** Bind the manager to the current pi session, so new runs are tagged with it and
   * the navigator/task-panel show only this session's runs (set on session_start). */
  setSessionId(id: string | undefined): void {
    this.sessionId = id;
  }

  /** Current Pi session binding used for ownership-scoped lifecycle actions. */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Queue a host-session message for one explicitly identified running workflow. */
  enqueueUserMessage(message: string, runId: string, kind: WorkflowSteeringKind): string | undefined {
    assertSafeRunId(runId);
    if (!WORKFLOW_STEERING_KINDS.has(kind)) return undefined;
    const text = message.trim();
    if (!text || text.length > 100_000) return undefined;
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return undefined;
    const queue = this.pendingMessages.get(managed.runId) ?? [];
    const queuedBytes = queue.reduce((total, item) => total + Buffer.byteLength(item.message, "utf8"), 0);
    const aggregateCount = this.pendingMessageCount;
    const aggregateBytes = this.pendingMessageBytes;
    const textBytes = Buffer.byteLength(text, "utf8");
    if (queue.length >= 256 || queuedBytes + textBytes > 1_000_000) return undefined;
    if (aggregateCount >= MAX_PENDING_MESSAGES || aggregateBytes + textBytes > MAX_PENDING_MESSAGE_BYTES)
      return undefined;
    queue.push({ message: text, kind });
    this.pendingMessageCount++;
    this.pendingMessageBytes += textBytes;
    this.pendingMessages.set(managed.runId, queue);
    return managed.runId;
  }

  /** Atomically take messages queued for a run before its next agent() call. */
  takePendingMessages(runId: string): WorkflowSteeringMessage[] {
    assertSafeRunId(runId);
    const messages = this.pendingMessages.get(runId) ?? [];
    this.dropPendingMessages(runId);
    return messages;
  }

  private dropPendingMessages(runId: string): void {
    const messages = this.pendingMessages.get(runId);
    if (!messages) return;
    this.pendingMessages.delete(runId);
    this.pendingMessageCount = Math.max(0, this.pendingMessageCount - messages.length);
    this.pendingMessageBytes = Math.max(
      0,
      this.pendingMessageBytes - messages.reduce((sum, item) => sum + Buffer.byteLength(item.message, "utf8"), 0),
    );
  }

  /** Send immediately to a child in one explicitly identified running workflow. */
  async sendToAgent(
    message: string,
    agentId: string,
    runId: string,
    kind: WorkflowSteeringKind,
  ): Promise<string | undefined> {
    assertSafeRunId(runId);
    if (!WORKFLOW_STEERING_KINDS.has(kind)) return undefined;
    const target = this.activeAgentSenders.get(agentId);
    if (
      !target ||
      target.runId !== runId ||
      this.runs.get(target.runId) !== target.managed ||
      target.managed.status !== "running"
    )
      return undefined;
    try {
      await target.send(message, kind);
      return target.runId;
    } catch {
      return undefined;
    }
  }

  /** Project cwd this manager was constructed for (persistence + agent tools). */
  getCwd(): string {
    return this.cwd;
  }

  /**
   * Every live in-memory run, regardless of the navigator's session filter.
   * Stranded-pause / cross-session recovery must use this — listRuns() hides
   * runs whose frozen sessionId no longer matches the bound session.
   */
  listLiveRuns(): ManagedRun[] {
    return [...this.runs.values()];
  }

  /**
   * After an in-process session replacement keeps this manager, re-home every
   * still-running (or paused-in-memory) run onto the new session so the panel,
   * workflow_control, and a later stranded-pause all see them. Completed runs
   * keep their original sessionId so history stays with the session that ran
   * them. No-op when `sessionId` is undefined.
   */
  adoptLiveRunsToSession(sessionId: string | undefined): number {
    if (!sessionId) return 0;
    let adopted = 0;
    for (const managed of this.runs.values()) {
      if (managed.status !== "running" && managed.status !== "paused") continue;
      if (managed.sessionId === sessionId) continue;
      managed.sessionId = sessionId;
      this.persistRun(managed);
      adopted++;
    }
    return adopted;
  }

  /**
   * On startup, any persisted run still marked "running" belongs to a process
   * that died mid-run (this fresh manager has it nowhere in memory). Reconcile it
   * to "paused" — never "failed" — so its journal is preserved and resume() can
   * replay the completed prefix and finish the rest.
   */
  private recoverStaleRuns(): void {
    for (const p of this.listAllRuns()) {
      if (this.sessionId && p.sessionId !== this.sessionId) continue;
      if (p.status === "running" && !this.runs.has(p.runId)) {
        try {
          const lease = this.persistence.acquireRunLease(p.runId);
          if (!lease) continue;
          try {
            // Re-read while holding the lease: the scan snapshot may already be
            // obsolete because another process completed/stopped this run.
            const fresh = this.persistence.load(p.runId);
            if (fresh?.status === "running") {
              this.persistence.save({ ...fresh, status: "paused" }, fresh.revision, lease);
            }
          } finally {
            this.persistence.releaseRunLease(lease);
          }
        } catch {
          // RECOVERY-SCAN-FAILFAST: one stale run's persistence failure must
          // not abort recovery of later crash-orphaned runs.
        }
      }
    }
  }

  /**
   * Refresh host configuration after Pi reloads the extension while retaining
   * this manager's live runs, controllers, leases, and event listeners.
   * Existing executions keep the options they captured at start; subsequent
   * runs and resumes use these refreshed defaults.
   */
  reconfigureAfterReload(options: WorkflowManagerReloadOptions): void {
    this.concurrency = options.concurrency ?? 8;
    this.loadSavedWorkflow = options.loadSavedWorkflow;
    this.defaultAgentTimeoutMs = options.defaultAgentTimeoutMs ?? null;
    this.defaultWorkflowTimeoutMs = options.defaultWorkflowTimeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS;
    this.defaultAgentRetries = options.defaultAgentRetries ?? 0;
    this.defaultTokenBudget = options.defaultTokenBudget ?? null;
    this.toolsets = options.toolsets;
    this.excludeSubagentTools = options.excludeSubagentTools;
    this.persistAgentSessions = options.persistAgentSessions ?? false;
  }

  /** Set the session's main model (provider/id). Used to auto-tier explore agents. */
  setMainModel(spec: string | undefined): void {
    this.mainModel = spec;
  }

  /** Set the host session's model registry so subagents resolve models consistently. */
  setModelRegistry(registry: ModelRegistry): void {
    this.modelRegistry = registry;
  }

  /**
   * Expose the host session's model registry to integrations sharing this
   * manager. Workflow execution reads the same registry internally.
   */
  getModelRegistry(): ModelRegistry | undefined {
    return this.modelRegistry;
  }

  /**
   * Start a workflow in the background.
   * Returns immediately with a run ID; the workflow executes asynchronously.
   */
  startInBackground(
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): { runId: string; promise: Promise<WorkflowRunResult> } {
    const parsed = parseWorkflowScript(script);
    const admittedArgs = this.admitArgs(args);
    this.assertPausedDurableCapacity();
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    const executionGeneration = generateRunId();
    const resourceExecutionReservation = this.resources.acquireExecution(
      runId,
      this.resourceNamespace,
      executionGeneration,
    );
    if (!resourceExecutionReservation) {
      throw new WorkflowError(
        "Maximum active workflow execution capacity has been reached",
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const controller = new AbortController();
    let lease: RunLease | null;
    try {
      lease = this.persistence.acquireRunLease(runId);
    } catch (error) {
      this.resources.releaseExecution(resourceExecutionReservation);
      throw error;
    }
    if (!lease) {
      this.resources.releaseExecution(resourceExecutionReservation);
      throw new Error(`Could not acquire workflow run lease for ${runId}`);
    }

    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller,
      startedAt: new Date(),
      script,
      args: admittedArgs,
      journal: [],
      background: true,
      sessionId: this.sessionId,
      lease,
      autoResume: exec.autoResume,
      // Resolve the budget once at start and freeze it on the run (see
      // ManagedRun.tokenBudget) so resume keeps start-time semantics.
      tokenBudget: exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget,
      toolset: exec.toolset,
      // Same freeze-at-start pattern as tokenBudget, for the same reason: a
      // resumed run must keep these values, not re-resolve against the
      // manager's current defaults (see ManagedRun doc comments).
      maxAgents: exec.maxAgents,
      agentTimeoutMs: exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs,
      workflowTimeoutMs: exec.workflowTimeoutMs ?? this.defaultWorkflowTimeoutMs,
      concurrency: exec.concurrency !== undefined ? exec.concurrency : this.concurrency,
      agentRetries: exec.agentRetries !== undefined ? exec.agentRetries : this.defaultAgentRetries,
      activitySeq: ++this.activitySeq,
      agentTimestamps: new Map(),
      agentsById: new Map(),
      executionSettled: false,
      resourceExecutionHeld: true,
      resourceExecutionReservation,
      executionGeneration,
      deliveryOutbox: [],
      nextDeliverySequence: 0,
      deliveryBudget: freshDeliveryBudget(),
    };

    this.runs.set(runId, managed);

    try {
      // Persist initial state under the lease; save() assigns the first durable
      // revision, which every later write carries as its CAS fence.
      const initialState: PersistedRunState = {
        runId,
        workflowName: parsed.meta.name,
        script,
        args: admittedArgs,
        sessionId: managed.sessionId,
        status: "running",
        phases: managed.snapshot.phases,
        agents: [],
        logs: [],
        startedAt: managed.startedAt.toISOString(),
        updatedAt: managed.startedAt.toISOString(),
        autoResume: managed.autoResume,
        tokenBudget: managed.tokenBudget,
        toolset: managed.toolset,
        maxAgents: managed.maxAgents,
        agentTimeoutMs: managed.agentTimeoutMs,
        workflowTimeoutMs: managed.workflowTimeoutMs,
        concurrency: managed.concurrency,
        agentRetries: managed.agentRetries,
        deliveryOutbox: managed.deliveryOutbox,
        nextDeliverySequence: managed.nextDeliverySequence,
        deliveryBudget: managed.deliveryBudget,
      };
      this.persistence.save(initialState, undefined, lease);
      managed.revision = initialState.revision;
    } catch (err) {
      this.releaseRunLease(managed);
      this.releaseExecutionCapacity(managed);
      this.runs.delete(runId);
      throw err;
    }

    // Run workflow asynchronously.
    // Attach a side-channel catch to prevent Node.js unhandled-rejection crashes
    // when a workflow is aborted/paused/stopped — executeRun()'s catch block
    // already records status/event/persist, but the promise still rejects.
    // The original promise is returned so callers can await it in try/catch.
    managed.executionSettled = false;
    const promise = this.executeRun(managed, script, admittedArgs, exec);
    managed.execution = promise;
    void promise
      .finally(() => {
        managed.executionSettled = true;
      })
      .catch(() => {});
    promise.catch(() => {});

    return { runId, promise };
  }

  /**
   * Execute a workflow synchronously (blocking) while still tracking it like a
   * background run, so the `/workflows` navigator and the live task panel see it.
   * `onProgress` fires on every progress event with the current snapshot, letting
   * a caller (e.g. the workflow tool) drive its own inline display.
   */
  async runSync(script: string, args?: unknown, exec: ExecOptions = {}): Promise<WorkflowRunResult> {
    const admittedArgs = this.admitArgs(args);
    this.assertPausedDurableCapacity();
    const managed = this.createManaged(script, admittedArgs);
    const executionGeneration = generateRunId();
    const resourceExecutionReservation = this.resources.acquireExecution(
      managed.runId,
      this.resourceNamespace,
      executionGeneration,
    );
    if (!resourceExecutionReservation) {
      throw new WorkflowError(
        "Maximum active workflow execution capacity has been reached",
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    managed.resourceExecutionHeld = true;
    managed.resourceExecutionReservation = resourceExecutionReservation;
    managed.executionGeneration = executionGeneration;
    let lease: RunLease | null;
    try {
      lease = this.persistence.acquireRunLease(managed.runId);
    } catch (error) {
      this.resources.releaseExecution(resourceExecutionReservation);
      throw error;
    }
    if (!lease) {
      this.resources.releaseExecution(resourceExecutionReservation);
      throw new Error(`Could not acquire workflow run lease for ${managed.runId}`);
    }
    managed.lease = lease;
    managed.autoResume = exec.autoResume;
    managed.tokenBudget = exec.tokenBudget !== undefined ? exec.tokenBudget : this.defaultTokenBudget;
    managed.toolset = exec.toolset;
    // Same freeze-at-start pattern as tokenBudget (see startInBackground/ManagedRun).
    managed.maxAgents = exec.maxAgents;
    managed.agentTimeoutMs = exec.agentTimeoutMs !== undefined ? exec.agentTimeoutMs : this.defaultAgentTimeoutMs;
    managed.workflowTimeoutMs = exec.workflowTimeoutMs ?? this.defaultWorkflowTimeoutMs;
    managed.concurrency = exec.concurrency !== undefined ? exec.concurrency : this.concurrency;
    managed.agentRetries = exec.agentRetries !== undefined ? exec.agentRetries : this.defaultAgentRetries;
    this.runs.set(managed.runId, managed);
    // Persist the initial state immediately so listRuns()/the task panel can see
    // the run the moment it starts, not only after the first agent journals.
    // This is a brand-new record: save() assigns revision 1. Using persistRun()
    // here with a pre-filled revision would CAS against a file that does not yet
    // exist and leave every subsequent lifecycle write fenced to a phantom rev.
    try {
      const initialState = this.persistedStateFor(managed);
      this.persistence.save(initialState, undefined, lease);
      managed.revision = initialState.revision;
    } catch (err) {
      this.releaseRunLease(managed);
      this.releaseExecutionCapacity(managed);
      this.runs.delete(managed.runId);
      throw err;
    }
    // Mark pending before invoking the async function: executeRun can reject
    // synchronously up to its first await, and stop() may observe the run in
    // that same turn.
    managed.executionSettled = false;
    const execution = this.executeRun(managed, script, admittedArgs, exec);
    managed.execution = execution;
    void execution
      .finally(() => {
        managed.executionSettled = true;
      })
      .catch(() => {});
    return execution;
  }

  private assertPausedDurableCapacity(): void {
    const durable = this.persistence.getResourceDiagnostics();
    if (durable.pausedRunCount >= this.maxPausedRunsOnDisk || durable.pausedRunBytes >= this.maxPausedBytesOnDisk) {
      throw new WorkflowError(
        "Paused durable-run capacity is exhausted; explicitly prune old paused runs before starting more",
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
  }

  private admitArgs(args: unknown): unknown {
    if (args === undefined) return undefined;
    try {
      const json = serializeIdentity(args, {
        maxBytes: MAX_AGENT_PROMPT_BYTES,
        maxItems: 100_000,
        maxNodes: 100_000,
        maxDepth: 128,
        maxStringBytes: MAX_AGENT_PROMPT_BYTES,
      });
      return JSON.parse(json);
    } catch (error) {
      throw new WorkflowError(
        `Workflow args must be finite plain JSON within ${MAX_AGENT_PROMPT_BYTES} UTF-8 bytes: ${error instanceof Error ? error.message : String(error)}`,
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
  }

  /** Build a fresh managed run with an empty snapshot. */
  private createManaged(script: string, args?: unknown): ManagedRun {
    const parsed = parseWorkflowScript(script);
    const slug = parsed.meta.name
      ? parsed.meta.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "workflow"
      : "";
    const runId = slug ? `${slug}-${generateRunId()}` : generateRunId();
    return {
      runId,
      status: "running",
      snapshot: {
        name: parsed.meta.name,
        description: parsed.meta.description,
        phases: parsed.meta.phases?.map((p) => p.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
      },
      controller: new AbortController(),
      startedAt: new Date(),
      script,
      args,
      journal: [],
      background: false,
      sessionId: this.sessionId,
      activitySeq: ++this.activitySeq,
      agentTimestamps: new Map(),
      agentsById: new Map(),
      executionSettled: false,
      deliveryOutbox: [],
      nextDeliverySequence: 0,
      deliveryBudget: freshDeliveryBudget(),
    };
  }

  /** Admit an explicit deliver() call into the durable outbox. The counters
   * are cumulative for the run, while the sliding window bounds continuation
   * storms. Terminal notifications intentionally bypass this admission path. */
  private admitExplicitDelivery(
    managed: ManagedRun,
    message: string,
    alertKind: "blocker" | "critical_finding" | "decision",
  ): PersistedDeliveryRecord {
    const content = typeof message === "string" ? message : String(message ?? "");
    const bytes = Buffer.byteLength(content, "utf8");
    const now = Date.now();
    const budget = managed.deliveryBudget;
    if (now - budget.windowStartedAt >= EXPLICIT_DELIVERY_RATE_WINDOW_MS) {
      budget.windowStartedAt = now;
      budget.windowCount = 0;
    }
    if (
      budget.explicitCount >= MAX_EXPLICIT_DELIVERIES_PER_RUN ||
      budget.explicitBytes + bytes > MAX_EXPLICIT_DELIVERY_BYTES_PER_RUN ||
      budget.windowCount >= MAX_EXPLICIT_DELIVERIES_PER_WINDOW
    ) {
      throw new WorkflowError(
        "Explicit delivery budget exceeded; terminal lifecycle delivery remains reserved",
        WorkflowErrorCode.DELIVERY_BUDGET_EXCEEDED,
        { recoverable: true },
      );
    }
    const sequence = managed.nextDeliverySequence++;
    const delivery: PersistedDeliveryRecord = {
      deliveryId: stableDeliveryId(managed.runId, sequence),
      sequence,
      kind: "explicit",
      status: "pending",
      content,
      alertKind,
      createdAt: new Date(now).toISOString(),
    };
    budget.explicitCount++;
    budget.explicitBytes += bytes;
    budget.windowCount++;
    managed.deliveryOutbox.push(delivery);
    try {
      this.persistRunStrict(managed);
    } catch (error) {
      managed.deliveryOutbox.pop();
      managed.nextDeliverySequence--;
      budget.explicitCount--;
      budget.explicitBytes -= bytes;
      budget.windowCount--;
      throw error;
    }
    return delivery;
  }

  /** Reserve one terminal record before publishing terminal state. It is
   * idempotent, so duplicate lifecycle events cannot create duplicate wakes. */
  private ensureTerminalDelivery(managed: ManagedRun): PersistedDeliveryRecord | undefined {
    if (!managed.background || (managed.status !== "completed" && managed.status !== "failed")) return undefined;
    const existing = managed.deliveryOutbox.find((item) => item.terminal);
    if (existing) return existing;
    const sequence = managed.nextDeliverySequence++;
    const delivery: PersistedDeliveryRecord = {
      deliveryId: stableDeliveryId(managed.runId, sequence),
      sequence,
      kind: "terminal",
      status: "pending",
      terminal: true,
      createdAt: new Date().toISOString(),
    };
    managed.deliveryOutbox.push(delivery);
    return delivery;
  }

  /** Reserve a replayable usage-limit checkpoint before publishing `paused`.
   * Unlike a terminal record it remains historical if the run later resumes. */
  private ensurePausedDelivery(managed: ManagedRun, error: WorkflowError): PersistedDeliveryRecord | undefined {
    if (!managed.background || managed.status !== "paused") return undefined;
    const existing = managed.deliveryOutbox.find((item) => item.checkpoint === "paused");
    if (existing) return existing;
    const sequence = managed.nextDeliverySequence++;
    const when = error.resetHint ? ` (${error.resetHint})` : "";
    const delivery: PersistedDeliveryRecord = {
      deliveryId: stableDeliveryId(managed.runId, sequence),
      sequence,
      kind: "terminal",
      status: "pending",
      checkpoint: "paused",
      content:
        `⏸ Background workflow ${managed.runId} paused: ${error.message}${when}. ` +
        `Completed steps are saved — run /workflows resume ${managed.runId} once your usage limit resets.`,
      createdAt: new Date().toISOString(),
    };
    managed.deliveryOutbox.push(delivery);
    return delivery;
  }

  private persistRunStrict(managed: ManagedRun): void {
    if (!this.isCurrent(managed))
      throw new WorkflowError("Workflow execution is stale", WorkflowErrorCode.PERSISTENCE_ERROR);
    const timer = this.persistTimers.get(managed.runId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(managed.runId);
    }
    if (!this.writeRunToDisk(managed, true)) {
      throw new WorkflowError("Could not durably persist workflow delivery", WorkflowErrorCode.PERSISTENCE_ERROR, {
        recoverable: true,
      });
    }
  }

  /** Durable outbox records awaiting provider inclusion or acknowledgement.
   * This reads disk so reloads and evicted terminal runs are replayable. */
  listPendingDeliveries(): Array<
    PersistedDeliveryRecord & { runId: string; workflowName: string; runStatus: RunStatus }
  > {
    const pending: Array<PersistedDeliveryRecord & { runId: string; workflowName: string; runStatus: RunStatus }> = [];
    for (const state of this.listAllRuns()) {
      if (this.sessionId && state.sessionId !== this.sessionId) continue;
      for (const delivery of state.deliveryOutbox ?? []) {
        pending.push({ ...delivery, runId: state.runId, workflowName: state.workflowName, runStatus: state.status });
      }
    }
    return pending;
  }

  /** Mark an in-memory-only delivery (no durable outbox record) as admitted by
   * the host session for the given bridge generation. Returns false when the
   * generation is stale. Outbox-backed deliveries use acknowledgeDelivery(). */
  markDeliverySubmitted(deliveryId: string, generation: number): boolean {
    if (!this.bridgeDeliveryState) this.bridgeDeliveryState = new Map();
    const existing = this.bridgeDeliveryState.get(deliveryId);
    if (existing !== undefined && generation < existing) return false;
    this.bridgeDeliveryState.set(deliveryId, generation);
    // Bounded map: admission markers are short-lived same-generation evidence.
    while (this.bridgeDeliveryState.size > 1024) {
      const oldest = this.bridgeDeliveryState.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bridgeDeliveryState.delete(oldest);
    }
    return true;
  }

  /** Drop a durable outbox record the user has seen and dismissed (Esc), or
   * whose merged batch was acknowledged. Generation-independent: identity is
   * the stable delivery ID. In-memory CAS failure is non-fatal (the in-memory
   * dedup pin still prevents a resend); persisted-state failure returns false. */
  discardDelivery(runId: string, deliveryId: string): boolean {
    assertSafeRunId(runId);
    const managed = this.runs.get(runId);
    if (managed) {
      const index = managed.deliveryOutbox.findIndex((item) => item.deliveryId === deliveryId);
      if (index < 0) return true;
      const [removed] = managed.deliveryOutbox.splice(index, 1);
      try {
        this.persistRunStrict(managed);
        return true;
      } catch {
        managed.deliveryOutbox.splice(Math.min(index, managed.deliveryOutbox.length), 0, removed!);
        return false;
      }
    }
    const state = this.persistence.load(runId);
    if (!this.ownsPersistedRun(state) || !state) return false;
    const target = (state.deliveryOutbox ?? []).find((item) => item.deliveryId === deliveryId);
    if (!target) return true;
    state.deliveryOutbox = (state.deliveryOutbox ?? []).filter((item) => item.deliveryId !== deliveryId);
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      const fresh = this.persistence.load(runId);
      if (!fresh || fresh.revision !== state.revision) return false;
      this.persistence.save(state, state.revision, lease);
      return true;
    } catch {
      return false;
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

  /** Advance outbox state under the run's CAS/lease fence. Generation is
   * checked on every transition and never changes logical delivery identity. */
  acknowledgeDelivery(
    runId: string,
    deliveryId: string,
    generation: number,
    phase: "submitted" | "projected" | "acknowledged",
  ): boolean {
    assertSafeRunId(runId);
    const managed = this.runs.get(runId);
    const state = managed ? undefined : this.persistence.load(runId);
    if (!managed && !this.ownsPersistedRun(state)) return false;
    const target = managed
      ? managed.deliveryOutbox.find((item) => item.deliveryId === deliveryId)
      : state?.deliveryOutbox?.find((item) => item.deliveryId === deliveryId);
    if (!target) return false;
    if (phase === "submitted") {
      if (generation < (target.generation ?? 0)) return false;
    } else if (target.generation !== generation) {
      return false;
    }
    if (managed) {
      const previousOutbox = managed.deliveryOutbox;
      const previousTarget = { ...target };
      if (phase === "acknowledged") {
        managed.deliveryOutbox = managed.deliveryOutbox.filter((item) => item.deliveryId !== deliveryId);
      } else {
        target.generation = generation;
        target.status = phase === "submitted" && target.status === "projected" ? target.status : phase;
      }
      try {
        this.persistRunStrict(managed);
        return true;
      } catch {
        managed.deliveryOutbox = previousOutbox;
        const rollback = managed.deliveryOutbox.find((item) => item.deliveryId === deliveryId);
        if (rollback) Object.assign(rollback, previousTarget);
        return false;
      }
    }
    target.generation = generation;
    if (phase === "submitted") target.status = target.status === "projected" ? target.status : "submitted";
    else if (phase === "projected") target.status = "projected";
    else if (state)
      state.deliveryOutbox = (state.deliveryOutbox ?? []).filter((item) => item.deliveryId !== deliveryId);
    if (!state) return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      const fresh = this.persistence.load(runId);
      if (!fresh || fresh.revision !== state.revision) return false;
      this.persistence.save(state, state.revision, lease);
      return true;
    } catch {
      return false;
    } finally {
      this.persistence.releaseRunLease(lease);
    }
  }

  private async executeRun(
    managed: ManagedRun,
    script: string,
    args?: unknown,
    exec: ExecOptions = {},
  ): Promise<WorkflowRunResult> {
    const {
      resumeJournal,
      maxAgents,
      agentTimeoutMs,
      externalSignal,
      onProgress,
      tokenBudget,
      concurrency,
      agentRetries,
      workflowTimeoutMs,
      confirm,
      tools,
      initialTokenUsage,
    } = exec;
    // Every callback below is bound to this execution generation. A stale
    // generation may still finish after pause/resume, but it must not admit
    // new manager-owned sessions or worktree ownership into the replacement.
    const executionGeneration = managed.executionGeneration;
    // maxAgents/agentTimeoutMs/concurrency/agentRetries were resolved (per-run
    // value, else the manager default at the time) and frozen on the managed
    // run at start/resume (see ManagedRun doc comments) — read them from there
    // first, exactly like resolvedTokenBudget below, so a resumed run keeps the
    // values it started with instead of re-resolving against the manager's
    // CURRENT defaults. The exec.* fallbacks are a safety net for direct
    // executeRun callers that skipped the start paths (same rationale as
    // resolvedTokenBudget's tokenBudget fallback).
    const resolvedMaxAgents = managed.maxAgents !== undefined ? managed.maxAgents : maxAgents;
    const resolvedAgentTimeoutMs =
      managed.agentTimeoutMs !== undefined
        ? managed.agentTimeoutMs
        : agentTimeoutMs !== undefined
          ? agentTimeoutMs
          : this.defaultAgentTimeoutMs;
    const resolvedConcurrency =
      managed.concurrency !== undefined ? managed.concurrency : (concurrency ?? this.concurrency);
    const resolvedAgentRetries =
      managed.agentRetries !== undefined ? managed.agentRetries : (agentRetries ?? this.defaultAgentRetries);
    const resolvedWorkflowTimeoutMs = managed.workflowTimeoutMs ?? workflowTimeoutMs ?? this.defaultWorkflowTimeoutMs;
    // The budget was resolved (per-run value, else defaultTokenBudget) and frozen
    // on the managed run at start/resume — read it from there so a resumed run
    // keeps the budget it started with. exec.tokenBudget is a safety net for
    // direct executeRun callers that skipped the start paths.
    const resolvedTokenBudget = managed.tokenBudget !== undefined ? managed.tokenBudget : (tokenBudget ?? null);
    // Explicit tools win for this execution; else re-resolve the run's persisted
    // toolset tag (how a resumed /deep-research keeps its web tools); else the
    // agent layer's default coding tools.
    // Gated the same way as this.emitLive() below (see isCurrent()) — a stale
    // execution's progress callback would otherwise keep driving live UI
    // (task panel, etc.) for a run that's been superseded or deleted.
    const progress = () => {
      if (this.isCurrent(managed)) onProgress?.(managed.snapshot);
    };
    // Let a host abort (e.g. Esc during a blocking tool call) cancel this run.
    let removeExternalAbort: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) managed.controller.abort();
      else {
        const onExternalAbort = () => managed.controller.abort();
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
        removeExternalAbort = () => externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
    try {
      const resolvedTools =
        tools ??
        (managed.toolset
          ? (() => {
              // Own-property lookup: a persisted tag like "constructor"/"toString"
              // would otherwise resolve through Object.prototype and bypass the
              // unknown-tag fail-closed check below.
              const hasToolset = Object.hasOwn(this.toolsets ?? {}, managed.toolset);
              const resolveToolset = hasToolset ? this.toolsets?.[managed.toolset] : undefined;
              if (typeof resolveToolset !== "function") {
                throw new WorkflowError(
                  `Unknown persisted workflow toolset "${managed.toolset}"; cannot resume safely`,
                  WorkflowErrorCode.PERSISTENCE_ERROR,
                  { recoverable: false, details: { toolset: managed.toolset } },
                );
              }
              const resolved = resolveToolset();
              if (!Array.isArray(resolved)) {
                throw new WorkflowError(
                  `Persisted workflow toolset "${managed.toolset}" resolved to no tools; cannot resume safely`,
                  WorkflowErrorCode.PERSISTENCE_ERROR,
                  { recoverable: false, details: { toolset: managed.toolset } },
                );
              }
              return resolved;
            })()
          : undefined);
      const result = await runWorkflow(script, {
        cwd: this.cwd,
        args,
        // Use the managed run's persisted id as the workflow runId so the value
        // returned in result.runId matches the id that listRuns()/resume() use.
        // Otherwise runWorkflow mints an ephemeral `run-<ts>` id and the sync
        // path would surface a non-resumable id to the model.
        runId: managed.runId,
        worktreeOwner: managed.executionGeneration,
        resourceGeneration: managed.executionGeneration,
        onWorktreeOwner: ({ token, active, generation }) => {
          // A late old-generation cleanup may safely remove its own opaque
          // token, but an old generation must never add ownership after
          // pause/resume/delete has replaced or closed the live run.
          if (!active) {
            this.ownedWorktreeTokens.delete(token);
            return;
          }
          if (
            this.isCurrent(managed) &&
            managed.status === "running" &&
            managed.executionGeneration === executionGeneration &&
            generation === executionGeneration
          ) {
            this.ownedWorktreeTokens.add(token);
          }
        },
        agent: this.agent,
        mainModel: this.mainModel,
        modelRegistry: this.modelRegistry,
        persistAgentSessions: this.persistAgentSessions,
        signal: managed.controller.signal,
        concurrency: resolvedConcurrency,
        agentRetries: resolvedAgentRetries,
        maxAgents: resolvedMaxAgents,
        agentTimeoutMs: resolvedAgentTimeoutMs,
        workflowTimeoutMs: resolvedWorkflowTimeoutMs,
        tokenBudget: resolvedTokenBudget,
        tools: resolvedTools,
        excludeTools: this.excludeSubagentTools,
        confirm,
        onDeliver: async ({ kind, message }) => {
          if (!this.isCurrent(managed)) return;
          const delivery = this.admitExplicitDelivery(managed, message, kind);
          // Admission is durable before the host is allowed to submit the
          // safe-point steer message. A persistence failure rejects deliver()
          // rather than falsely reporting that it was sent.
          const payload = {
            runId: managed.runId,
            workflowName: managed.snapshot.name,
            alertKind: kind,
            deliveryId: delivery.deliveryId,
            sequence: delivery.sequence,
          };
          // A classified parent delivery is usable workflow output even while
          // the run itself remains active. Blocking output waits subscribe to
          // this durable post-admission boundary so they can yield to the
          // parent model instead of accumulating findings behind a long-lived
          // sequential tool call.
          this.safeEmit("delivery", payload);
          await this.onDeliver?.(message, payload);
        },
        takePendingMessages: () => (this.isCurrent(managed) ? this.takePendingMessages(managed.runId) : []),
        onAgentSession: ({ id, session, send }) => {
          if (
            this.isCurrent(managed) &&
            managed.status === "running" &&
            managed.executionGeneration === executionGeneration
          )
            this.activeAgentSenders.set(id, { runId: managed.runId, managed, session, send });
        },
        onAgentSessionEnd: ({ id, session }) => {
          const target = this.activeAgentSenders.get(id);
          if (target?.managed === managed && target.session === session) this.activeAgentSenders.delete(id);
        },
        loadSavedWorkflow: this.loadSavedWorkflow,
        resumeJournal,
        resumeFromRunId: resumeJournal ? managed.runId : undefined,
        // Seed the fresh SharedRuntime's spend counter from the persisted total
        // (resume()) so the hard tokenBudget cap holds cumulatively across a
        // pause/resume cycle instead of resetting to zero each time (see A2 —
        // runWorkflow only applies this on the fresh-SharedRuntime branch, never
        // overriding an inherited options.sharedRuntime from a nested workflow()).
        initialTokenUsage,
        providerAcquire: (runId, signal) =>
          this.resources.acquireProvider(runId, signal, this.resourceNamespace, managed.executionGeneration ?? runId),
        lateAttemptRegistry: {
          register: (metadata) => this.resources.registerLateAttempt(metadata),
          markLate: (attemptId) => this.resources.markLate(attemptId),
          markLateScope: (scope) => this.resources.markLateScope(scope),
        },
        // Retried-attempt spend (see WorkflowRunOptions.onRetrySpend and A2):
        // recordTokens() in workflow.ts already folded this into
        // shared.spent/tokenUsage, but onAgentEnd never sees a retried
        // (non-final) attempt — fold it into the same persisted aggregate here
        // so a run paused after a retry doesn't under-count against the budget.
        onRetrySpend: (tokens, usage) => {
          if (this.isCurrent(managed)) {
            this.accumulateTokenUsage(managed, tokens, usage);
            // Persist retried-attempt spend promptly (UB-003): a crash before
            // the next journal/final write would otherwise resume with an
            // understated cumulative budget. Throttled like the journal
            // checkpoint.
            this.schedulePersist(managed);
          }
        },
        onAgentJournal: (entry) => {
          if (!this.isCurrent(managed)) return;
          // Append (crash-safe-ish): keep the latest entry per (runId, index)
          // pair, then persist. Matching on index ALONE would let a nested
          // workflow()'s callIndex-0 entry evict the parent's own
          // callIndex-0 entry (and vice versa) — they're only distinguished
          // by runId (see JournalEntry.runId). This is the high-frequency
          // progress persist (fires once per completed agent, can burst
          // under concurrency) — throttled (trailing edge). Every
          // lifecycle-critical persist below (status transitions, run end,
          // pause/resume/stop) still calls persistRun() directly and flushes this.
          managed.journal = managed.journal.filter((e) => !(e.index === entry.index && e.runId === entry.runId));
          managed.journal.push(entry);
          this.schedulePersist(managed);
        },
        onLog: (message) => {
          if (!this.isCurrent(managed)) return;
          const nextBytes =
            managed.snapshot.logs.reduce((total, item) => total + Buffer.byteLength(item, "utf8"), 0) +
            Buffer.byteLength(message, "utf8");
          if (managed.snapshot.logs.length >= 10_000 || nextBytes > 2 * 1024 * 1024) {
            if (
              managed.snapshot.logs.length < 10_000 &&
              !managed.snapshot.logs.some((item) => item.includes("log resource limit reached"))
            ) {
              managed.snapshot.logs.push("workflow log resource limit reached; further entries omitted");
            }
            return;
          }
          managed.snapshot.logs.push(message);
          this.emitLive(managed, "log", { runId: managed.runId, message });
          progress();
        },
        onPhase: (title) => {
          if (!this.isCurrent(managed)) return;
          managed.snapshot.currentPhase = title;
          if (!managed.snapshot.phases.includes(title)) {
            managed.snapshot.phases.push(title);
          }
          this.emitLive(managed, "phase", { runId: managed.runId, title });
          progress();
        },
        onAgentStart: (event) => {
          if (!this.isCurrent(managed)) return;
          const id = managed.snapshot.agents.length + 1;
          const agentSnapshot: WorkflowAgentSnapshot = {
            id,
            callId: event.id,
            label: event.label,
            phase: event.phase,
            prompt: event.prompt,
            status: "running",
            model: event.model,
          };
          managed.snapshot.agents.push(agentSnapshot);
          // Index by the call's unique id (never label — see agentsById's doc
          // comment) so onAgentEnd/onAgentHistory can resolve back to exactly
          // THIS entry even when a concurrent sibling shares its label.
          managed.agentsById.set(event.id, agentSnapshot);
          // Real per-agent start time, captured the moment the agent actually
          // starts (not the run's startedAt) — see agentTimestamps.
          managed.agentTimestamps.set(id, { startedAt: new Date().toISOString() });
          this.emitLive(managed, "agentStart", { runId: managed.runId, ...event });
          progress();
        },
        onAgentModelResolved: (event) => {
          if (!this.isCurrent(managed)) return;
          const agent = managed.agentsById.get(event.id);
          if (!agent || agent.model === event.model) return;
          agent.model = event.model;
          this.emitLive(managed, "agentModelResolved", { runId: managed.runId, ...event });
          this.schedulePersist(managed);
          progress();
        },
        onAgentEnd: (event) => {
          if (!this.isCurrent(managed)) return;
          const agent = managed.agentsById.get(event.id);
          if (agent) {
            agent.status = event.result === null ? "error" : "done";
            // Keep the full value for the interactive pager; compact surfaces
            // continue to use resultPreview.
            agent.result = event.result;
            agent.resultPreview = preview(event.result);
            agent.error = event.error;
            agent.errorCode = event.errorCode;
            agent.recoverable = event.recoverable;
            agent.tokens = event.tokens;
            if (event.tokenUsage) agent.tokenUsage = event.tokenUsage;
            if (event.model) agent.model = event.model;
            // Real per-agent end time — only terminal agents get one; a still-
            // running agent's entry keeps endedAt undefined.
            const ts = managed.agentTimestamps.get(agent.id);
            if (ts) ts.endedAt = new Date().toISOString();
          }
          // Progressive run-wide token aggregate (A2): workflow.ts's onTokenUsage
          // callback below fires exactly once, only when the whole script finishes
          // successfully (a deliberate, tested contract — see
          // "agent() accumulates usage across multiple agents" in agent.test.ts,
          // which asserts one final event, not one per agent). A run that
          // pauses/aborts/fails mid-flight never reaches it, so without tracking
          // it here too, a paused run's persisted tokenUsage would stay whatever
          // it was (usually unset) — starving resume()'s spend-seeding of the
          // very data it needs. Accumulate additively from every onAgentEnd
          // instead: a cache-hit replay reports tokens: 0 (see agent()'s replay
          // branch in workflow.ts), so replaying the unchanged prefix on resume
          // is a no-op add here, matching the "already historically spent, don't
          // double-count" semantics of journal replay.
          this.accumulateTokenUsage(managed, event.tokens ?? 0, event.tokenUsage);
          this.activeAgentSenders.delete(event.id);
          this.emitLive(managed, "agentEnd", { runId: managed.runId, ...event });
          if (!event.replayed) {
            this.onAgentMessage?.({
              runId: managed.runId,
              id: event.id,
              label: event.label,
              phase: event.phase,
              result: event.result,
              error: event.error,
            });
          }
          progress();
        },
        onAgentHistory: (event) => {
          if (!this.isCurrent(managed)) return;
          const agent = managed.agentsById.get(event.id);
          if (agent) {
            agent.history = event.history;
          }
          this.emitLive(managed, "agentHistory", { runId: managed.runId, agentId: agent?.id, ...event });
          progress();
        },
        onTokenUsage: (usage) => {
          if (!this.isCurrent(managed)) return;
          managed.snapshot.tokenUsage = usage;
          this.emitLive(managed, "tokenUsage", { runId: managed.runId, usage });
          progress();
        },
      });

      // Cooperative aborts can race a provider that resolves successfully.
      // Never let that late success overwrite pause()/stop()'s terminal intent.
      if (managed.controller.signal.aborted || managed.status !== "running") {
        throw new WorkflowError("Workflow aborted before completion", WorkflowErrorCode.WORKFLOW_ABORTED, {
          recoverable: true,
        });
      }
      managed.status = "completed";
      managed.result = result;
      this.dropPendingMessages(managed.runId);
      const terminalDelivery = this.ensureTerminalDelivery(managed);
      // Persist before announcing completion. The terminal outbox record is
      // written in the same CAS publication as the complete result. Delivery
      // text advertises the
      // durable run path as the retrieval channel for full structured output
      // and subagent reports; emitting first creates a race where the model can
      // follow a path that does not exist yet (or still contains running state).
      // persistRun()/writeRunToDisk() no-op for superseded executions.
      this.persistRunStrict(managed);

      // Gated the same way as disk/lease below (see emitLive()): a stale
      // execution's "complete" would otherwise still deliver a result for a
      // run that's been superseded or deleted (e.g. background result
      // delivery into the conversation) even though it's no longer current.
      this.emitLive(managed, "complete", {
        runId: managed.runId,
        result,
        deliveryId: terminalDelivery?.deliveryId,
        sequence: terminalDelivery?.sequence,
      });

      // Guard lease release the same way: a stale execution settling after
      // resume() acquired a new lease must not touch the newer bookkeeping.
      // Now (and only now — after the run's data is safely on disk and its
      // lease released) does this run become eviction-eligible; see the
      // `runs` field doc comment.
      this.cleanupSettledGeneration(managed);
      this.releaseExecutionCapacity(managed);
      removeExternalAbort?.();

      return result;
    } catch (error) {
      const workflowError =
        error instanceof WorkflowError
          ? error
          : new WorkflowError(
              error instanceof Error ? error.message : String(error),
              WorkflowErrorCode.WORKFLOW_ABORTED,
              { recoverable: true },
            );

      const usageLimitPaused = !managed.controller.signal.aborted && isProviderUsageLimit(workflowError);
      // A failed terminal publication must not retain the uncommitted
      // completed-result marker; replace it with the failed terminal record.
      if (managed.status === "completed")
        managed.deliveryOutbox = managed.deliveryOutbox.filter((item) => !item.terminal);
      if (managed.controller.signal.aborted) {
        // Intentional abort (pause/stop/Esc) — preserve status set by pause()/stop()
        if (managed.status === "running") {
          managed.status = "aborted";
        }
      } else if (usageLimitPaused) {
        // Provider quota/usage limit: NOT a failure. Checkpoint the run as paused so
        // the persisted journal (completed agent results) is replayed by resume()
        // once the budget refills — instead of the user starting from scratch.
        // executeRun's promise is still inside this catch until the final
        // persist/release below, so stop() must continue to treat it as pending.
        managed.executionSettled = false;
        managed.status = "paused";
      } else {
        managed.status = "failed";
      }
      // A result is publishable only with the completed terminal state. If that
      // publication failed (for example the finite durable-size guard), do not
      // carry the uncommitted value into a failed-state retry or accidentally
      // claim that the complete result was durable.
      if (managed.status !== "completed") managed.result = undefined;
      managed.error = workflowError;
      if (IN_MEMORY_TERMINAL_STATUSES.has(managed.status)) this.dropPendingMessages(managed.runId);
      const failureDelivery = this.ensureTerminalDelivery(managed);
      const pausedDelivery = usageLimitPaused ? this.ensurePausedDelivery(managed, workflowError) : undefined;
      let terminalPersistenceError: unknown;
      if (managed.status === "failed") {
        try {
          this.persistRunStrict(managed);
        } catch (error) {
          // Continue the lifecycle tail so the lease is released and the
          // producer receives an observable failure, but never claim durable
          // terminal delivery when this publication failed.
          terminalPersistenceError = error;
        }
      }
      // Both branches gated via emitLive() (see its doc comment) — a stale
      // execution's "paused"/"error" is equally misleading once superseded.
      if (usageLimitPaused) {
        // Publish only after the checkpoint and its stable delivery ID are
        // durably committed below.
      } else if (managed.controller.signal.aborted) {
        // Manual pause()/stop() own their explicit lifecycle events. A host
        // externalSignal abort (Esc/tool cancellation) has neither flag and is
        // still surfaced through the traditional error channel so synchronous
        // callers can observe WORKFLOW_ABORTED without an unhandled EventEmitter
        // "error" when no listener is installed.
        if (managed.status === "paused" || managed.stopRequested) {
          // pause()/stop() already emitted.
        } else if (externalSignal?.aborted && this.listenerCount("error") > 0) {
          this.emitLive(managed, "error", {
            runId: managed.runId,
            error: workflowError,
            deliveryId: failureDelivery?.deliveryId,
            sequence: failureDelivery?.sequence,
          });
        } else if (managed.status === "aborted" && this.listenerCount("stopped") > 0) {
          this.emitLive(managed, "stopped", { runId: managed.runId });
        }
      } else if (this.listenerCount("error") > 0) {
        // Guarded: EventEmitter throws on an unlistened "error" emit, which
        // would abort this catch block mid-way — skipping the final persist,
        // the lease release, and the real error rethrow below.
        this.emitLive(managed, "error", {
          runId: managed.runId,
          error: workflowError,
          deliveryId: failureDelivery?.deliveryId,
          sequence: failureDelivery?.sequence,
        });
      }

      // Persist final state (see the success-path comment above for the
      // isCurrent() rationale — same guard, same reason). A paused checkpoint
      // is also a resumability boundary, so it must fail closed rather than
      // releasing its lease after a best-effort write.
      let finalPersisted = true;
      try {
        this.persistRunStrict(managed);
      } catch (error) {
        finalPersisted = false;
        terminalPersistenceError ??= error;
      }
      if (usageLimitPaused && this.isCurrent(managed) && finalPersisted) {
        this.emitLive(managed, "paused", {
          runId: managed.runId,
          reason: "usage_limit",
          error: workflowError,
          resetHint: workflowError.resetHint,
          deliveryId: pausedDelivery?.deliveryId,
          sequence: pausedDelivery?.sequence,
          content: pausedDelivery?.content,
        });
      }
      if (this.isCurrent(managed) && finalPersisted) {
        // Every fully settled generation must release targeted-session
        // references. Manual pause closes runtime admission before AgentSession
        // disposal, so the normal onAgentSessionEnd observer can be suppressed;
        // retaining those send closures would keep the disposed session and
        // ManagedRun alive indefinitely.
        this.cleanupSettledGeneration(managed);
      } else if (this.isCurrent(managed) && !finalPersisted) {
        // Keep the last known durable record intact, but never hold a lease
        // forever on a failed filesystem. The durable running/paused record is
        // safe for stale recovery/resume; this generation is explicitly marked
        // persistence-blocked. It still enters the normal bounded retention
        // queue so a persistent filesystem failure cannot grow `runs` forever.
        this.markPersistenceBlocked(managed);
        this.cleanupSettledGeneration(managed);
      }
      // Capacity belongs to the execution generation, not the current map entry;
      // release even when persistence failed or delete/resume fenced this object.
      this.releaseExecutionCapacity(managed);
      removeExternalAbort?.();

      if (terminalPersistenceError) {
        throw new WorkflowError(
          terminalPersistenceError instanceof Error
            ? terminalPersistenceError.message
            : String(terminalPersistenceError),
          WorkflowErrorCode.PERSISTENCE_ERROR,
          { recoverable: true },
        );
      }
      throw workflowError;
    }
  }

  /**
   * True when `managed` is still the live, current entry for its runId in
   * `this.runs` — false once resume() has replaced it with a new ManagedRun
   * object for the same runId, or deleteRun() has removed it entirely. A
   * superseded ManagedRun's async completion (executeRun's promise settling
   * well after something else already took over or tore down that runId)
   * must not write to disk or touch lease state on the newer execution's
   * behalf — see writeRunToDisk() and executeRun()'s post-await persist calls.
   */
  private releaseExecutionCapacity(managed: ManagedRun): void {
    if (managed.resourceExecutionReleased) return;
    managed.resourceExecutionReleased = true;
    if (managed.resourceExecutionHeld && managed.resourceExecutionReservation) {
      this.resources.releaseExecution(managed.resourceExecutionReservation);
    }
  }

  private isCurrent(managed: ManagedRun): boolean {
    return this.runs.get(managed.runId) === managed;
  }

  /** A bound session may only recover/control records explicitly owned by it.
   * Legacy unowned records fail closed once a session is known. */
  private ownsPersistedRun(state: PersistedRunState | null | undefined): boolean {
    if (!state || !this.sessionId) return Boolean(state);
    return state.sessionId === this.sessionId;
  }

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
  private emitLive(managed: ManagedRun, event: string, payload: unknown): void {
    if (this.isCurrent(managed)) this.safeEmit(event, payload);
  }

  /**
   * Emit with listener isolation (UIOBS-006): a throwing listener (e.g. a
   * delivery renderer formatting a non-serializable result) must never abort
   * the lifecycle code mid-transition — that would corrupt status/lease/
   * persistence. Listener failures are diagnosed and otherwise ignored.
   */
  private safeEmit(event: string, payload: unknown): void {
    try {
      this.emit(event, payload);
    } catch (err) {
      console.warn(`[workflow] "${event}" listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Mark a settled paused run as in-memory eviction-eligible. Callers invoke
   * this only from executeRun's settled tail, after sender cleanup and lease
   * release. Re-read the current entry before deleting so a stale queue item
   * can never evict a resumed generation for the same runId. The durable record
   * may be stale when publication is persistence-blocked; recovery still treats
   * running/paused records as resumable boundaries.
   */
  private recordPausedRun(managed: ManagedRun): void {
    this.pausedRunQueue.push(managed);
    while (this.pausedRunQueue.length > this.maxPausedRunsInMemory) {
      const oldest = this.pausedRunQueue.shift();
      if (!oldest) break;
      const current = this.runs.get(oldest.runId);
      // recordPausedRun() is called synchronously from executeRun's settled
      // tail, before the public promise's finally microtask flips
      // executionSettled. Lease release is therefore the authoritative proof
      // that this exact generation is no longer executing. Object identity
      // prevents an older queue entry from evicting a resumed generation that
      // reused the same durable runId.
      if (current === oldest && current.status === "paused" && !current.lease) {
        this.cleanupManagedSenders(current);
        this.dropPendingMessages(current.runId);
        this.runs.delete(current.runId);
      }
    }
  }

  /**
   * Mark `runId` as eviction-eligible now that its execution has genuinely
   * settled to a terminal status, and evict the oldest eligible entries.
   * The current status is revalidated so stale queue entries cannot evict a
   * resumed live generation.
   */
  private recordTerminalRun(runId: string): void {
    this.terminalRunQueue.push(runId);
    while (this.terminalRunQueue.length > this.maxTerminalRunsInMemory) {
      const oldest = this.terminalRunQueue.shift();
      if (oldest === undefined) break;
      const current = this.runs.get(oldest);
      // Re-check the CURRENT entry for this id (not the ManagedRun object
      // that was terminal when queued) — resume() may have since replaced
      // it with a fresh, live execution, which must never be evicted here.
      if (current && IN_MEMORY_TERMINAL_STATUSES.has(current.status)) {
        this.runs.delete(oldest);
      }
    }
  }

  /**
   * Additively fold one agent-call's token cost into the run-wide persisted
   * aggregate (managed.snapshot.tokenUsage), seeded (on resume) from the
   * persisted total-at-pause — see A2. Shared by onAgentEnd (a completed or
   * finally-failed agent call) and onRetrySpend (a failed attempt that WILL
   * be retried, whose cost recordTokens() already folded into
   * shared.spent/tokenUsage in workflow.ts, but which onAgentEnd never sees —
   * see WorkflowRunOptions.onRetrySpend for why that needs its own channel).
   */
  private accumulateTokenUsage(managed: ManagedRun, tokens: number, tokenUsage?: AgentUsage): void {
    const prior = managed.snapshot.tokenUsage;
    const usage = {
      input: prior?.input ?? 0,
      output: prior?.output ?? 0,
      total: prior?.total ?? 0,
      cost: prior?.cost ?? 0,
      cacheRead: prior?.cacheRead ?? 0,
      cacheWrite: prior?.cacheWrite ?? 0,
    };
    usage.total += tokens;
    if (tokenUsage) {
      usage.input += tokenUsage.input;
      usage.output += tokenUsage.output;
      usage.cost += tokenUsage.cost;
      usage.cacheRead += tokenUsage.cacheRead;
      usage.cacheWrite += tokenUsage.cacheWrite;
    }
    managed.snapshot.tokenUsage = usage;
  }

  private cleanupManagedSenders(managed: Pick<ManagedRun, "runId">): void {
    for (const [agentId, target] of this.activeAgentSenders) {
      if (target.managed.runId === managed.runId) this.activeAgentSenders.delete(agentId);
    }
  }

  /**
   * Release every resource owned by a generation whose executeRun() tail has
   * settled. This is intentionally idempotent: pause()/stop() can observe an
   * already-settled generation while the normal catch/finally path may also
   * be unwinding. The current-object check preserves generation fencing; a
   * stale generation may release only resources already detached by
   * deleteRun()/resume(), never a replacement run with the same runId.
   */
  private cleanupSettledGeneration(managed: ManagedRun): void {
    if (!this.isCurrent(managed)) return;
    const retentionStatus = IN_MEMORY_TERMINAL_STATUSES.has(managed.status)
      ? "terminal"
      : managed.status === "paused"
        ? "paused"
        : undefined;
    if (!retentionStatus || managed.settledCleanupStatus === retentionStatus) return;
    managed.settledCleanupStatus = retentionStatus;
    this.cleanupManagedSenders(managed);
    this.dropPendingMessages(managed.runId);
    this.releaseRunLease(managed);
    this.releaseExecutionCapacity(managed);
    if (IN_MEMORY_TERMINAL_STATUSES.has(managed.status)) {
      // A paused generation may have already been retained before a later
      // stop/failure makes this same run terminal. It is no longer resumable;
      // clear every same-run paused entry before terminal retention so those
      // stale generations cannot consume the paused FIFO indefinitely.
      this.pausedRunQueue = this.pausedRunQueue.filter((entry) => entry.runId !== managed.runId);
      this.recordTerminalRun(managed.runId);
    } else if (managed.status === "paused") this.recordPausedRun(managed);
  }

  private releaseRunLease(managed: ManagedRun): void {
    if (!managed.lease) return;
    this.persistence.releaseRunLease(managed.lease);
    managed.lease = undefined;
  }

  /** Trailing-edge throttle window for high-frequency progress persists (see schedulePersist). */
  private static readonly PERSIST_THROTTLE_MS = 400;

  /** Pending trailing-edge persist timers for high-frequency progress events, keyed by runId. */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Same-generation host-admission markers for deliveries that have no
   * durable outbox record (see markDeliverySubmitted). */
  private bridgeDeliveryState?: Map<string, number>;

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
  private schedulePersist(managed: ManagedRun): void {
    if (this.persistTimers.has(managed.runId)) return; // already scheduled; the trailing write reads live state
    const timer = setTimeout(() => {
      this.persistTimers.delete(managed.runId);
      this.writeRunToDisk(managed);
    }, WorkflowManager.PERSIST_THROTTLE_MS);
    // A pending progress persist should never keep the process alive on its own.
    timer.unref?.();
    this.persistTimers.set(managed.runId, timer);
  }

  /**
   * Persist immediately and synchronously. Cancels any pending throttled write
   * for this run first, so the write that lands is always the caller's current
   * (final) state — never superseded by a stale deferred write. Use this for
   * every lifecycle-critical persist: run start, status transitions, run end,
   * pause()/resume()/stop().
   */
  private persistRun(managed: ManagedRun): void {
    // A superseded execution's persist call must not touch the CURRENT
    // execution's pending-timer bookkeeping for this runId (see isCurrent()).
    // writeRunToDisk() below re-checks this too (it's the sole choke point
    // schedulePersist()'s deferred timer also funnels through), so this is a
    // belt-and-suspenders early-out specifically for the timer-clearing side
    // effect, which writeRunToDisk() alone wouldn't prevent.
    if (!this.isCurrent(managed)) return;
    const timer = this.persistTimers.get(managed.runId);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(managed.runId);
    }
    this.writeRunToDisk(managed);
  }

  private persistedStateFor(managed: ManagedRun): PersistedRunState {
    // Resumable states need their journal; completed/aborted states need rich
    // agent details. Persist exactly one full copy of each agent result instead
    // of writing it to both agents[].result and journal[].result.
    const keepsResumeJournal = managed.status !== "completed" && managed.status !== "aborted";
    return {
      runId: managed.runId,
      workflowName: managed.snapshot.name,
      script: managed.script,
      args: managed.args,
      sessionId: managed.sessionId,
      journal: keepsResumeJournal ? managed.journal : undefined,
      status: managed.status,
      autoResume: managed.autoResume,
      tokenBudget: managed.tokenBudget,
      toolset: managed.toolset,
      maxAgents: managed.maxAgents,
      agentTimeoutMs: managed.agentTimeoutMs,
      workflowTimeoutMs: managed.workflowTimeoutMs,
      concurrency: managed.concurrency,
      agentRetries: managed.agentRetries,
      pauseReason: managed.status === "paused" && isProviderUsageLimit(managed.error) ? "usage_limit" : undefined,
      resetHint:
        managed.status === "paused" && isProviderUsageLimit(managed.error) ? managed.error.resetHint : undefined,
      phases: managed.snapshot.phases,
      currentPhase: managed.snapshot.currentPhase,
      agents: managed.snapshot.agents.map((a) => {
        const { result, ...summary } = a;
        const ts = managed.agentTimestamps.get(a.id);
        return {
          ...summary,
          ...(keepsResumeJournal || result === undefined ? {} : { result }),
          startedAt: ts?.startedAt,
          endedAt: ts?.endedAt,
        };
      }),
      logs: managed.snapshot.logs,
      result: managed.result?.result,
      tokenUsage: managed.snapshot.tokenUsage
        ? {
            input: managed.snapshot.tokenUsage.input,
            output: managed.snapshot.tokenUsage.output,
            total: managed.snapshot.tokenUsage.total,
            cost: managed.snapshot.tokenUsage.cost,
            cacheRead: managed.snapshot.tokenUsage.cacheRead,
            cacheWrite: managed.snapshot.tokenUsage.cacheWrite,
          }
        : undefined,
      startedAt: managed.startedAt.toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: managed.status === "completed" ? new Date().toISOString() : undefined,
      durationMs: managed.result?.durationMs,
      deliveryOutbox: managed.deliveryOutbox,
      nextDeliverySequence: managed.nextDeliverySequence,
      deliveryBudget: managed.deliveryBudget,
    };
  }

  private writeRunToDisk(managed: ManagedRun, failClosed = false): boolean {
    // The sole choke point for every disk write (both persistRun()'s direct
    // calls and schedulePersist()'s deferred timer funnel through here) — skip
    // silently when `managed` is no longer the current entry for its runId
    // (see isCurrent()). This is an expected race outcome (resume() replaced
    // it, or deleteRun() removed it), not an error: writing anyway would
    // resurrect a torn-down run's file, or clobber a newer execution's
    // in-progress/completed state with this stale one's.
    //
    // This check is redundant with persistRun()'s own early-return for every
    // CURRENT call site — it earns its keep solely for schedulePersist()'s
    // deferred setTimeout callback, the one path into this method that skips
    // persistRun() entirely. That callback only fires from onAgentJournal, and
    // onAgentJournal only fires for a call that got PAST agent()'s
    // throwIfAborted() check (see workflow.ts) — which, since run-fatal abort
    // (SharedRuntime.runFatalController) now seals every top-level run's
    // shared runtime the instant any error escapes it uncaught, means a
    // genuinely superseded-but-never-aborted execution (the only kind that
    // could previously still journal a stray call after resume() replaced it)
    // is structurally impossible to construct anymore — see the "unreachable
    // defense-in-depth (#2)" test in workflow-manager.test.ts for the worked
    // example and its own note. This check is KEPT anyway: it costs nothing,
    // and removing it would silently reopen a stale-write path the moment any
    // future change (e.g. a new way to journal without throwIfAborted()'s
    // gate) reintroduces a producer for it.
    if (!this.isCurrent(managed)) return false;
    try {
      const state = this.persistedStateFor(managed);
      this.persistence.save(state, managed.revision, managed.lease);
      managed.revision = state.revision;
      managed.persistenceBlocked = false;
      return true;
    } catch (err) {
      if (failClosed) throw err;
      // Ordinary progress persistence remains best-effort; delivery admission
      // uses failClosed=true so a producer never observes a false send.
      console.warn("[workflow-manager] Persist run failed:", err);
      return false;
    }
  }

  /**
   * Pause a running workflow.
   */
  pause(runId: string): boolean {
    assertSafeRunId(runId);
    const managed = this.runs.get(runId);
    if (managed?.status !== "running") return false;

    managed.controller.abort();
    managed.status = "paused";
    try {
      this.persistRunStrict(managed);
    } catch {
      // The controller has already been aborted and cannot be restarted. Keep
      // the in-memory state paused so the entry is recoverable instead of
      // exposing a ghost `running` run whose execution is already doomed.
      this.markPersistenceBlocked(managed);
      return false;
    }
    this.safeEmit("paused", { runId });
    // Keep the lease until executeRun() settles. A cooperative abort may still
    // have provider/tool work in flight; releasing here would let resume() or a
    // second process start a competing generation against the same budget.
    return true;
  }

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
  async resume(runId: string, opts?: { script?: string; args?: unknown }): Promise<boolean> {
    assertSafeRunId(runId);
    // Guard: refuse to resume a run that is already running, or one that was
    // intentionally aborted (pause/stop/Esc). Paused and failed runs can restart.
    const active = this.runs.get(runId);
    if (active?.status === "running") return false;
    if (active?.status === "aborted") return false;
    // A manually paused run may still be unwinding its aborted generation.
    // Wait before acquiring a new lease and replacing the map entry, so old
    // provider calls cannot overlap the resumed generation.
    if (active?.status === "paused" && active.execution) {
      await active.execution.catch(() => {});
      if (this.runs.get(runId) !== active) return false;
    }

    let persisted = this.persistence.load(runId);
    if (
      !this.ownsPersistedRun(persisted) ||
      !persisted?.script ||
      persisted.status === "completed" ||
      persisted.status === "aborted"
    )
      return false;
    const executionGeneration = generateRunId();
    const resourceExecutionReservation = this.resources.acquireExecution(
      runId,
      this.resourceNamespace,
      executionGeneration,
    );
    if (!resourceExecutionReservation) return false;
    let lease: RunLease | null;
    try {
      lease = this.persistence.acquireRunLease(runId);
    } catch (error) {
      this.resources.releaseExecution(resourceExecutionReservation);
      throw error;
    }
    if (!lease) {
      this.resources.releaseExecution(resourceExecutionReservation);
      return false;
    }
    // MG-002: re-read the record UNDER the lease. Another manager/process may
    // have stopped or completed the run between the initial load and lease
    // acquisition; resuming from the stale pre-lease snapshot would resurrect
    // it. Release and bail if the fresh record is no longer resumable.
    try {
      persisted = this.persistence.load(runId);
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      this.resources.releaseExecution(resourceExecutionReservation);
      throw error;
    }
    if (
      !this.ownsPersistedRun(persisted) ||
      !persisted?.script ||
      persisted.status === "completed" ||
      persisted.status === "aborted"
    ) {
      this.persistence.releaseRunLease(lease);
      this.resources.releaseExecution(resourceExecutionReservation);
      return false;
    }

    // Use the edited script when supplied, else the persisted one (backward-compat).
    // Validate both while the lease and execution reservation are held, before
    // any map entry or durable revision is published.
    let script: string;
    let args: unknown;
    try {
      script = opts?.script ?? persisted.script;
      parseWorkflowScript(script);
      args = this.admitArgs(opts?.args !== undefined ? opts.args : persisted.args);
    } catch (error) {
      this.persistence.releaseRunLease(lease);
      this.resources.releaseExecution(resourceExecutionReservation);
      throw error;
    }

    // Normalize the persisted total-at-pause once: PersistedRunState.tokenUsage
    // has optional cost/cacheRead/cacheWrite (legacy runs may lack them), but
    // both the seeded snapshot and initialTokenUsage need concrete numbers.
    const priorTokenUsage = persisted.tokenUsage
      ? {
          input: persisted.tokenUsage.input,
          output: persisted.tokenUsage.output,
          total: persisted.tokenUsage.total,
          cost: persisted.tokenUsage.cost ?? 0,
          cacheRead: persisted.tokenUsage.cacheRead ?? 0,
          cacheWrite: persisted.tokenUsage.cacheWrite ?? 0,
        }
      : undefined;

    const controller = new AbortController();
    const managed: ManagedRun = {
      runId,
      status: "running",
      snapshot: {
        name: persisted.workflowName,
        phases: persisted.phases ?? [],
        logs: persisted.logs ?? [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
        // Seed the live snapshot's aggregate from the persisted total-at-pause
        // (see A2) so a pause that lands before this resume's first agent
        // completes doesn't lose the prior spend — onAgentEnd accumulates on
        // top of this rather than starting from scratch.
        tokenUsage: priorTokenUsage,
      },
      controller,
      startedAt: new Date(),
      // The (possibly edited) script + args become the run's own — persistRun()
      // writes them below, so a later resume of this run sees the edited script.
      script,
      args,
      journal: persisted.journal ?? [],
      revision: persisted.revision,
      background: true,
      // Prefer the frozen owner on disk; fall back to the manager's current
      // session only for legacy runs that predate per-run sessionId.
      sessionId: persisted.sessionId ?? this.sessionId,
      lease,
      // Carry the original opt-out forward across resumes; it's fixed at
      // run-start and persistRun() re-persists it on every subsequent write.
      autoResume: persisted.autoResume,
      // Restore start-time execution context: the budget the run started with
      // (legacy runs without one resume unbudgeted — never re-apply the current
      // default to a run that predates it) and the toolset tag executeRun
      // re-resolves so e.g. a resumed /deep-research keeps its web tools.
      tokenBudget: persisted.tokenBudget !== undefined ? persisted.tokenBudget : null,
      toolset: persisted.toolset,
      // Restore the same start-time execution context for the other four
      // per-run knobs (see ManagedRun doc comments) — same rationale as
      // tokenBudget: never re-resolve against the manager's CURRENT defaults.
      // maxAgents: legacy/never-set runs resume with no cap carried forward
      // (runWorkflow's own MAX_AGENTS_PER_RUN default applies), exactly as if
      // maxAgents had never been passed at all.
      maxAgents: persisted.maxAgents,
      // agentTimeoutMs: unlike tokenBudget, a legacy run's real timeout at
      // start was never "no timeout" by omission — it was always
      // this.defaultAgentTimeoutMs, because pre-A1 resume() never threaded
      // agentTimeoutMs through at all and unconditionally fell back to the
      // manager default (see executeRun's resolvedAgentTimeoutMs fallback
      // chain). Falling back to null here would change what a legacy run's
      // resume actually does versus both its original start AND pre-fix
      // resume behavior. So — deliberately unlike tokenBudget's null
      // fallback — legacy runs resume with the manager's CURRENT default,
      // matching the only semantics such a run ever had.
      agentTimeoutMs: persisted.agentTimeoutMs !== undefined ? persisted.agentTimeoutMs : this.defaultAgentTimeoutMs,
      workflowTimeoutMs: persisted.workflowTimeoutMs ?? this.defaultWorkflowTimeoutMs,
      // concurrency/agentRetries have no "explicit opt-out sentinel" the way
      // tokenBudget's null does — a legacy run without a persisted value falls
      // back to the manager's current values, matching how this execution
      // resolved unset concurrency/agentRetries before this fix ever existed.
      concurrency: persisted.concurrency !== undefined ? persisted.concurrency : this.concurrency,
      agentRetries: persisted.agentRetries !== undefined ? persisted.agentRetries : this.defaultAgentRetries,
      activitySeq: ++this.activitySeq,
      // Fresh per-resume: agents (and any prior timing) are rebuilt live as
      // onAgentStart/onAgentEnd fire again for this attempt (see `agents: []`
      // above); the journal, not this map, is what makes replayed agents cheap.
      agentTimestamps: new Map(),
      agentsById: new Map(),
      executionSettled: false,
      resourceExecutionHeld: true,
      resourceExecutionReservation,
      executionGeneration,
      deliveryOutbox: (persisted.deliveryOutbox ?? []).map((delivery) => ({ ...delivery })),
      nextDeliverySequence:
        persisted.nextDeliverySequence ??
        (persisted.deliveryOutbox ?? []).reduce((max, item) => Math.max(max, item.sequence), -1) + 1,
      deliveryBudget: persisted.deliveryBudget ?? freshDeliveryBudget(),
    };
    this.runs.set(runId, managed);
    // Persist before notifying renderers: listRuns() is their source of truth for
    // lifecycle status, while getRun() supplies the live in-memory snapshot.
    try {
      this.persistRunStrict(managed);
    } catch (error) {
      this.releaseRunLease(managed);
      this.releaseExecutionCapacity(managed);
      managed.resourceExecutionReleased = true;
      this.runs.delete(runId);
      throw error;
    }

    // Namespace by (runId, index) exactly like the live onAgentJournal dedup
    // above and like SharedStore's deltaKey — see JournalEntry.runId. A
    // legacy entry persisted before namespacing existed has no `runId`; it is
    // assumed to belong to this run's own top-level runId (the only frame
    // that existed before nested workflow() journaling was namespaced), so it
    // still resume-hits for a top-level call and safely cache-misses (re-runs
    // live, does not misapply) for what was actually a nested-run entry.
    const resumeJournal = new Map((persisted.journal ?? []).map((e) => [`${e.runId ?? runId}:${e.index}`, e] as const));
    // Run in the background; executeRun records status/errors on the managed run.
    // initialTokenUsage seeds the resumed execution's fresh SharedRuntime.spent
    // (A2) from the persisted total-at-pause, so the tokenBudget cap holds
    // cumulatively instead of resetting to zero. Note: shared.agentCount is
    // deliberately NOT seeded the same way — it doesn't need to be. Unlike
    // token spend (whose cache-hit replay branch skips recordTokens() to avoid
    // double-counting already-spent tokens), agent()'s shared.agentCount++
    // fires unconditionally for EVERY call, cache-hit or live, before the
    // replay check runs (see workflow.ts). Because resume() always replays the
    // whole script from callIndex 0, that replay alone reconstructs the
    // correct cumulative count inside this fresh SharedRuntime by the time any
    // new live agent runs — so maxAgents (via A1) is already a genuine
    // cumulative cap across resume with no extra seeding required.
    managed.executionSettled = false;
    const execution = this.executeRun(managed, script, args, { resumeJournal, initialTokenUsage: priorTokenUsage });
    managed.execution = execution;
    void execution
      .finally(() => {
        managed.executionSettled = true;
      })
      .catch(() => {});
    execution.catch(() => {});
    try {
      this.safeEmit("resumed", { runId });
    } catch (err) {
      // LP-006: an observer failure must not leak the map entry/lease — the
      // execution is already running and owns its own lifecycle.
      console.warn(`[workflow] resumed listener threw: ${err instanceof Error ? err.message : String(err)}`);
    }
    return true;
  }

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
  stop(runId: string): boolean {
    assertSafeRunId(runId);
    const managed = this.runs.get(runId);
    if (managed) {
      if (managed.status !== "running" && managed.status !== "paused") return false;
      // Status is not a settle signal: manual pause() exposes "paused" while
      // executeRun() may still be unwinding an abort-ignoring provider. Keep
      // its lease and eviction protection until that real execution tail has
      // persisted the terminal state and settled. Conversely, a usage-limit
      // pause has already completed executeRun(), so stop() must perform the
      // final lease/terminal bookkeeping itself.
      // An execution handle is assigned immediately after executeRun() is
      // called, but pause/stop may be re-entered by an early lifecycle
      // listener before that assignment. Treat the generation as pending until
      // its explicit settled flag says otherwise; releasing the lease in that
      // tiny window would permit an overlapping resume generation.
      const executionPending = managed.executionSettled !== true;
      managed.controller.abort();
      managed.status = "aborted";
      managed.stopRequested = true;
      try {
        this.persistRunStrict(managed);
      } catch (_error) {
        // Do not restore `running`: the controller is already aborted. A stop
        // remains terminal even when its durable publication failed.
        this.markPersistenceBlocked(managed);
        if (!executionPending) {
          this.cleanupSettledGeneration(managed);
        }
        return false;
      }
      this.safeEmit("stopped", { runId });
      if (!executionPending) {
        this.cleanupSettledGeneration(managed);
      }
      return true;
    }

    let persisted = this.persistence.load(runId);
    if (
      !this.ownsPersistedRun(persisted) ||
      !persisted ||
      (persisted.status !== "running" && persisted.status !== "paused")
    )
      return false;
    const lease = this.persistence.acquireRunLease(runId);
    if (!lease) return false;
    try {
      // STOP-TOCTOU: re-read under the lease so a concurrent resume/completion
      // between the initial load and acquire cannot be overwritten as aborted.
      persisted = this.persistence.load(runId);
      if (
        !this.ownsPersistedRun(persisted) ||
        !persisted ||
        (persisted.status !== "running" && persisted.status !== "paused")
      )
        return false;
      this.persistence.save(
        { ...persisted, status: "aborted", updatedAt: new Date().toISOString() },
        persisted.revision,
        lease,
      );
    } finally {
      this.persistence.releaseRunLease(lease);
    }
    this.safeEmit("stopped", { runId });
    return true;
  }

  /**
   * Get status of a specific run.
   */
  getRun(runId: string): ManagedRun | undefined {
    assertSafeRunId(runId);
    return this.runs.get(runId);
  }

  /** Fresh, bounded resource view for operators and regression tests. */
  getResourceDiagnostics(): ResourceDiagnostics & {
    inMemoryRuns: number;
    persistedRunCount: number;
    persistedRunBytes: number;
    durableHighWaterBytes?: number;
    durableHighWaterCount?: number;
    ownedWorktrees: number;
  } {
    const pendingMessageCount = this.pendingMessageCount;
    const pendingMessageBytes = this.pendingMessageBytes;
    const snapshot = this.resources.snapshot({
      activeAgentSenders: this.activeAgentSenders.size,
      pendingMessageRuns: this.pendingMessages.size,
      pendingMessageCount,
      pendingMessageBytes,
      retainedPausedRuns: this.pausedRunQueue.length,
      persistenceBlockedRuns: [...this.runs.values()].filter((run) => run.persistenceBlocked === true).length,
    });
    const durable = this.persistence.getResourceDiagnostics();
    return {
      ...snapshot,
      inMemoryRuns: this.runs.size,
      persistedRunCount: durable.persistedRunCount,
      persistedRunBytes: durable.persistedRunBytes,
      durableHighWaterBytes: durable.durableHighWaterBytes,
      durableHighWaterCount: durable.durableHighWaterCount,
      ownedWorktrees: this.ownedWorktreeTokens.size,
    };
  }

  /**
   * List all runs (active + persisted).
   */
  /**
   * Runs for the navigator/task panel. Once bound to a session (setSessionId), only
   * that session's runs are returned — runs from other sessions stay on disk and
   * reappear when you switch back. Unbound (tests/legacy) returns everything.
   */
  listRuns(): PersistedRunState[] {
    const all = this.persistence.list();
    return this.sessionId ? all.filter((r) => r.sessionId === this.sessionId) : all;
  }

  /** All persisted runs regardless of session (used by cross-session recovery). */
  listAllRuns(): PersistedRunState[] {
    return this.persistence.list();
  }

  /** Explicit dry-run-by-default cleanup for abandoned paused records. */
  prunePausedRuns(options?: {
    before?: Date | string | number;
    maxRuns?: number;
    maxBytes?: number;
    dryRun?: boolean;
  }) {
    const protectedRunIds = new Set(
      [...this.runs.values()]
        .filter((run) => run.status === "running" || run.status === "paused")
        .map((run) => run.runId),
    );
    return this.persistence.prunePausedRuns({
      ...options,
      sessionId: this.sessionId,
      protectedRunIds,
      skipDeliveryOutbox: true,
    });
  }

  /**
   * Get snapshot of a run.
   */
  getSnapshot(runId: string): WorkflowSnapshot | null {
    assertSafeRunId(runId);
    return this.runs.get(runId)?.snapshot ?? null;
  }

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
  deleteRun(runId: string): boolean {
    assertSafeRunId(runId);
    const managed = this.runs.get(runId);
    if (managed && !managed.controller.signal.aborted) managed.controller.abort();
    // Fence deletion with the current lease. A fallback lease is a separate
    // capability and must be released on every unsuccessful/throwing path.
    const fallbackLease = managed?.lease ? undefined : this.persistence.acquireRunLease(runId);
    const lease = managed?.lease ?? fallbackLease;
    if (!lease) return false;
    try {
      const deleted = this.persistence.delete(runId, managed?.revision, lease);
      if (!deleted) {
        // Do not tear down the in-memory authority when the durable CAS refused
        // deletion; a newer writer still owns the record.
        return false;
      }
      if (managed) {
        // delete() consumes the managed lease; stale execution cleanup must not
        // release or affect a later generation, and capacity belongs to this
        // generation even when its provider ignores abort.
        managed.lease = undefined;
        this.releaseExecutionCapacity(managed);
      }
      this.cleanupManagedSenders(managed ?? { runId });
      this.runs.delete(runId);
      this.dropPendingMessages(runId);
      // A runId can have multiple settled paused generations after resume;
      // deleting only the current object leaves stale retention entries behind.
      // Remove all of them, while recordPausedRun() continues to use object
      // identity when deciding whether an overflow may evict a live generation.
      this.pausedRunQueue = this.pausedRunQueue.filter((entry) => entry.runId !== runId);
      this.terminalRunQueue = this.terminalRunQueue.filter((entry) => entry !== runId);
      // Cancel any pending throttled write so a deferred persist can't fire after
      // deletion and resurrect the run's file on disk.
      const timer = this.persistTimers.get(runId);
      if (timer) {
        clearTimeout(timer);
        this.persistTimers.delete(runId);
      }
      this.safeEmit("deleted", { runId });
      return true;
    } finally {
      if (fallbackLease) this.persistence.releaseRunLease(fallbackLease);
    }
  }

  /**
   * Get the persistence layer (for saving workflows).
   */
  getPersistence(): RunPersistence {
    return this.persistence;
  }

  /** Update the in-memory CAS fence after an external side-channel save. */
  syncPersistedRevision(runId: string, revision: number | undefined): void {
    if (!Number.isSafeInteger(revision) || revision === undefined) return;
    const managed = this.runs.get(runId);
    if (managed && (managed.revision ?? 0) < revision) managed.revision = revision;
  }
}
