import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Node } from "acorn";
import { parse } from "acorn";
import { type TSchema, Type } from "typebox";
import type { AgentUsage } from "./agent.js";
import { type AgentRunOptions, resolveAgentModelSpec, WorkflowAgent, type WorkflowAgentOptions } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import {
  type AgentDefinition,
  type AgentRegistry,
  agentDefinitionKey,
  loadAgentRegistry,
  resolveAgentType,
} from "./agent-registry.js";
import { type AgentTeamSnapshot, type AgentTeamSpawnSpec, WorkflowAgentTeam } from "./agent-team.js";
import {
  DEFAULT_AGENT_TIMEOUT_MS,
  DEFAULT_WORKFLOW_TIMEOUT_MS,
  MAX_AGENT_PROMPT_BYTES,
  MAX_AGENT_RETRIES,
  MAX_AGENTS_PER_RUN,
  MAX_CONCURRENCY,
  MAX_FANOUT_ITEMS,
  MAX_TEAM_MEMBERS_PER_RUN,
  MAX_TEAM_MESSAGES_PER_RUN,
  MAX_TEAM_TASKS_PER_RUN,
  MAX_TEAMS_PER_RUN,
  MAX_WORKFLOW_LOG_BYTES,
  MAX_WORKFLOW_LOG_ENTRIES,
  MAX_WORKFLOW_TIMEOUT_MS,
  VM_EXECUTION_TIMEOUT_MS,
  WORKFLOW_DRAIN_GRACE_MS,
} from "./config.js";
import { WorkflowError, WorkflowErrorCode, wrapError } from "./errors.js";
import { createWorkflowLogger } from "./logger.js";
import { parseModelRoutingFromMeta, resolveModelForPhase } from "./model-routing.js";
import { canonicalModelSpec, resolveModelSpecWithThinking } from "./model-spec.js";
import { generateRunId } from "./run-persistence.js";
import { serializeBounded, serializeIdentity } from "./safe-serialize.js";
import { createAgentStoreTools, SharedStore } from "./shared-store.js";
import { WORKFLOW_CAPABILITY_CONTRACT, type WorkflowRuntimeImplementations } from "./workflow-capability-contract.js";
import { createWorktree, removeWorktreeDetailed, type Worktree } from "./worktree.js";

/**
 * Batch-scoped cancellation for a single parallel()/pipeline() fan-out. When a
 * fan-out's agent() calls reserve past maxAgents, the breaching call throws and
 * the whole fan-out rejects — but agents already reserved and queued behind the
 * limiter would otherwise keep draining and spending. parallel()/pipeline()
 * establish a fresh store per call via fanoutScope.run(); agent() captures the
 * nearest enclosing store synchronously (before suspending on the limiter) so a
 * still-queued agent can bail once ITS OWN fan-out breaches, without touching
 * sibling fan-outs running concurrently or an enclosing fan-out when this one is
 * nested inside it (each nesting level gets its own store via ALS scoping).
 *
 * Scope note: cancellation is bounded PER breaching fan-out, not run-global — a
 * deliberate tradeoff. Deep-sixing the earlier run-global flag was required
 * because it wrongly cancelled an innocent, independently-caught sibling batch.
 * The consequence: if one fan-out breaches while an unrelated in-cap sibling or
 * a nested inner fan-out is mid-flight, that other batch is NOT cancelled and
 * finishes its already-reserved agents (still capped at maxAgents total). Only
 * the breaching fan-out's own queue is short-circuited.
 */
const fanoutScope = new AsyncLocalStorage<{ cancelled: boolean }>();
// Nesting depth is call-chain local, not run-global: sibling nested workflows
// launched by parallel() may coexist, while a child cannot recursively spawn a
// grandchild. AsyncLocalStorage preserves that distinction across awaits.
const workflowDepthScope = new AsyncLocalStorage<number>();

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
  /** Concrete provider/model used by this agent call. Absent on checkpoints and legacy journals. */
  model?: string;
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
  limiter: WorkflowLimiter;
  agentCount: number;
  spent: number;
  tokenUsage: { input: number; output: number; total: number; cost: number; cacheRead: number; cacheWrite: number };
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
  /** Stable derived child ids keyed by the parent's lexical workflow() call. */
  nestedRunIds: Map<string, string>;
  /**
   * Shared-store commit sequencing across the whole nested run tree. Agent
   * calls reserve this sequence in lexical admission order; their isolated
   * deltas are applied only when all earlier logical calls have settled.
   */
  storeOrderSequence: number;
  nextStoreOrder: number;
  pendingStoreDeltas: Map<number, Record<string, unknown>>;
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
  /** Atomic run-wide Agent Team quotas, inherited by nested frames. */
  teamMembersReserved: number;
  teamTasksReserved: number;
  teamMessagesReserved: number;
  reservedAgentSlots: number;
  /** Unconsumed maxAgents reservations, owned by their spawning batch. */
  agentSlotReservations: Map<string, number>;
  agentSlotSequence: number;
  /** Optional manager-wide provider permit. Nested frames inherit this hook. */
  providerAcquire?: (
    runId: string,
    signal: AbortSignal,
    namespace?: string,
    generation?: string,
  ) => Promise<(() => void) | null>;
  /** Run-wide admission signal used to cancel provider waiters during drain. */
  providerAdmissionController: AbortController;
  /** Bounded attempt registry; entries remain observable after logical drain. */
  lateAttemptRegistry?: {
    register: (metadata: {
      attemptId: string;
      runId: string;
      callId: string;
      generation: number;
      executionGeneration?: string;
      resourceGeneration?: string;
      label?: string;
    }) => { update: (patch: Record<string, unknown>) => void; settle: () => void } | null;
    markLate: (attemptId: string) => void;
    markLateScope?: (scope: { runId?: string; executionGeneration?: string; resourceGeneration?: string }) => void;
  };
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

/** Run-scoped concurrency gate. Closing it rejects every queued admission and
 * prevents a waiter that races with closure from starting its callback. */
export interface WorkflowLimiter {
  <T>(fn: () => Promise<T>): Promise<T>;
  close(reason?: Error): void;
}

/** Runtime instrumentation for workflow boundaries, quality helpers, and control attempts. */
export type WorkflowRuntimeEvent =
  | { type: "phase"; title: string; budget: number | null }
  | { type: "workflow"; stage: "start" | "end"; name: string; args: unknown }
  | { type: "quality"; stage: "start" | "end"; helper: "verify" | "judgePanel" | "completenessCheck" }
  | { type: "control-attempt"; helper: "retry" | "gate"; attempt: number; accepted: boolean };

/** Minimal injected agent surface used by the workflow runtime and deterministic tests. */
export interface WorkflowAgentRunner {
  run(prompt: string, options?: AgentRunOptions<TSchema>): Promise<unknown>;
}

export type WorkflowDeliveryKind = "blocker" | "critical_finding" | "decision";
export interface WorkflowDeliveryMessage {
  kind: WorkflowDeliveryKind;
  message: string;
}

export type WorkflowSteeringKind = "same_task_correction" | "blocker_answer" | "changed_fact";
export interface WorkflowSteeringMessage {
  kind: WorkflowSteeringKind;
  message: string;
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
  /** Timeout per agent in milliseconds. null/omitted means no per-agent hard timeout. */
  agentTimeoutMs?: number | null;
  /** Finite logical wall-clock deadline for this workflow frame. */
  workflowTimeoutMs?: number;
  /** Alias accepted by direct callers for workflowTimeoutMs. */
  wallClockTimeoutMs?: number;
  /** Whether to persist logs to disk. Default: true */
  persistLogs?: boolean;
  /** Run ID for persistence. Auto-generated if not provided. */
  runId?: string;
  /** Generation/owner nonce used to fence isolated worktrees across resume. */
  worktreeOwner?: string;
  /** Manager execution namespace/generation for resource diagnostics/fencing. */
  resourceGeneration?: string;
  /** Execution-generation fence for late provider attempts. */
  executionGeneration?: string;
  onWorktreeOwner?: (event: { token: string; active: boolean; runId: string; generation?: string }) => void;
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
  /** Internal hash of a nested frame's script/args; prevents stale child replay. */
  resumeContextHash?: string;
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
   * wasted retried attempts' spend. The first argument remains the historical
   * scalar token count; the optional second argument carries the provider's
   * detailed AgentUsage when it exists, without breaking older observers.
   */
  onRetrySpend?: (tokens: number, usage?: AgentUsage) => void;
  /** Internal: shared runtime inherited by a nested workflow() call. */
  sharedRuntime?: SharedRuntime;
  /** Internal: a nested frame invalidated its parent resume suffix. */
  onResumeMiss?: () => void;
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
  /** Internal manager-wide provider resource hook. */
  providerAcquire?: (
    runId: string,
    signal: AbortSignal,
    namespace?: string,
    generation?: string,
  ) => Promise<(() => void) | null>;
  /** Internal bounded late-attempt registry hook. */
  lateAttemptRegistry?: SharedRuntime["lateAttemptRegistry"];
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
   * Bridge for the runtime `deliver({ kind, message })` global: forwards one
   * task-changing workflow message into the host conversation. Absent => no-op.
   */
  onDeliver?: (delivery: WorkflowDeliveryMessage) => void | Promise<void>;
  /** Consume classified same-task updates before the next live agent() call. */
  takePendingMessages?: () => WorkflowSteeringMessage[];
  /** Called when a workflow-scoped Agent Team is created. */
  onTeamCreated?: (team: AgentTeamSnapshot) => void;
  onPhase?: (title: string) => void;
  /** Runtime behavior trace used by diagnostics and comprehension evidence. */
  onRuntimeEvent?: (event: WorkflowRuntimeEvent) => void;
  onAgentStart?: (event: { id: string; label: string; phase?: string; prompt: string; model?: string }) => void;
  /** Update the live snapshot as soon as the child resolves its concrete provider/model. */
  onAgentModelResolved?: (event: { id: string; label: string; phase?: string; model: string }) => void;
  /** Register the live child session so the host can send a targeted reply. */
  onAgentSession?: (event: {
    id: string;
    label: string;
    session: { sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> };
    send: (message: string, kind: WorkflowSteeringKind) => Promise<void>;
  }) => void;
  /** Remove the live child session after success, failure, or abort. */
  onAgentSessionEnd?: (event: {
    id: string;
    session: { sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> };
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
  onAgentHistory?: (event: { id: string; label: string; phase?: string; history: AgentHistoryEntry[] }) => void;
  onTokenUsage?: (usage: {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead?: number;
    cacheWrite?: number;
  }) => void;
}

interface CacheWarmGate {
  /** Resolves true only for the current owner request; followers wait. */
  wait: (signal?: AbortSignal) => Promise<boolean>;
  /** A real owner response established the provider cache; release all followers. */
  warm: () => void;
  /** Owner failed before warming; promote exactly one follower to a new owner. */
  release: () => void;
}

interface CacheWarmWaiter {
  resolve: (owner: boolean) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

const SHORT_CACHE_TTL_MS = 5 * 60 * 1000;
const LONG_CACHE_TTL_MS = 60 * 60 * 1000;

function cacheWarmGateTtlMs(): number | undefined {
  const retention = process.env.PI_CACHE_RETENTION?.trim().toLowerCase();
  if (retention === "none") return undefined;
  return retention === "long" ? LONG_CACHE_TTL_MS : SHORT_CACHE_TTL_MS;
}

function createCacheWarmGate(ttlMs: number): CacheWarmGate {
  let ownerClaimed = false;
  let warmed = false;
  let warmedAt = 0;
  const waiters: CacheWarmWaiter[] = [];
  const removeWaiter = (waiter: CacheWarmWaiter) => {
    const index = waiters.indexOf(waiter);
    if (index >= 0) waiters.splice(index, 1);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
  };
  const settleWaiter = (waiter: CacheWarmWaiter, owner: boolean) => {
    removeWaiter(waiter);
    waiter.resolve(owner);
  };
  return {
    wait: (signal?: AbortSignal) => {
      if (warmed && Date.now() - warmedAt >= ttlMs) {
        warmed = false;
        ownerClaimed = false;
      }
      if (warmed) return Promise.resolve(false);
      if (!ownerClaimed) {
        ownerClaimed = true;
        return Promise.resolve(true);
      }
      if (signal?.aborted) return Promise.reject(new Error("Subagent was aborted"));
      return new Promise<boolean>((resolve, reject) => {
        const waiter: CacheWarmWaiter = {
          resolve,
          reject,
          signal,
          onAbort: () => {},
        };
        waiter.onAbort = () => {
          removeWaiter(waiter);
          reject(new Error("Subagent was aborted"));
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        waiters.push(waiter);
      });
    },
    warm: () => {
      warmed = true;
      warmedAt = Date.now();
      ownerClaimed = true;
      while (waiters.length) settleWaiter(waiters[0], false);
    },
    release: () => {
      if (warmed) return;
      ownerClaimed = false;
      while (waiters.length > 0) {
        const next = waiters[0];
        if (next.signal?.aborted) {
          removeWaiter(next);
          next.reject(new Error("Subagent was aborted"));
          continue;
        }
        ownerClaimed = true;
        settleWaiter(next, true);
        break;
      }
    },
  };
}

function cacheGroupKey(
  model: string | undefined,
  tier: string | undefined,
  phase: string | undefined,
  agentType: string | undefined,
  agentDef: AgentDefinition | undefined,
  schema: TSchema | undefined,
  isolation: "worktree" | undefined,
  teamTools: boolean,
): string {
  return serializeIdentity({
    model: model ?? null,
    tier: tier ?? null,
    phase: phase ?? null,
    agentType: agentType ?? null,
    tools: agentDef?.tools ? [...agentDef.tools].sort() : null,
    disallowedTools: agentDef?.disallowedTools ? [...agentDef.disallowedTools].sort() : null,
    definitionPrompt: agentDef?.prompt ?? null,
    schema: schema ?? null,
    isolation: isolation ?? null,
    // Team agents receive a stable extra tool set. Member identity stays in
    // closures and prompts, not in the provider-visible schema.
    teamTools,
  });
}

function isAnthropicModel(model: string | undefined): boolean {
  return typeof model === "string" && /(?:^|\/)anthropic(?:\/|$)/i.test(model);
}

function createParentMessageTool(
  runId: string,
  agentId: string,
  label: string,
  deliver?: (delivery: WorkflowDeliveryMessage) => void | Promise<void>,
  isAttemptCurrent?: () => boolean,
) {
  return defineTool({
    name: "workflow_alert_parent",
    label: "Alert Main Session",
    description: "Send a blocker, critical finding, or decision the main session must act on before completion.",
    parameters: Type.Object(
      {
        kind: Type.Union([Type.Literal("blocker"), Type.Literal("critical_finding"), Type.Literal("decision")], {
          description: "Why the main session must act now.",
        }),
        message: Type.String({
          minLength: 1,
          maxLength: 8_000,
          description: "Concise update.",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params) {
      if (isAttemptCurrent && !isAttemptCurrent()) {
        throw new Error("workflow_alert_parent belongs to a completed agent attempt");
      }
      const text = params.message.trim();
      if (!text) throw new Error("workflow_alert_parent requires a non-empty message");
      const message = `[${runId} / ${agentId} / ${label} / ${params.kind}]\n${text}`;
      await deliver?.({ kind: params.kind, message });
      return {
        content: [{ type: "text", text: "Message sent to the main session." }],
        details: { runId, agentId, label, kind: params.kind },
      };
    },
  });
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
  /** Internal, per-team.spawn batch reservation; never part of resume identity. */
  slotReservation?: string;
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

interface RuntimeState {
  currentPhase?: string;
  /**
   * Per-phase soft sub-budgets carved from the run total: phase title -> the
   * ceiling and the run-wide spent at the moment the budget was declared. A phase
   * exceeding its ceiling throws TOKEN_BUDGET_EXHAUSTED while the run's overall
   * budget is untouched. Soft gate (like the global one): spent accrues after each
   * agent, so an in-flight wave may overshoot slightly.
   */
  phaseBudgets: Map<string, { budget: number; startSpent: number; warned: boolean }>;
  logs: string[];
  phases: string[];
  /** Monotonic, assigned at lexical agent() call time — the stable resume key. */
  callSeq: number;
  /**
   * Index of the first call that missed the resume journal (changed or new).
   * Longest-unchanged-prefix resume: a cached result is replayed only while
   * callIndex < firstMiss; once a call misses, it AND everything after run live.
   */
  firstMiss: number;
}

type AnyNode = Node & { [key: string]: any; start: number; end: number };

/** Find executable nondeterminism without rejecting comments or string literals. */
function findNondeterminism(node: AnyNode): "Date.now()" | "Math.random()" | "Date()" | "new Date()" | undefined {
  const stack: AnyNode[] = [node];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current.type !== "string") continue;
    if (current.type === "CallExpression") {
      const callee = current.callee as AnyNode;
      if (callee?.type === "Identifier" && callee.name === "Date" && current.arguments?.length === 0) return "Date()";
      if (callee?.type === "MemberExpression" && callee.object?.type === "Identifier") {
        // Computed access is intentionally left to the in-realm runtime guard;
        // this parser check only rejects direct executable syntax.
        if (callee.computed) continue;
        const property = callee.property?.name;
        if (callee.object.name === "Date" && property === "now") return "Date.now()";
        if (callee.object.name === "Math" && property === "random") return "Math.random()";
      }
    }
    if (
      current.type === "NewExpression" &&
      current.callee?.type === "Identifier" &&
      current.callee.name === "Date" &&
      current.arguments?.length === 0
    ) {
      return "new Date()";
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "loc" || key === "start" || key === "end" || key === "range") continue;
      if (Array.isArray(value)) {
        for (let index = value.length - 1; index >= 0; index--) {
          const child = value[index];
          if (child && typeof child === "object" && typeof child.type === "string") stack.push(child as AnyNode);
        }
      } else if (value && typeof value === "object" && typeof (value as AnyNode).type === "string") {
        stack.push(value as AnyNode);
      }
    }
  }
  return undefined;
}

function cloneBridgeValue(value: unknown, seen = new WeakSet<object>(), depth = 0, budget = { nodes: 0 }): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  if (depth > 32 || ++budget.nodes > 20_000) return "[workflow bridge value omitted]";
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === undefined) {
    return "[workflow bridge value omitted]";
  }
  if (typeof value !== "object") return "[workflow bridge value omitted]";
  if (seen.has(value)) return "[workflow bridge cycle]";
  seen.add(value);
  try {
    if (value instanceof Date || value instanceof RegExp || value instanceof Map || value instanceof Set) {
      return "[workflow bridge value omitted]";
    }
    if (Array.isArray(value)) {
      const out = [] as unknown[];
      for (let index = 0; index < value.length && index < 20_000; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        out.push(
          descriptor && "value" in descriptor
            ? cloneBridgeValue(descriptor.value, seen, depth + 1, budget)
            : "[workflow bridge accessor]",
        );
      }
      return out;
    }
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).slice(0, 20_000)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      out[key] =
        descriptor && "value" in descriptor
          ? cloneBridgeValue(descriptor.value, seen, depth + 1, budget)
          : "[workflow bridge accessor]";
    }
    return out;
  } catch {
    return "[workflow bridge value unavailable]";
  } finally {
    seen.delete(value);
  }
}

/**
 * Runtime determinism hardening, run inside the vm realm BEFORE the user script.
 * It neuters the nondeterministic builtins that would break resume (they'd make a
 * re-run produce different values than the cached journal):
 *   - Math.random()        -> throws
 *   - Date.now()           -> throws
 *   - Date() / new Date()  -> throws (no-arg); new Date(arg) still works
 * Using the vm realm's own Math/Date/Reflect (not host objects) means this adds
 * no host-`Function` escape. Note: vm is not a security sandbox — an injected
 * bridge function's `.constructor` is still the host Function, so a determined
 * script could bypass this. The guard is best-effort against ACCIDENTAL
 * nondeterminism from trusted (user / guided-LLM) scripts, not a security wall.
 */
const DETERMINISM_PRELUDE = [
  '"use strict";',
  // Workflow scripts are trusted orchestration code, but remove the easiest
  // accidental bridge-function constructor escape. This is defense-in-depth,
  // not a claim that node:vm is a hostile-code security boundary. Frozen
  // injected objects (process, budget) reject defineProperty with a TypeError,
  // so the patch silently no-ops on them — the realm-wrapper layer above is
  // what actually neutralizes their .constructor chain.
  'for (const name of ["agent", "parallel", "pipeline", "createTeam", "workflow", "verify", "judgePanel", "loopUntilDry", "completenessCheck", "retry", "gate", "checkpoint", "deliver", "log", "phase", "process", "budget", "console"]) { try { Object.defineProperty(globalThis[name], "constructor", { value: undefined, writable: false, configurable: false }); } catch {} try { const root = globalThis[name]; for (const key of Reflect.ownKeys(root || {})) { try { const child = root[key]; if (typeof child === "function") Object.defineProperty(child, "constructor", { value: undefined, writable: false, configurable: false }); } catch {} } } catch {} }',
  'Math.random = () => { throw new Error("Math.random() is unavailable in a workflow (it breaks resume); pass randomness via args or vary by index"); };',
  "{",
  "  const RealDate = Date;",
  '  const fail = (w) => { throw new Error(w + " is unavailable in a workflow (it breaks resume); pass a timestamp via args"); };',
  "  const SafeDate = function (...a) {",
  '    if (!new.target) fail("Date()");',
  '    if (a.length === 0) fail("new Date()");',
  "    return Reflect.construct(RealDate, a, SafeDate);",
  "  };",
  "  SafeDate.UTC = RealDate.UTC;",
  "  SafeDate.parse = RealDate.parse;",
  '  SafeDate.now = () => fail("Date.now()");',
  "  SafeDate.prototype = RealDate.prototype;",
  "  globalThis.Date = SafeDate;",
  "}",
].join("\n");

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult<T>> {
  if (typeof script !== "string" || script.length === 0 || script.length > 10_000_000) {
    throw new WorkflowError(
      "workflow script must be a non-empty string no larger than 10,000,000 characters",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  const started = Date.now();
  const { meta, body } = parseWorkflowScript(script);
  // Per-phase model routing from meta.phases[].model, with meta.model as the default.
  const routingConfig = parseModelRoutingFromMeta(meta.phases, meta.model);
  const maxAgents = normalizeMaxAgents(options.maxAgents ?? MAX_AGENTS_PER_RUN);
  const agentTimeoutMs = options.agentTimeoutMs !== undefined ? options.agentTimeoutMs : DEFAULT_AGENT_TIMEOUT_MS;
  const workflowTimeoutMs = normalizeWorkflowTimeout(
    options.workflowTimeoutMs ?? options.wallClockTimeoutMs ?? DEFAULT_WORKFLOW_TIMEOUT_MS,
  );
  // Unique run ID even for two direct runWorkflow() calls in the same
  // millisecond (the old `run-${timestamp}` fallback collided on log filenames
  // and `${runId}:${callIndex}` identities — H-007).
  const runId = options.runId ?? generateRunId();
  // A durable runId can be reused by resume(), so late provider callbacks need
  // both execution- and resource-generation fences to distinguish an older
  // provider promise from the new execution.
  const executionGeneration =
    options.executionGeneration ?? options.worktreeOwner ?? options.resourceGeneration ?? runId;
  const resourceGeneration = options.resourceGeneration ?? executionGeneration;
  const baseCwd = options.cwd ?? process.cwd();
  // A replay is valid only when the run-level provider context is stable. In
  // particular, opaque session/resource objects cannot be identified by value;
  // those inputs fail closed rather than risking a stale result.
  const replayContext = createReplayContextIdentity(options, baseCwd);
  // Snapshot the agentType registry ONCE per run so two agent() calls can't
  // observe a mid-run edit (determinism); a later resume re-reads it.
  const agentRegistry = options.agentRegistry ?? loadAgentRegistry(baseCwd);

  // Initialize logger
  const logger = createWorkflowLogger({
    runId,
    cwd: options.cwd ?? process.cwd(),
    persist: options.persistLogs ?? true,
    onLog: options.onLog,
  });

  const state: RuntimeState = {
    logs: [],
    // When the script declares meta.phases, default the current phase to the
    // first one so agents created before any explicit phase() call still group
    // under a declared phase instead of an orphan "(no phase)" bucket. An
    // explicit phase() (or agent({ phase })) overrides this.
    phases: meta.phases?.[0]?.title ? [meta.phases[0].title] : [],
    currentPhase: meta.phases?.[0]?.title,
    phaseBudgets: new Map(),
    callSeq: 0,
    firstMiss: Number.POSITIVE_INFINITY,
  };

  const agentRunner = options.agent ?? new WorkflowAgent(options);
  const concurrency = normalizeConcurrency(
    options.concurrency ?? Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 2),
  );
  // Global caps + budget are shared with any nested workflow() so they hold across nesting.
  // options.initialTokenUsage (resume() only) seeds spent/tokenUsage so the
  // tokenBudget ceiling holds cumulatively across a pause/resume cycle instead
  // of resetting to zero (see WorkflowRunOptions.initialTokenUsage). Deliberately
  // NOT applied when options.sharedRuntime is supplied — that branch inherits a
  // parent workflow()'s already-live counters, which must not be re-seeded.
  //
  // agentCount is NOT seeded here, unlike spent/tokenUsage — and doesn't need
  // to be: resume() always replays the whole script from callIndex 0, and
  // agent()'s `shared.agentCount++` fires unconditionally for every call
  // (cache-hit replay or live) before the replay-vs-live branch runs. That
  // replay alone reconstructs the correct cumulative count in this fresh
  // SharedRuntime by the time any new live agent executes, so maxAgents stays
  // a genuine cumulative cap across resume with no extra seeding. Token spend
  // needs seeding precisely because its cache-hit branch deliberately does NOT
  // re-run recordTokens() (to avoid double-counting already-spent tokens) —
  // there is no replay-based reconstruction for it the way there is for count.
  const shared: SharedRuntime = options.sharedRuntime ?? {
    // The fresh runtime installs its admission-aware limiter immediately below.
    // The temporary value keeps initialization explicit without exposing a
    // partially constructed SharedRuntime to nested calls.
    limiter: undefined as unknown as WorkflowLimiter,
    agentCount: 0,
    spent: options.initialTokenUsage?.total ?? 0,
    admission: "open",
    tokenUsage: options.initialTokenUsage
      ? { ...options.initialTokenUsage }
      : { input: 0, output: 0, total: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    depth: 0,
    nestedCallSeq: 0,
    nestedRunIds: new Map(),
    storeOrderSequence: 0,
    nextStoreOrder: 0,
    pendingStoreDeltas: new Map(),
    runFatalController: new AbortController(),
    providerAdmissionController: new AbortController(),
    inFlight: new Set<Promise<unknown>>(),
    teamMembersReserved: 0,
    teamTasksReserved: 0,
    teamMessagesReserved: 0,
    reservedAgentSlots: 0,
    agentSlotReservations: new Map(),
    agentSlotSequence: 0,
    providerAcquire: options.providerAcquire,
    lateAttemptRegistry: options.lateAttemptRegistry,
  };
  // Older embedders may inject a SharedRuntime created before the ordered
  // store-commit fields existed. Keep that low-level API safe without making
  // callers migrate in lockstep.
  shared.storeOrderSequence ??= 0;
  shared.nextStoreOrder ??= 0;
  shared.pendingStoreDeltas ??= new Map();
  if (!options.sharedRuntime) {
    shared.limiter = createLimiter(concurrency, () => shared.admission === "open");
  }
  const limiter = shared.limiter;
  const closeAdmission = (): void => {
    if (shared.admission === "closed") return;
    shared.admission = "closing";
    // Cancel only provider waiters that belong to this shared run. Active
    // provider permits are deliberately not released here; their release
    // closures still run from the real provider promise's finally block.
    shared.providerAdmissionController.abort();
    // Older injected SharedRuntime values may provide the legacy callable-only
    // limiter. The admission fence still blocks new work; fresh runtimes also
    // expose close() so their queued waiters are rejected immediately.
    shared.limiter.close?.();
  };
  // This frame created `shared` fresh (rather than inheriting a parent
  // workflow()'s) — i.e. it's the true top-level run, the only frame allowed
  // to declare the run's fate sealed (see SharedRuntime.runFatalController) or
  // drain/dispose the SharedStore. A nested workflow() call always passes both
  // sharedRuntime and sharedStore together (see workflowFn below), so this is
  // equivalent to `!options.sharedStore` — used at both choke points below.
  const isTopLevelRun = !options.sharedRuntime;

  // One store instance per run; nested workflow() calls inherit the parent's store
  // so all agents across nesting levels share the same key-value space.
  const store: SharedStore = options.sharedStore ?? new SharedStore();

  /**
   * Apply agent deltas in admission order, not provider completion order. Each
   * live attempt writes to a private snapshot (see the call site below), so an
   * out-of-order provider response cannot mutate the shared store before its
   * turn. Replay uses this same queue, making live and replay state identical
   * for conflicting parallel writes as well as for distinct keys.
   */
  const settleStoreDelta = (order: number, delta: Record<string, unknown>): void => {
    if (order < shared.nextStoreOrder) return;
    if (shared.pendingStoreDeltas.has(order)) {
      throw new Error(`duplicate shared-store commit order ${order}`);
    }
    shared.pendingStoreDeltas.set(order, delta);
    while (shared.pendingStoreDeltas.has(shared.nextStoreOrder)) {
      const next = shared.pendingStoreDeltas.get(shared.nextStoreOrder) as Record<string, unknown>;
      shared.pendingStoreDeltas.delete(shared.nextStoreOrder);
      store.applyDelta(next);
      shared.nextStoreOrder++;
    }
  };

  // Observer isolation (OBSERVER-001): a throwing consumer callback (e.g. a
  // UI/event sink disposed during session replacement) must NEVER be classified
  // as a provider/agent failure — otherwise a successful provider result could
  // double-charge usage, discard a committed store delta, or trigger an
  // unnecessary retry. Every host observer is wrapped here; failures are
  // diagnosed via the run log and otherwise ignored.
  const safeObserver = <A extends unknown[]>(
    name: string,
    fn?: (...args: A) => void | Promise<void>,
  ): ((...args: A) => void) | undefined =>
    fn
      ? (...args: A) => {
          try {
            const result = fn(...args);
            if (result && typeof (result as Promise<void>).catch === "function") {
              (result as Promise<void>).catch((err: unknown) => {
                logger.warn(
                  `workflow observer "${name}" rejected: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
          } catch (err) {
            logger.warn(`workflow observer "${name}" threw: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      : undefined;
  const observers = {
    onAgentStart: safeObserver("onAgentStart", options.onAgentStart),
    onAgentJournal: safeObserver("onAgentJournal", options.onAgentJournal),
    onAgentEnd: safeObserver("onAgentEnd", options.onAgentEnd),
    onAgentModelResolved: safeObserver("onAgentModelResolved", options.onAgentModelResolved),
    onAgentSession: safeObserver("onAgentSession", options.onAgentSession),
    onAgentSessionEnd: safeObserver("onAgentSessionEnd", options.onAgentSessionEnd),
    onAgentHistory: safeObserver("onAgentHistory", options.onAgentHistory),
    onRetrySpend: safeObserver("onRetrySpend", options.onRetrySpend),
    onTokenUsage: safeObserver("onTokenUsage", options.onTokenUsage),
    onPhase: safeObserver("onPhase", options.onPhase),
    onRuntimeEvent: safeObserver("onRuntimeEvent", options.onRuntimeEvent),
    onTeamCreated: safeObserver("onTeamCreated", options.onTeamCreated),
  };

  // Internal log writes are used by finalization after admission closes. The
  // public closure is fenced first, so retained script callbacks cannot mutate
  // state or the logger after closing/closed.
  let logBytes = 0;
  const appendLog = (message: unknown, enforceLimit = false) => {
    const text = String(message);
    const textBytes = Buffer.byteLength(text, "utf8");
    const nextBytes = logBytes + textBytes;
    if (state.logs.length >= MAX_WORKFLOW_LOG_ENTRIES || nextBytes > MAX_WORKFLOW_LOG_BYTES) {
      if (enforceLimit) {
        throw new WorkflowError(
          `Workflow log resource limit exceeded (${MAX_WORKFLOW_LOG_ENTRIES} entries/${MAX_WORKFLOW_LOG_BYTES} bytes)`,
          WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
          { recoverable: false },
        );
      }
      return;
    }
    state.logs.push(text);
    logBytes = nextBytes;
    logger.log(text);
  };
  const log = (message: unknown) => {
    throwIfAdmissionClosed();
    appendLog(message, true);
  };
  // Same as log() but tolerant of a closed admission: used for post-drain
  // retry/failure reporting where the message is best-effort and must not
  // reject a promise the script already stopped awaiting.
  const logBestEffort = (message: unknown) => {
    if (shared.admission !== "open") return;
    appendLog(message, true);
  };

  // Runtime deliver() global: only a classified task-changing message may wake
  // the host conversation. Progress and routine results belong in logs/finals.
  const deliver = async (value: unknown) => {
    throwIfAdmissionClosed();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new WorkflowError(
        "deliver() requires { kind: 'blocker' | 'critical_finding' | 'decision', message }",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: true },
      );
    }
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "kind" && key !== "message")) {
      throw new WorkflowError("deliver() accepts only kind and message", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: true,
      });
    }
    const kinds: ReadonlySet<string> = new Set(["blocker", "critical_finding", "decision"]);
    const text = typeof input.message === "string" ? input.message.trim() : "";
    if (typeof input.kind !== "string" || !kinds.has(input.kind) || !text || text.length > 8_000) {
      throw new WorkflowError(
        "deliver() requires a valid kind and a non-empty message within 8000 characters",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: true },
      );
    }
    await options.onDeliver?.({ kind: input.kind as WorkflowDeliveryKind, message: text });
  };

  const phase = (title: string, phaseOptions?: { budget?: number }) => {
    throwIfAdmissionClosed();
    const phaseBytes = Buffer.byteLength(String(title), "utf8");
    if (phaseBytes > 16_384 || (!state.phases.includes(title) && state.phases.length >= 256)) {
      throw new WorkflowError("Workflow phase metadata limit exceeded", WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED, {
        recoverable: false,
      });
    }
    state.currentPhase = title;
    if (!state.phases.includes(title)) state.phases.push(title);
    // Carve a soft sub-budget from the run total for work done under this phase.
    // Re-declaring re-bases from the current spent (idempotent across resume: the
    // script re-runs phase() and the ceiling is recomputed from live spent).
    if (typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0) {
      state.phaseBudgets.set(title, { budget: phaseOptions.budget, startSpent: shared.spent, warned: false });
    }
    observers.onPhase?.(title);
    observers.onRuntimeEvent?.({
      type: "phase",
      title,
      budget: typeof phaseOptions?.budget === "number" && phaseOptions.budget > 0 ? phaseOptions.budget : null,
    });
  };

  const budget = Object.freeze({
    total: options.tokenBudget ?? null,
    spent: () => shared.spent,
    remaining: () => (options.tokenBudget == null ? Infinity : Math.max(0, options.tokenBudget - shared.spent)),
  });

  const agentLimitError = () =>
    new WorkflowError(
      `Agent limit exceeded (${maxAgents}). Use maxAgents option to increase the limit.`,
      WorkflowErrorCode.AGENT_LIMIT_EXCEEDED,
      { recoverable: false },
    );

  // True on an intentional external abort (pause/stop/Esc, via options.signal)
  // OR once this run's fate has been sealed (shared.runFatalController — see
  // its doc comment). Every abort check in this file goes through this so the
  // two sources compose identically everywhere instead of only some call
  // sites remembering to check the second one.
  const isAborted = () => Boolean(options.signal?.aborted || shared.runFatalController.signal.aborted);

  const throwIfAborted = () => {
    if (isAborted()) {
      throw new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
  };

  // Reject new work once the frame has begun closing/closed (FQ-003): a
  // retained VM closure must not schedule agents or mutate a completed run.
  const throwIfAdmissionClosed = () => {
    if (shared.admission !== "open") {
      throw new WorkflowError(
        "workflow has completed; no further work can be admitted",
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: true },
      );
    }
  };

  // Anthropic caches exact request prefixes. In a parallel fan-out, let one
  // representative request warm each compatible system/tool prefix before its
  // siblings send their first request; otherwise simultaneous misses can all
  // race the provider and waste the same prefix computation.
  const cacheWarmGates = new Map<string, CacheWarmGate>();
  const teams = new Map<string, WorkflowAgentTeam>();
  const teamQuota = {
    reserveMembers: (count: number) => {
      if (shared.teamMembersReserved + count > MAX_TEAM_MEMBERS_PER_RUN)
        throw new WorkflowError(
          "Run-wide Agent Team member capacity exceeded",
          WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
          { recoverable: false },
        );
      shared.teamMembersReserved += count;
    },
    reserveTasks: (count: number) => {
      if (shared.teamTasksReserved + count > MAX_TEAM_TASKS_PER_RUN)
        throw new WorkflowError(
          "Run-wide Agent Team task capacity exceeded",
          WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
          { recoverable: false },
        );
      shared.teamTasksReserved += count;
    },
    reserveMessages: (count: number) => {
      if (shared.teamMessagesReserved + count > MAX_TEAM_MESSAGES_PER_RUN)
        throw new WorkflowError(
          "Run-wide Agent Team message capacity exceeded",
          WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
          { recoverable: false },
        );
      shared.teamMessagesReserved += count;
    },
    releaseMembers: (count: number) => {
      shared.teamMembersReserved = Math.max(0, shared.teamMembersReserved - count);
    },
    releaseTasks: (count: number) => {
      shared.teamTasksReserved = Math.max(0, shared.teamTasksReserved - count);
    },
    releaseMessages: (count: number) => {
      shared.teamMessagesReserved = Math.max(0, shared.teamMessagesReserved - count);
    },
  };
  const reserveAgentSlots = (count: number): string => {
    if (!Number.isSafeInteger(count) || count < 0 || shared.agentCount + shared.reservedAgentSlots + count > maxAgents)
      throw agentLimitError();
    const token = `${runId}:team-slots:${++shared.agentSlotSequence}`;
    shared.agentSlotReservations.set(token, count);
    shared.reservedAgentSlots += count;
    return token;
  };
  const releaseAgentSlots = (token: string): void => {
    const count = shared.agentSlotReservations.get(token);
    if (count === undefined) return;
    shared.agentSlotReservations.delete(token);
    shared.reservedAgentSlots = Math.max(0, shared.reservedAgentSlots - count);
  };
  const hasAgentSlotReservation = (token: string | undefined): boolean =>
    token !== undefined && (shared.agentSlotReservations.get(token) ?? 0) > 0;
  const consumeAgentSlot = (token: string): boolean => {
    const remaining = shared.agentSlotReservations.get(token);
    if (remaining === undefined || remaining <= 0) return false;
    if (remaining === 1) shared.agentSlotReservations.delete(token);
    else shared.agentSlotReservations.set(token, remaining - 1);
    shared.reservedAgentSlots = Math.max(0, shared.reservedAgentSlots - 1);
    return true;
  };
  const teamMembers = new Map<string, WorkflowAgentTeam>();
  let teamSeq = 0;

  const trackInFlight = <T>(promise: Promise<T>): Promise<T> => {
    // Gate new admissions at the single choke point every orchestration entry
    // (agent, workflowFn, parallel, pipeline, team.spawn) flows through.
    throwIfAdmissionClosed();
    const tracked = promise as Promise<unknown>;
    shared.inFlight.add(tracked);
    tracked.catch(() => {}).finally(() => shared.inFlight.delete(tracked));
    return promise;
  };

  const agent = (prompt: string, agentOptions: AgentOptions = {}): Promise<unknown> => {
    // Check before constructing agentImpl: async functions execute synchronously
    // until their first await, so trackInFlight alone was too late to fence the
    // callSeq reservation and other admission-side effects.
    throwIfAdmissionClosed();
    return trackInFlight(agentImpl(prompt, agentOptions));
  };

  const agentImpl = async (prompt: string, agentOptions: AgentOptions = {}) => {
    throwIfAdmissionClosed();
    throwIfAborted();

    // Reserve the lexical call position BEFORE any catchable admission check
    // (agent limit, token budget, phase budget, unknown team member). A script
    // that catches a pre-hash rejection (e.g. `try { await
    // agent('injected', { teamMember: 'missing' }) } catch {}`) must consume a
    // call index so a later unchanged call cannot replay the old journal entry
    // at the old position (NMR-001).
    const callIndex = state.callSeq++;

    // Capture the enclosing parallel()/pipeline() fan-out's cancellation batch
    // (if any) synchronously, while the ALS context of the caller is still
    // active — i.e. before suspending on the limiter below. The limiter body
    // closes over this so a still-queued agent can bail once its OWN fan-out
    // breaches the cap, without affecting sibling or outer fan-outs.
    const batch = fanoutScope.getStore();

    // Check agent limit. A fan-out that overshoots the cap has already reserved
    // and queued up to `maxAgents` agents; the breaching call throws here, and
    // parallel()/pipeline() mark their own batch cancelled so the already-queued
    // agents short-circuit before their real API call (see the limiter body).
    const batchSlotToken = agentOptions.slotReservation;
    const reservedAgentSlot = hasAgentSlotReservation(batchSlotToken);
    if (!reservedAgentSlot && shared.agentCount + shared.reservedAgentSlots >= maxAgents) {
      throw agentLimitError();
    }

    if (budget.total !== null && budget.remaining() <= 0) {
      throw new WorkflowError("workflow token budget exhausted", WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED, {
        recoverable: false,
      });
    }

    const assignedPhase = agentOptions.phase ?? state.currentPhase;

    // Per-phase soft sub-budget gate: a noisy phase can exhaust its own ceiling
    // without touching the run's overall budget. Soft (spent accrues post-agent),
    // warns once at ~80%, throws at 100%. Scripts can try/catch around a phase's
    // work so later phases still proceed.
    if (assignedPhase) {
      const pb = state.phaseBudgets.get(assignedPhase);
      if (pb) {
        const phaseSpent = shared.spent - pb.startSpent;
        if (phaseSpent >= pb.budget) {
          throw new WorkflowError(
            `phase "${assignedPhase}" token sub-budget exhausted (${pb.budget})`,
            WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED,
            { recoverable: false },
          );
        }
        if (!pb.warned && phaseSpent >= pb.budget * 0.8) {
          pb.warned = true;
          log(`phase "${assignedPhase}" at ${Math.round((phaseSpent / pb.budget) * 100)}% of its token sub-budget`);
        }
      }
    }

    const requestedLabel = agentOptions.label?.trim();
    const team = agentOptions.teamMember ? teamMembers.get(agentOptions.teamMember) : undefined;
    if (agentOptions.teamMember && !team) {
      throw new WorkflowError(
        `Unknown Agent Team member ${agentOptions.teamMember}`,
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        {
          recoverable: false,
        },
      );
    }

    // Resolve a named agentType to its bound definition (tools/model/prompt).
    const agentDef = resolveAgentType(agentOptions.agentType, agentRegistry);
    if (agentOptions.agentType && !agentDef) {
      log(`unknown agentType "${agentOptions.agentType}"; using default tools/model`);
    }

    // Model precedence: explicit agentOptions.model > agentType.model > tier > phase model.
    // The "explicit-level" model is opts.model, else the definition's model — either
    // beats tier/phase. When only a tier is set, pass undefined here so the tier (not
    // the phase model) decides inside WorkflowAgent.run().
    const explicitModel = agentOptions.model ?? agentDef?.model;
    const modelSpec =
      explicitModel ?? (agentOptions.tier ? undefined : resolveModelForPhase(assignedPhase, routingConfig));
    // Resolve the same deterministic candidate WorkflowAgent will use before
    // exposing the start/replay snapshot. This avoids falsely labeling an
    // untagged default-tier agent with the main-session model. A later concrete
    // registry resolution is propagated through onAgentModelResolved.
    let displayModel = resolveAgentModelSpec({ model: modelSpec, tier: agentOptions.tier }, options.mainModel);
    if (displayModel && options.modelRegistry) {
      const concrete = resolveModelSpecWithThinking(displayModel, options.modelRegistry);
      if (concrete.model) displayModel = concrete.resolvedSpec ?? canonicalModelSpec(concrete.model);
    }
    // A bare/fuzzy/alias spec can remain unresolved until WorkflowAgent has
    // loaded its registry. Include the registry snapshot in the identity so a
    // registry change across pause/resume cannot replay a result produced by a
    // different concrete provider/model.
    const modelRegistryIdentity = modelRegistryIdentityFor(options.modelRegistry, modelSpec ?? displayModel);

    // Deterministic resume key: assigned at lexical call time, before the limiter,
    // so parallel()/pipeline() fan-out is reproducible for a fixed script.
    // (callIndex itself was reserved at the top of agentImpl so pre-hash
    // rejections also advance the sequence — NMR-001.)
    const callHash = hashAgentCall(
      prompt,
      displayModel,
      assignedPhase,
      agentOptions,
      agentDefinitionKey(agentDef),
      options.resumeContextHash,
      modelRegistryIdentity,
      replayContext.hash,
    );
    // Store delta key: callIndex alone is NOT run-unique. A nested workflow()
    // call (see workflowFn below) shares this run's SharedStore instance but
    // restarts its own callSeq at 0, so a parent agent and a concurrently
    // running nested-run agent — or two SEQUENTIAL sibling nested runs, whose
    // depth alone would otherwise repeat — can both get callIndex 0 and
    // collide in SharedStore.agentDeltas — whichever commits last
    // steals/overwrites the other's journaled delta (and, via this same
    // deltaKey doubling as the onAgentStart/onAgentEnd/onAgentHistory event
    // id, misattributes one agent's events to the other — see item 2's
    // identity model). Composing the run's own runId (unique per top-level
    // run AND per nested run, see `${runId}-nested${++shared.nestedCallSeq}`
    // below) with callIndex makes the key unique across the whole store.
    const deltaKey = `${runId}:${callIndex}`;

    // Reserve the agent slot synchronously — atomic with the limit/budget gate
    // above (no await in between) — so a parallel() fan-out can't all observe the
    // same agentCount and overshoot maxAgents. (Token budget stays a soft gate:
    // spent accrues after each agent, matching Claude Code; in-flight agents may
    // push slightly past total, then further agent() calls throw.)
    if (reservedAgentSlot && !consumeAgentSlot(batchSlotToken as string)) throw agentLimitError();
    shared.agentCount++;
    const label = requestedLabel || defaultAgentLabel(assignedPhase, shared.agentCount);

    // Coordinator messages are injected at the next live subagent boundary.
    // They are deliberately excluded from the deterministic call hash: receiving
    // one bypasses cached replay for this call and the remainder of the run.
    // The harness, rather than the sender, supplies the source/authority envelope
    // so queued and live-targeted delivery have identical semantics.
    const pendingMessages = (options.takePendingMessages?.() ?? [])
      .map((update) => ({ ...update, message: update.message.trim() }))
      .filter((update) => update.message.length > 0);
    const teamPrompt = team ? `${team.memberPrompt(agentOptions.teamMember as string)}\n\n${prompt}` : prompt;
    const agentPrompt = pendingMessages.length
      ? `${teamPrompt}\n\n${pendingMessages
          .map((update) => formatWorkflowCoordinatorMessage(update.message, { runId, kind: update.kind }))
          .join("\n\n")}`
      : teamPrompt;
    if (Buffer.byteLength(agentPrompt, "utf8") > MAX_AGENT_PROMPT_BYTES) {
      throw new WorkflowError(
        `Agent prompt exceeds its ${MAX_AGENT_PROMPT_BYTES}-byte resource limit`,
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false, agentLabel: label },
      );
    }

    // Every admitted agent reserves one shared-store commit slot. Calls that
    // failed before this point never touched the store and therefore must not
    // create a gap in the queue.
    const storeOrder = shared.storeOrderSequence++;
    let storeOrderSettled = false;
    let storeDeltaForOrder: Record<string, unknown> | undefined;
    const settleThisStoreOrder = (delta: Record<string, unknown>): void => {
      if (storeOrderSettled) return;
      storeOrderSettled = true;
      storeDeltaForOrder = delta;
      settleStoreDelta(storeOrder, delta);
    };

    // Longest-unchanged-prefix resume: replay a cached result only while the
    // prefix is still intact — this call's index is before the first changed/new
    // call. Once any call misses, it AND everything after it run live (matching
    // Claude Code's contract), so an edited upstream call never leaves stale
    // downstream results served from the journal.
    // Namespaced the same way as SharedStore's deltaKey (deltaKey IS this
    // exact `${runId}:${callIndex}` string) so a nested workflow()'s
    // callIndex-0 can never accidentally replay the parent's callIndex-0
    // entry, or vice versa (see JournalEntry.runId).
    const cached = options.resumeJournal?.get(deltaKey);
    const cachedRunMatches = cached != null && (cached.runId === undefined || cached.runId === runId);
    const hashMatches = replayContext.stable && cachedRunMatches && cached.hash === callHash;
    const cachedEmptyOutput = hashMatches && isEmptyTextAgentResult(cached.result, agentOptions.schema);
    const markResumeMiss = (index: number): void => {
      const previous = state.firstMiss;
      state.firstMiss = Math.min(state.firstMiss, index);
      if (state.firstMiss !== previous) options.onResumeMiss?.();
    };
    // Team calls have mailbox/task-list side effects that are not represented in
    // the ordinary journal result, so replaying them would silently lose peer
    // communication. They are always rerun live on resume.
    const teamCall = team !== undefined;
    if (hashMatches && !cachedEmptyOutput && pendingMessages.length === 0 && !teamCall && callIndex < state.firstMiss) {
      const replayModel = cached.model ?? displayModel;
      observers.onAgentStart?.({ id: deltaKey, label, phase: assignedPhase, prompt: agentPrompt, model: replayModel });
      observers.onAgentEnd?.({
        id: deltaKey,
        label,
        phase: assignedPhase,
        result: cached.result,
        tokens: 0,
        model: replayModel,
        replayed: true,
      });
      // Replay goes through the same admission-order queue as a live result.
      // This is what makes a conflicting parallel write deterministic instead
      // of depending on whichever provider response happened to finish first.
      settleThisStoreOrder(cached.storeDelta ?? {});
      return cached.result;
    }
    // A genuine miss (no journal entry, hash change, or live host message) marks
    // where the unchanged prefix ends; this call and every later one run live.
    if (!hashMatches || cachedEmptyOutput || pendingMessages.length > 0 || teamCall) markResumeMiss(callIndex);

    const execution = limiter(async () => {
      const timeout = normalizeAgentTimeout(
        agentOptions.timeoutMs !== undefined ? agentOptions.timeoutMs : agentTimeoutMs,
      );
      const retryAttempts = normalizeAgentRetries(agentOptions.retries ?? options.agentRetries ?? 0);
      const maxAttempts = retryAttempts + 1;

      observers.onAgentStart?.({ id: deltaKey, label, phase: assignedPhase, prompt: agentPrompt, model: displayModel });

      // Optional per-agent worktree isolation (deterministic name -> stable resume keys).
      // Precedence: explicit call-site isolation > agentDef isolation.
      // Note: passing { isolation: undefined } falls through ?? to the def's value — there
      // is no sentinel to suppress a def's isolation at the call site. Remove the agentType
      // or override with a def that has no isolation field if opt-out is needed.
      let worktree: Worktree | undefined;
      const resolvedIsolation = agentOptions.isolation ?? agentDef?.isolation;
      // The gate is an Anthropic-specific optimization. Do not serialize
      // non-Anthropic providers or worktree agents: their effective prefix can
      // differ by provider/runtime cwd even when the coarse metadata matches.
      // The cache gate must use the concrete tier-resolved provider/model, not
      // only the coarse `tier` or session model. WorkflowAgent performs the
      // same deterministic resolution before its first request; resolving here
      // prevents siblings routed to different models from sharing a warm gate.
      const effectiveCacheModel = resolveAgentModelSpec(
        { model: modelSpec, tier: agentOptions.tier },
        options.mainModel,
      );
      const cacheTtlMs = cacheWarmGateTtlMs();
      const useCacheWarmGate =
        cacheTtlMs !== undefined && resolvedIsolation !== "worktree" && isAnthropicModel(effectiveCacheModel);
      let cacheWarmGate: CacheWarmGate | undefined;
      if (useCacheWarmGate) {
        const cacheKey = cacheGroupKey(
          effectiveCacheModel,
          agentOptions.tier,
          assignedPhase,
          agentOptions.agentType,
          agentDef,
          agentOptions.schema,
          resolvedIsolation,
          teamCall,
        );
        cacheWarmGate = cacheWarmGates.get(cacheKey);
        if (!cacheWarmGate) {
          cacheWarmGate = createCacheWarmGate(cacheTtlMs);
          cacheWarmGates.set(cacheKey, cacheWarmGate);
        }
      }
      if (resolvedIsolation === "worktree") {
        worktree = await createWorktree(baseCwd, `${runId}-${options.worktreeOwner ?? "gen"}-${callIndex}-${label}`);
        if (!worktree.isolated) {
          throw new WorkflowError(
            `Worktree isolation could not be established for "${label}"${worktree.reason ? `: ${worktree.reason}` : ""}`,
            WorkflowErrorCode.AGENT_EXECUTION_ERROR,
            { recoverable: false, agentLabel: label },
          );
        }
      }
      const runCwd = worktree?.isolated ? worktree.cwd : undefined;
      if (worktree?.isolated && worktree.ownerToken) {
        options.onWorktreeOwner?.({
          token: worktree.ownerToken,
          active: true,
          runId,
          generation: options.worktreeOwner,
        });
      }

      // Usage is tracked per retry generation, not in one mutable slot. A
      // timed-out attempt can report after the retry has started; keeping its
      // usage with its own generation prevents it from overwriting the retry's
      // usage while still allowing the late charge to be accounted exactly once.
      interface AttemptAccounting {
        usage?: AgentUsage;
        accounted: boolean;
        tokens: number;
        usedFallback: boolean;
        retrySpendPending: boolean;
        retrySpendNotified: boolean;
        accountWhenUsageArrives: boolean;
      }
      const attemptAccounting = new Map<number, AttemptAccounting>();
      let attemptSeq = 0;
      // Provider attempts may outlive the logical timeout when a host ignores
      // AbortSignal. Keep them separate from the logical call so worktree
      // cleanup can wait briefly without making the entire workflow immortal.
      const providerAttempts = new Set<Promise<unknown>>();
      // Current team-member attempt generation for THIS logical call; only the
      // current generation may mark the member running/done (TEAM-STATUS-003).
      // `team` itself was resolved earlier from teamMembers (pre-hash validation).
      const teamMemberId = agentOptions.teamMember ? String(agentOptions.teamMember) : undefined;
      const addUsage = (usage: AgentUsage, tokens: number): void => {
        shared.tokenUsage.input += usage.input;
        shared.tokenUsage.output += usage.output;
        shared.tokenUsage.cost += usage.cost;
        shared.tokenUsage.cacheRead += usage.cacheRead;
        shared.tokenUsage.cacheWrite += usage.cacheWrite;
        shared.tokenUsage.total += tokens;
        shared.spent += tokens;
      };
      const recordTokens = (result: unknown, generation: number): number => {
        const accounting = attemptAccounting.get(generation);
        if (!accounting) return 0;
        if (accounting.accounted) return accounting.tokens;
        const usage = accounting.usage;
        const tokens = usage && usage.total > 0 ? usage.total : estimateTokens(result) + estimateTokens(agentPrompt);
        if (usage) addUsage(usage, tokens);
        else {
          shared.tokenUsage.total += tokens;
          shared.spent += tokens;
        }
        accounting.accounted = true;
        accounting.tokens = tokens;
        accounting.usedFallback = !usage || usage.total <= 0;
        return tokens;
      };

      try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const myGen = ++attemptSeq;
          const accounting: AttemptAccounting = {
            accounted: false,
            tokens: 0,
            usedFallback: false,
            retrySpendPending: false,
            retrySpendNotified: false,
            accountWhenUsageArrives: false,
          };
          attemptAccounting.set(myGen, accounting);
          // Each retry owns an independent delta window. The logical deltaKey
          // remains the journal/event identity, while this key fences late tool
          // callbacks from an exhausted attempt out of the next attempt.
          const attemptDeltaKey = `${deltaKey}:attempt${myGen}`;
          const attemptGen = team && teamMemberId ? team.beginAttempt(teamMemberId) : undefined;
          let attemptPromiseTracked = false;
          let attemptPromiseSettled = false;
          let releaseProvider: (() => void) | undefined;
          let lateRecord: { update: (patch: Record<string, unknown>) => void; settle: () => void } | null = null;
          let attemptStore: SharedStore | undefined;
          const attemptId = `${runId}:${executionGeneration}:${resourceGeneration}:${callIndex}:attempt${myGen}`;
          const notifyRetrySpend = () => {
            if (
              accounting.retrySpendPending &&
              !accounting.retrySpendNotified &&
              (attemptPromiseSettled || !attemptPromiseTracked) &&
              accounting.accounted &&
              shared.admission === "open"
            ) {
              accounting.retrySpendNotified = true;
              observers.onRetrySpend?.(accounting.tokens, accounting.usage);
            }
          };
          const externalSignal = options.signal;
          let agentController!: AbortController;
          let providerWaitController!: AbortController;
          let onExternalAbort: (() => void) | undefined;
          let onRunFatal: (() => void) | undefined;
          let onProviderWaitAbort: (() => void) | undefined;
          let onProviderAdmissionAbort: (() => void) | undefined;
          try {
            throwIfAborted();
            // This agent's own fan-out already breached maxAgents while this
            // call sat queued behind the limiter; bail before spending on the
            // real API call instead of draining the whole reserved queue.
            if (batch?.cancelled) throw agentLimitError();

            // Per-attempt abort: on timeout we abort THIS agent so its session is
            // disposed and its heavy state (messages, etc.) released, instead of
            // leaving it streaming in the background — retries would otherwise
            // stack live sessions on top of each other (#109). Linked to BOTH the
            // run's external signal (outer abort — pause/stop/Esc) AND
            // shared.runFatalController (this run's fate has been sealed by a
            // sibling's non-recoverable error escaping the top-level script — see
            // SharedRuntime.runFatalController) so an in-flight sibling actually
            // winds down instead of running to completion on a doomed run. Both
            // links are torn down per attempt in finally so listeners don't accrue.
            agentController = new AbortController();
            if (isAborted()) {
              agentController.abort();
            } else {
              if (externalSignal) {
                onExternalAbort = () => agentController.abort();
                externalSignal.addEventListener("abort", onExternalAbort, { once: true });
              }
              onRunFatal = () => agentController.abort();
              shared.runFatalController.signal.addEventListener("abort", onRunFatal, { once: true });
            }
            // Provider admission has its own run-scoped signal. It cancels
            // waiters when the workflow starts draining, but it is deliberately
            // not linked to an already-granted provider attempt: that permit is
            // released only by the real provider promise's finally.
            providerWaitController = new AbortController();
            onProviderWaitAbort = () => providerWaitController.abort();
            if (agentController.signal.aborted || shared.providerAdmissionController.signal.aborted) {
              providerWaitController.abort();
            } else {
              agentController.signal.addEventListener("abort", onProviderWaitAbort, { once: true });
              onProviderAdmissionAbort = () => providerWaitController.abort();
              shared.providerAdmissionController.signal.addEventListener("abort", onProviderAdmissionAbort, {
                once: true,
              });
            }
            // The manager-wide permit is acquired immediately before the real
            // provider attempt. A queued waiter is abortable, and the release
            // closure is invoked only from the provider promise's finally. The
            // same agent timeout covers both queue admission and provider work.
            const providerWaitStartedAt = Date.now();
            if (shared.providerAcquire) {
              const providerPermitPromise = shared.providerAcquire(
                runId,
                providerWaitController.signal,
                undefined,
                resourceGeneration,
              );
              try {
                releaseProvider =
                  (await withTimeout(
                    providerPermitPromise,
                    timeout,
                    label,
                    () => agentController.abort(),
                    providerWaitController.signal,
                  )) ?? undefined;
              } catch (error) {
                // A custom coordinator may not observe AbortSignal promptly.
                // If it grants after the logical waiter timeout, release that
                // never-started permit when the acquisition promise eventually
                // settles; real provider permits remain owned by the provider
                // promise's finally below.
                void providerPermitPromise.then((release) => release?.()).catch(() => {});
                throw error;
              }
              if (!releaseProvider) {
                if (shared.admission !== "open") throwIfAdmissionClosed();
                if (isAborted()) throwIfAborted();
                throw new WorkflowError(
                  "Provider resource capacity is exhausted or the attempt was aborted while waiting",
                  WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
                  { recoverable: false, agentLabel: label },
                );
              }
            }
            const providerElapsedMs = Date.now() - providerWaitStartedAt;
            const providerTimeout = timeout === null ? null : Math.max(1, timeout - Math.max(0, providerElapsedMs));
            if (shared.admission !== "open" || agentController.signal.aborted) {
              releaseProvider?.();
              releaseProvider = undefined;
              throwIfAborted();
              throw new WorkflowError(
                "Workflow admission closed before provider start",
                WorkflowErrorCode.WORKFLOW_ABORTED,
                { recoverable: true },
              );
            }
            lateRecord =
              shared.lateAttemptRegistry?.register({
                attemptId,
                runId,
                callId: deltaKey,
                generation: myGen,
                executionGeneration,
                resourceGeneration,
                label,
              }) ?? null;
            if (shared.lateAttemptRegistry && !lateRecord) {
              releaseProvider?.();
              releaseProvider = undefined;
              throw new WorkflowError(
                "Late provider-attempt capacity is exhausted",
                WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
                { recoverable: false, agentLabel: label },
              );
            }
            // Provider tool calls are isolated from the shared store until the
            // logical agent settles. This removes completion-order races from
            // both Promise.all/parallel fan-outs and gives retries a private
            // rollback window without exposing half-finished writes to peers.
            attemptStore = new SharedStore();
            attemptStore.restore(store.snapshot());
            let attemptSession:
              | { sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void> }
              | undefined;
            let runPromise: Promise<unknown>;
            try {
              runPromise = agentRunner.run(agentPrompt, {
                label,
                // Identifiable name for persisted sessions (persistAgentSessions).
                sessionName: `workflow:${runId} ${label}`,
                schema: agentOptions.schema,
                signal: agentController.signal,
                instructions: buildAgentInstructions(assignedPhase, agentOptions, agentDef, resolvedIsolation),
                model: modelSpec,
                tier: agentOptions.tier,
                modelRegistry: options.modelRegistry,
                toolNames: agentDef?.tools,
                disallowedToolNames: agentDef?.disallowedTools,
                cacheWarmGate,
                // Per-agent store tools track this attempt-specific delta key.
                // The logical call's journal identity remains stable, but a failed
                // attempt's exhausted window rejects late writes during retries.
                systemTools: [
                  ...createAgentStoreTools(
                    attemptStore,
                    attemptDeltaKey,
                    () => myGen === attemptSeq && !agentController.signal.aborted && shared.admission === "open",
                  ),
                  createParentMessageTool(
                    runId,
                    deltaKey,
                    label,
                    options.onDeliver,
                    () => myGen === attemptSeq && !agentController.signal.aborted && shared.admission === "open",
                  ),
                  ...(team
                    ? team.createTools(
                        agentOptions.teamMember as string,
                        attemptGen,
                        () => myGen === attemptSeq && !agentController.signal.aborted && shared.admission === "open",
                      )
                    : []),
                ],
                cwd: runCwd,
                onModelResolved: (id: string) => {
                  if (myGen !== attemptSeq || shared.admission !== "open") return;
                  displayModel = id;
                  observers.onAgentModelResolved?.({ id: deltaKey, label, phase: assignedPhase, model: id });
                },
                onModelFallback: ({ tier, requestedSpec }: { tier: string; requestedSpec: string }) => {
                  if (myGen !== attemptSeq || shared.admission !== "open") return;
                  // Untagged agents' implicit default tier degrading to the session
                  // default must stay visible in the run's own log/event stream, not
                  // just a console.warn (#131) — an explicit model/tier pin instead
                  // throws MODEL_NOT_FOUND and never reaches this callback.
                  displayModel = options.mainModel;
                  if (displayModel && options.modelRegistry) {
                    const concrete = resolveModelSpecWithThinking(displayModel, options.modelRegistry);
                    if (concrete.model) displayModel = concrete.resolvedSpec ?? canonicalModelSpec(concrete.model);
                  }
                  if (displayModel)
                    observers.onAgentModelResolved?.({
                      id: deltaKey,
                      label,
                      phase: assignedPhase,
                      model: displayModel,
                    });
                  log(`default "${tier}" tier model "${requestedSpec}" unavailable — using the session default`);
                },
                onUsage: (u: AgentUsage) => {
                  // Provider usage is a per-attempt terminal callback. Ignore a
                  // duplicate callback, but never discard a late callback merely
                  // because a newer retry is active. Once an estimate was charged,
                  // reconcile that provisional scalar with the real usage; the
                  // retry-spend channel is notified once the attempt settles.
                  if (shared.admission !== "open" || accounting.usage) {
                    if (shared.admission !== "open") lateRecord?.update({ usage: u, usageState: "reported" });
                    return;
                  }
                  accounting.usage = u;
                  lateRecord?.update({ usage: u, usageState: "reported" });
                  if (accounting.accounted && accounting.usedFallback) {
                    const provisional = accounting.tokens;
                    const actual = u.total > 0 ? u.total : provisional;
                    shared.tokenUsage.total -= provisional;
                    shared.spent -= provisional;
                    addUsage(u, actual);
                    accounting.tokens = actual;
                    accounting.usedFallback = false;
                    // The retry-spend observer is deferred until the provider
                    // promise settles, so it receives this attempt's final real
                    // total exactly once (rather than an estimate plus a delta).
                  } else if (accounting.accountWhenUsageArrives) {
                    recordTokens(null, myGen);
                  }
                },
                onSessionReady: (session) => {
                  if (shared.admission !== "open") return;
                  attemptSession = session;
                  if (myGen !== attemptSeq) return;
                  team?.markRunning(agentOptions.teamMember as string, attemptGen);
                  observers.onAgentSession?.({
                    id: deltaKey,
                    label,
                    session,
                    send: (message, kind) =>
                      session.sendUserMessage(
                        formatWorkflowCoordinatorMessage(message, { runId, agentId: deltaKey, kind }),
                        { deliverAs: "steer" },
                      ),
                  });
                },
                onSessionEnd: (session) => {
                  // A timed-out attempt may dispose after a retry has registered a
                  // newer session under the same logical deltaKey. Only the
                  // current attempt may close the sender or mark a team member done
                  // (both the session identity AND the attempt generation are
                  // checked). Session cleanup remains observable after admission
                  // closes: pause/abort seals new work before AgentSession disposal,
                  // and suppressing this callback would retain the manager's sender
                  // closure and disposed session until the whole run tail settles.
                  if (attemptSession && attemptSession !== session) return;
                  if (myGen !== attemptSeq) return;
                  if (attemptSession) observers.onAgentSessionEnd?.({ id: deltaKey, session });
                  if (shared.admission !== "open") return;
                  if (attemptSession && team) team.markDone(agentOptions.teamMember as string, attemptGen);
                },
                onHistory: (history: AgentHistoryEntry[]) => {
                  if (myGen !== attemptSeq || shared.admission !== "open") return;
                  observers.onAgentHistory?.({ id: deltaKey, label, phase: assignedPhase, history });
                },
              });
            } catch (error) {
              releaseProvider?.();
              releaseProvider = undefined;
              lateRecord?.settle();
              lateRecord = null;
              throw error;
            }
            // Keep the provider promise in the shared drain as well as the
            // logical agent promise. A timed-out attempt can settle later and
            // deliver usage/history/store callbacks; the run must not close or
            // dispose the shared store until those callbacks are finished.
            const trackedAttempt = runPromise as Promise<unknown>;
            attemptPromiseTracked = true;
            shared.inFlight.add(trackedAttempt);
            providerAttempts.add(trackedAttempt);
            trackedAttempt
              .catch(() => {})
              .finally(() => {
                attemptPromiseSettled = true;
                notifyRetrySpend();
                shared.inFlight.delete(trackedAttempt);
                providerAttempts.delete(trackedAttempt);
                lateRecord?.settle();
                lateRecord = null;
                releaseProvider?.();
                releaseProvider = undefined;
              });
            // After a timeout the run() promise still settles later, rejecting with
            // "aborted" once agentController fires; the race has already resolved,
            // so swallow that to avoid an unhandled rejection.
            runPromise.catch(() => {});
            const result = await withTimeout(
              runPromise,
              providerTimeout,
              label,
              () => {
                agentController.abort();
                shared.lateAttemptRegistry?.markLate(attemptId);
              },
              agentController.signal,
              timeout,
            );

            throwIfAborted();
            if (isEmptyTextAgentResult(result, agentOptions.schema)) {
              throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                recoverable: true,
                agentLabel: label,
              });
            }

            const tokens = recordTokens(result, myGen);
            const storeDelta = attemptStore?.commitDelta(attemptDeltaKey) ?? {};
            storeDeltaForOrder = storeDelta;
            observers.onAgentJournal?.({
              index: callIndex,
              runId,
              hash: callHash,
              result,
              model: displayModel,
              storeDelta,
            });
            observers.onAgentEnd?.({
              id: deltaKey,
              label,
              phase: assignedPhase,
              result,
              tokens,
              tokenUsage: accounting.usage,
              worktree: runCwd,
              model: displayModel,
            });
            return result;
          } catch (error) {
            if (isAborted()) {
              // Logical abort closes this call even when the provider ignores
              // AbortSignal. Mark it late exactly once, but retain its permit,
              // registry entry, and worktree until the provider promise settles.
              if (attemptPromiseTracked && !attemptPromiseSettled) shared.lateAttemptRegistry?.markLate(attemptId);
              // The provider may have charged an aborted attempt before the
              // session observed the abort. Preserve confirmed usage so pause/
              // resume cannot under-enforce the cumulative token budget.
              const abortedUsage = accounting.usage;
              if (abortedUsage) recordTokens(null, myGen);
              else accounting.accountWhenUsageArrives = true;
              // Team member was aborted (pause/stop/Esc): mark aborted and
              // release any claims it held so peers are not blocked (TEAM-001).
              if (team && teamMemberId) {
                team.markAborted(teamMemberId, attemptGen);
                team.releaseClaims(teamMemberId, attemptGen);
              }
              throw error;
            }

            const workflowError = wrapError(error, { agentLabel: label });
            logger.error(`agent ${label} attempt ${attempt}/${maxAttempts} failed: ${workflowError.message}`);
            const tokens = recordTokens(null, myGen);
            // This attempt's store writes must not survive it. Each attempt has
            // its own delta window; rolling it back removes writes visible to
            // concurrently-running siblings and prevents a late callback from
            // contaminating a later successful attempt's journaled delta.
            // Unconditional: this covers both retries and exhausted failures.
            attemptStore?.discardDelta(attemptDeltaKey);

            if (workflowError.recoverable && attempt < maxAttempts) {
              logBestEffort(
                `agent "${label}" attempt ${attempt}/${maxAttempts} failed: ${workflowError.code} ${workflowError.message}; retrying`,
              );
              // This attempt's spend already accrued into shared.spent/tokenUsage
              // above (recordTokens) — but it will never reach onAgentEnd (only
              // the final attempt does), so report it on the dedicated channel
              // instead (see WorkflowRunOptions.onRetrySpend).
              accounting.retrySpendPending = true;
              notifyRetrySpend();
              // The retry may re-claim tasks / re-send messages; release this
              // attempt's claims so a retry (or a peer after exhaustion) can
              // claim them (TEAM-RETRY-002). Messages are at-least-once by design.
              if (team && teamMemberId) team.releaseClaims(teamMemberId, attemptGen);
              continue;
            }

            // Terminal failure for this logical call: mark the member failed so
            // team_members does not report a never-started `registered` (TEAM-
            // STATUS-004) and release any stranded claims (TEAM-RETRY-002).
            if (team && teamMemberId) {
              team.markFailed(teamMemberId, attemptGen);
              team.releaseClaims(teamMemberId, attemptGen);
            }

            observers.onAgentEnd?.({
              id: deltaKey,
              label,
              phase: assignedPhase,
              result: null,
              tokens,
              tokenUsage: accounting.usage,
              worktree: runCwd,
              model: displayModel,
              error: workflowError.message,
              errorCode: workflowError.code,
              recoverable: workflowError.recoverable,
            });

            if (workflowError.recoverable) {
              logBestEffort(
                `agent "${label}" exhausted ${maxAttempts} attempt${maxAttempts === 1 ? "" : "s"}: ${workflowError.code} ${workflowError.message}`,
              );
              return null;
            }
            throw workflowError;
          } finally {
            // Drop this attempt's abort listeners so they don't accrue one entry
            // per attempt on the run's signal / runFatalController for the whole
            // run (#109 hygiene).
            if (onExternalAbort) externalSignal?.removeEventListener("abort", onExternalAbort);
            if (onRunFatal) shared.runFatalController.signal.removeEventListener("abort", onRunFatal);
            if (onProviderWaitAbort && agentController)
              agentController.signal.removeEventListener("abort", onProviderWaitAbort);
            if (onProviderAdmissionAbort)
              shared.providerAdmissionController.signal.removeEventListener("abort", onProviderAdmissionAbort);
            attemptStore?.dispose();
          }
        }
        return null;
      } finally {
        // Abort is cooperative: a provider may still be using the worktree after
        // the logical timeout has fired. Wait through a bounded grace period;
        // if it ignores abort, retain the worktree and schedule best-effort
        // cleanup after the provider eventually settles rather than deleting a
        // directory that late callbacks may still access.
        if (worktree?.isolated) {
          const isolatedWorktree = worktree;
          const removeOwnedWorktree = async (): Promise<void> => {
            const removal = await removeWorktreeDetailed(isolatedWorktree);
            if (removal.checkoutRemoved && isolatedWorktree.ownerToken) {
              options.onWorktreeOwner?.({
                token: isolatedWorktree.ownerToken,
                active: false,
                runId,
                generation: options.worktreeOwner,
              });
            }
            if (!removal.complete) {
              logger.warn(`worktree branch cleanup for ${label} remains in the durable reclaim queue`);
            }
          };
          const pending = [...providerAttempts];
          if (pending.length > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), WORKFLOW_DRAIN_GRACE_MS);
            });
            const settled = Promise.allSettled(pending).then(() => "settled" as const);
            const outcome = await Promise.race([settled, timeout]);
            if (timer) clearTimeout(timer);
            if (outcome === "timeout") {
              logger.warn(`retaining worktree for timed-out agent ${label} until its provider attempt settles`);
              void settled.then(removeOwnedWorktree).catch(() => {});
            } else {
              await removeOwnedWorktree();
            }
          } else {
            await removeOwnedWorktree();
          }
        }
      }
    }).then(
      (result) => {
        settleThisStoreOrder(storeDeltaForOrder ?? {});
        return result;
      },
      (error) => {
        settleThisStoreOrder({});
        throw error;
      },
    );
    return execution;
  };

  type ParallelThunk = () => Promise<unknown>;
  const parallel = (input: ParallelThunk[] | ParallelThunk, ...rest: ParallelThunk[]): Promise<unknown[]> => {
    // Fence admission before validating or invoking thunks: validation and the
    // fan-out body can themselves mutate callSeq, journals, stores, and
    // observers through retained closures.
    throwIfAdmissionClosed();
    // Non-async on purpose (FQ-001): returning trackInFlight(execution) directly
    // (instead of an async wrapper that adopts it) means an un-awaited call's
    // rejection is handled by trackInFlight's attached handler, not leaked as a
    // process-level unhandledRejection from a second, unobserved adopted promise.
    throwIfAborted();
    if (Array.isArray(input) && rest.length > 0) {
      throw new TypeError("parallel() accepts either one array of functions or variadic functions, not both");
    }
    // The array form remains canonical for mapped fan-out. Accepting variadic
    // thunks is a small compatibility guard for a common model-authored shape:
    // parallel(() => agent(...), () => agent(...)). Both forms have identical
    // ordering, cancellation, and resource-limit semantics.
    const thunks = Array.isArray(input) ? input : [input, ...rest];
    if (thunks.length > MAX_FANOUT_ITEMS) {
      throw new WorkflowError(
        `parallel() fan-out exceeds its ${MAX_FANOUT_ITEMS}-item limit`,
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    if (thunks.some((thunk) => typeof thunk !== "function")) {
      throw new TypeError(
        "parallel() expects functions, not promises. Use parallel([() => agent(...)]) or parallel(() => agent(...), ...)",
      );
    }
    // Batch-scoped cancellation: agent() calls made (directly or transitively)
    // from these thunks see this store via fanoutScope.getStore(). A breach in
    // THIS fan-out flips `cancelled` so its own still-queued agents bail, without
    // touching a sibling fan-out running concurrently or an enclosing one.
    const batch = { cancelled: false };
    const execution = fanoutScope.run(batch, () =>
      Promise.all(
        thunks.map(async (thunk, index) => {
          try {
            return await thunk();
          } catch (error) {
            if (isAborted()) throw error;
            const workflowError = wrapError(error);
            // Non-recoverable failures (token budget / agent limit exhausted) must
            // halt the whole run, exactly like a directly-awaited agent() — not be
            // swallowed into a null in the result array.
            if (!workflowError.recoverable) {
              // Only a breached agent cap cancels the rest of this batch; the
              // token budget stays a soft gate by design (in-flight agents may
              // finish past it), and other non-recoverable errors don't imply
              // the rest of the batch is doomed.
              if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
              throw workflowError;
            }
            log(`parallel[${index}] failed: ${workflowError.message}`);
            return null;
          }
        }),
      ),
    );
    return trackInFlight(execution);
  };

  const pipeline = (
    items: unknown[],
    ...stages: Array<(prev: unknown, original: unknown, index: number) => unknown>
  ): Promise<unknown[]> => {
    // Fence admission before validating or invoking stages: a retained
    // pipeline closure must not start work after the frame has closed.
    throwIfAdmissionClosed();
    // Non-async for the same reason as parallel() (FQ-001).
    throwIfAborted();
    if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
    if (items.length > MAX_FANOUT_ITEMS) {
      throw new WorkflowError(
        `pipeline() fan-out exceeds its ${MAX_FANOUT_ITEMS}-item limit`,
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    if (stages.some((stage) => typeof stage !== "function")) {
      throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
    }
    // Batch-scoped cancellation — see parallel() for the rationale.
    const batch = { cancelled: false };
    const execution = fanoutScope.run(batch, () =>
      Promise.all(
        items.map(async (item, index) => {
          let value: unknown = item;
          for (const stage of stages) {
            try {
              throwIfAborted();
              value = await stage(value, item, index);
              throwIfAborted();
            } catch (error) {
              if (isAborted()) throw error;
              const workflowError = wrapError(error);
              // Non-recoverable failures halt the whole run (see parallel()).
              if (!workflowError.recoverable) {
                if (workflowError.code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) batch.cancelled = true;
                throw workflowError;
              }
              log(`pipeline[${index}] failed: ${workflowError.message}`);
              return null;
            }
          }
          return value;
        }),
      ),
    );
    return trackInFlight(execution);
  };

  /**
   * Create a workflow-scoped Agent Team. Teams add peer messaging and a shared
   * task board, but deliberately reuse agent(), parallel(), and this run's
   * limiter/budget. That keeps one authoritative scheduler and makes team work
   * visible in the normal workflow history.
   */
  const createTeam = (name: unknown, teamOptions?: { maxMembers?: number }) => {
    // Team creation mutates the run's team registry and emits observers.
    throwIfAdmissionClosed();
    const teamName = String(name ?? "").trim();
    if (!teamName) throw new TypeError("createTeam(name) requires a non-empty name");
    if (teams.size >= MAX_TEAMS_PER_RUN) {
      throw new WorkflowError(
        `Workflow team limit exceeded (${MAX_TEAMS_PER_RUN})`,
        WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
        { recoverable: false },
      );
    }
    const requestedMax = teamOptions?.maxMembers;
    const maxMembers =
      typeof requestedMax === "number" && Number.isFinite(requestedMax) && requestedMax >= 1
        ? Math.min(Math.floor(requestedMax), Math.min(100, MAX_TEAM_MEMBERS_PER_RUN))
        : 100;
    const team = new WorkflowAgentTeam(`${runId}:team:${++teamSeq}`, teamName, maxMembers, { quota: teamQuota });
    teams.set(team.id, team);
    log(`agent team "${team.name}" created (${team.id})`);
    observers.onTeamCreated?.(team.snapshot());

    const spawn = (specs: AgentTeamSpawnSpec[]): Promise<unknown[]> => {
      // Fence before plan/commit: commitSpawn mutates membership and inbox
      // state before the delegated parallel() call can perform its own check.
      throwIfAdmissionClosed();
      // Non-async for the same reason as parallel() (FQ-001): un-awaited spawns
      // must not leak an unobserved adopted rejection.
      if (!Array.isArray(specs)) throw new TypeError("team.spawn expects an array of member specs");
      // TEAM-SPAWN-005: preflight the ENTIRE batch (input validity, duplicate
      // IDs, capacity) BEFORE mutating any membership, and check cross-team
      // ownership against the global registry before commit — a rejected batch
      // must not leave partial members/inboxes behind.
      const planned = team.planSpawn(specs);
      let slotReservation: string;
      try {
        slotReservation = reserveAgentSlots(specs.length);
      } catch (error) {
        team.releaseSpawnReservation(planned);
        throw error;
      }
      try {
        for (const entry of planned) {
          if (entry.isNew && entry.memberId) {
            const owner = teamMembers.get(entry.memberId);
            if (owner && owner !== team) {
              throw new Error(`Agent Team member ID ${entry.memberId} is already registered`);
            }
          }
        }
      } catch (error) {
        team.releaseSpawnReservation(planned);
        releaseAgentSlots(slotReservation);
        throw error;
      }
      let memberIds: string[];
      try {
        memberIds = team.commitSpawn(planned);
      } catch (error) {
        releaseAgentSlots(slotReservation);
        throw error;
      }
      for (const memberId of memberIds) teamMembers.set(memberId, team);
      const thunks = planned.map((entry, index) => {
        const spec = specs[index] as AgentTeamSpawnSpec;
        const memberId = memberIds[index] as string;
        return () =>
          agent(String(spec.prompt).trim(), {
            ...((spec.options && typeof spec.options === "object" ? spec.options : {}) as AgentOptions),
            label: entry.label,
            teamMember: memberId,
            slotReservation,
          });
      });
      let execution: Promise<unknown[]>;
      try {
        execution = parallel(thunks);
      } catch (error) {
        // Synchronous admission failures do not enter Promise.finally and no
        // thunk was admitted. Roll back the complete membership transaction,
        // including existing-member metadata and run-wide member quota.
        const removed = team.rollbackCommittedSpawn(planned);
        for (const memberId of removed) {
          if (teamMembers.get(memberId) === team) teamMembers.delete(memberId);
        }
        releaseAgentSlots(slotReservation);
        throw error;
      }
      team.finalizeCommittedSpawn(planned);
      const derived = execution.finally(() => {
        // Only this batch's unconsumed reservation is returned. A concurrent
        // team.spawn owns a different token and is never touched here.
        releaseAgentSlots(slotReservation);
      });
      // Promise.finally() creates a new adopted promise. Keep the returned
      // promise's rejection observable to the caller while also marking the
      // derived branch handled for deliberately un-awaited team.spawn calls.
      derived.catch(() => {});
      return derived;
    };

    const api = {
      id: team.id,
      name: team.name,
      addTask: (title: string, description?: string, assignee?: string) => {
        throwIfAdmissionClosed();
        return team.addTask(title, description, assignee);
      },
      addTasks: (tasks: Array<{ title: string; description?: string; assignee?: string }>) => {
        throwIfAdmissionClosed();
        const currentTasks = [...teams.values()].reduce((total, item) => total + item.snapshot().tasks.length, 0);
        if (currentTasks + tasks.length > MAX_TEAM_TASKS_PER_RUN) {
          throw new WorkflowError(
            "Run-wide Agent Team task capacity exceeded",
            WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
            { recoverable: false },
          );
        }
        return team.addTasks(tasks);
      },
      listMembers: () => team.listMembers(),
      listTasks: () => team.listTasks(),
      snapshot: () => team.snapshot(),
      send: (to: string, message: string) => {
        throwIfAdmissionClosed();
        const pending = [...teams.values()].reduce((total, item) => total + item.snapshot().pendingMessages, 0);
        if (pending >= MAX_TEAM_MESSAGES_PER_RUN) {
          throw new WorkflowError(
            "Run-wide Agent Team message capacity exceeded",
            WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
            { recoverable: false },
          );
        }
        return team.sendFromWorkflow(to, message);
      },
      broadcast: (message: string) => {
        throwIfAdmissionClosed();
        return team.broadcastFromWorkflow(message);
      },
      spawn,
    };
    return Object.freeze(api);
  };

  // Nested workflow(): run a saved workflow (or a raw script) inline, sharing this
  // run's limiter/counters/budget so the global caps hold. One level deep only.
  const workflowImpl = async (nameOrScript: string, childArgs?: unknown) => {
    throwIfAdmissionClosed();
    throwIfAborted();
    const workflowDepth = workflowDepthScope.getStore() ?? 0;
    if (workflowDepth >= 1) {
      throw new WorkflowError("workflow() can nest only one level deep", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
        recoverable: false,
      });
    }
    const resolved = options.loadSavedWorkflow?.(String(nameOrScript));
    const childScript = resolved ?? String(nameOrScript);
    const workflowName = String(nameOrScript);
    // Derive nested identity from the parent's lexical call position and keep
    // the first assigned id stable across a pause/resume replay. A global
    // monotonic counter alone advances again on resume and makes the child's
    // persisted `${runId}:index` journal keys unreachable.
    const nestedCallIndex = state.callSeq++;
    const nestedIdentity = `${runId}:workflow:${nestedCallIndex}`;
    let childRunId = shared.nestedRunIds.get(nestedIdentity);
    if (!childRunId) {
      childRunId = `${runId}-nested${++shared.nestedCallSeq}`;
      shared.nestedRunIds.set(nestedIdentity, childRunId);
    }
    observers.onRuntimeEvent?.({ type: "workflow", stage: "start", name: workflowName, args: childArgs });
    // A miss before this nested call invalidates every downstream cached result,
    // including child-frame entries whose own hashes still match. Conversely,
    // a nested call before the first parent miss can safely consume its
    // runId-namespaced journal.
    const childResumeJournal = nestedCallIndex < state.firstMiss ? options.resumeJournal : undefined;
    try {
      // Nested frames deliberately do not consume the parent journal. Their
      // child script, args, and shared-store starting state are not part of the
      // child agent hash, so replaying a parent entry here could serve a stale
      // result after a nested script or argument change. The child re-executes
      // live while still sharing the parent's limiter, budget, and store.
      // Since the child can mutate that shared store, all later parent calls
      // must also run live rather than replaying an old storeDelta.
      const child = await workflowDepthScope.run(workflowDepth + 1, () =>
        runWorkflow(childScript, {
          ...options,
          args: childArgs,
          sharedRuntime: shared,
          // Propagate the parent's store and journal so nested agents share state
          // and can replay their own runId-namespaced entries on resume. The child
          // receives the same map, but its distinct derived runId prevents parent/
          // child call-index collisions.
          sharedStore: store,
          resumeJournal: childResumeJournal,
          resumeFromRunId: childResumeJournal ? options.resumeFromRunId : undefined,
          resumeContextHash: createHash("sha256")
            .update(
              serializeIdentity({
                script: childScript,
                args: childArgs === undefined ? null : childArgs,
                name: workflowName,
              }),
            )
            .digest("hex"),
          runId: childRunId,
          persistLogs: false,
          // A child miss changes the shared store and therefore invalidates
          // every parent call after the nested workflow boundary. Propagate
          // that boundary miss instead of letting the parent replay a stale
          // suffix from its own journal.
          onResumeMiss: () => {
            const previous = state.firstMiss;
            state.firstMiss = Math.min(state.firstMiss, nestedCallIndex);
            if (state.firstMiss !== previous) options.onResumeMiss?.();
          },
        }),
      );
      return child.result;
    } finally {
      observers.onRuntimeEvent?.({ type: "workflow", stage: "end", name: workflowName, args: childArgs });
    }
  };

  const workflowFn = (nameOrScript: string, childArgs?: unknown): Promise<unknown> =>
    trackInFlight(workflowImpl(nameOrScript, childArgs));

  // ── Quality-pattern stdlib: reusable, deterministic helpers built purely on
  // agent()/parallel() (so callSeq ordering stays stable and resume keeps working).
  // Injected as globals so workflow scripts compose them directly. ──

  const VERIFY_SCHEMA = {
    type: "object",
    properties: { real: { type: "boolean" }, reason: { type: "string" } },
    required: ["real"],
  };
  const verify = async (
    item: unknown,
    opts: { reviewers?: number; threshold?: number; lens?: string | string[] } = {},
  ) => {
    throwIfAdmissionClosed();
    observers.onRuntimeEvent?.({ type: "quality", stage: "start", helper: "verify" });
    const reviewers = normalizeHelperCount(opts.reviewers, 2);
    const threshold = opts.threshold ?? 0.5;
    const lenses = opts.lens ? (Array.isArray(opts.lens) ? opts.lens : [opts.lens]) : [];
    const claim = typeof item === "string" ? item : serializeBounded(item, { maxBytes: 32_000 });
    const votes = (
      await parallel(
        Array.from(
          { length: reviewers },
          (_v, i) => () =>
            agent(
              `Adversarially review whether the following is REAL/correct. Try to refute it; default to real=false if unsure.${lenses.length ? ` Focus lens: ${lenses[i % lenses.length]}.` : ""}\n\n${claim}`,
              { label: `verify ${i + 1}`, schema: VERIFY_SCHEMA },
            ),
        ),
      )
    ).filter(Boolean) as Array<{ real?: boolean; reason?: string }>;
    const realCount = votes.filter((v) => v?.real).length;
    const verdict = {
      real: votes.length > 0 && realCount / votes.length >= threshold,
      realCount,
      total: votes.length,
      votes,
    };
    observers.onRuntimeEvent?.({ type: "quality", stage: "end", helper: "verify" });
    return verdict;
  };

  const JUDGE_SCHEMA = {
    type: "object",
    properties: { score: { type: "number" }, reason: { type: "string" } },
    required: ["score"],
  };
  const judgePanel = async (attempts: unknown[], opts: { judges?: number; rubric?: string } = {}) => {
    throwIfAdmissionClosed();
    observers.onRuntimeEvent?.({ type: "quality", stage: "start", helper: "judgePanel" });
    const judges = normalizeHelperCount(opts.judges, 3);
    const rubric = opts.rubric ?? "overall quality and correctness";
    const scored = (
      await parallel(
        (Array.isArray(attempts) ? attempts : []).map((att, idx) => async () => {
          const text = typeof att === "string" ? att : serializeBounded(att, { maxBytes: 32_000 });
          const js = (
            await parallel(
              Array.from(
                { length: judges },
                (_v, j) => () =>
                  agent(
                    `Score this candidate from 0 to 1 on: ${rubric}. Reply with the score.\n\nCandidate:\n${text}`,
                    {
                      label: `judge ${idx + 1}.${j + 1}`,
                      schema: JUDGE_SCHEMA,
                    },
                  ),
              ),
            )
          ).filter(Boolean) as Array<{ score?: number }>;
          const score = js.length ? js.reduce((s, v) => s + (Number(v?.score) || 0), 0) / js.length : 0;
          return { index: idx, attempt: att, score, judgments: js };
        }),
      )
    ).filter(Boolean) as Array<{ index: number; attempt: unknown; score: number; judgments: unknown[] }>;
    // Highest mean score; stable tie-break by input index.
    let best = scored[0];
    for (const s of scored) if (s.score > best.score || (s.score === best.score && s.index < best.index)) best = s;
    observers.onRuntimeEvent?.({ type: "quality", stage: "end", helper: "judgePanel" });
    return best;
  };

  const loopUntilDry = async (opts: {
    round: (roundIndex: number) => Promise<unknown[]> | unknown[];
    key?: (item: unknown) => string;
    consecutiveEmpty?: number;
    maxRounds?: number;
  }) => {
    throwIfAdmissionClosed();
    if (!opts || typeof opts.round !== "function")
      throw new TypeError("loopUntilDry requires { round: (i) => items[] }");
    const key = opts.key ?? ((x: unknown) => serializeIdentity(x));
    const consecutiveEmpty = normalizeHelperCount(opts.consecutiveEmpty, 2);
    const maxRounds = normalizeHelperCount(opts.maxRounds, 50);
    const seen = new Set<string>();
    const all: unknown[] = [];
    let dry = 0;
    for (let r = 0; r < maxRounds && dry < consecutiveEmpty; r++) {
      let items: unknown[];
      try {
        items = (await opts.round(r)) ?? [];
      } catch (error) {
        // Budget / agent-limit exhaustion: return the partial result, don't abort.
        const code = (error as { code?: string })?.code;
        if (code === WorkflowErrorCode.TOKEN_BUDGET_EXHAUSTED || code === WorkflowErrorCode.AGENT_LIMIT_EXCEEDED) break;
        throw error;
      }
      const roundItems = Array.isArray(items) ? items : [];
      if (roundItems.length > MAX_FANOUT_ITEMS || all.length + roundItems.length > MAX_FANOUT_ITEMS) {
        throw new WorkflowError(
          `loopUntilDry retained-item limit exceeded (${MAX_FANOUT_ITEMS})`,
          WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
          { recoverable: false },
        );
      }
      const fresh = roundItems.filter((x) => x != null && !seen.has(key(x)));
      if (!fresh.length) {
        dry++;
        continue;
      }
      dry = 0;
      for (const x of fresh) {
        seen.add(key(x));
        all.push(x);
      }
    }
    return all;
  };

  const COMPLETENESS_SCHEMA = {
    type: "object",
    properties: { complete: { type: "boolean" }, missing: { type: "array", items: { type: "string" } } },
    required: ["complete"],
  };
  const completenessCheck = async (taskArgs: unknown, results: unknown) => {
    throwIfAdmissionClosed();
    observers.onRuntimeEvent?.({ type: "quality", stage: "start", helper: "completenessCheck" });
    const verdict = await agent(
      `Given the task and the results gathered so far, list what is still MISSING (modalities not covered, claims unverified, gaps). Be specific and concise.\n\nTask:\n${serializeBounded(taskArgs, { maxBytes: 4_000 })}\n\nResults so far:\n${serializeBounded(results, { maxBytes: 4_000 })}`,
      { label: "completeness critic", schema: COMPLETENESS_SCHEMA },
    );
    observers.onRuntimeEvent?.({ type: "quality", stage: "end", helper: "completenessCheck" });
    return verdict;
  };

  // Thin bounded-retry / validation-gate combinators. Sugar over the for-loop +
  // agent() pattern, but each attempt is a real agent() call so it auto-journals
  // under a stable callSeq (resume-safe). No backoff: there is no timer in the vm
  // and a delay has no resume value. NOTE: attempt N+1's call hash depends on N's
  // live result, so a retry/gate chain cache-miss-cascades on resume (correct).
  const retry = async (
    thunk: (attempt: number) => Promise<unknown> | unknown,
    opts: { attempts?: number; until?: (r: unknown) => boolean } = {},
  ) => {
    throwIfAdmissionClosed();
    const attempts = normalizeHelperCount(opts.attempts, 3);
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(i);
      const accepted = !opts.until || opts.until(last);
      observers.onRuntimeEvent?.({ type: "control-attempt", helper: "retry", attempt: i + 1, accepted });
      if (accepted) return last;
    }
    return last; // attempts exhausted — return the last result (caller inspects it)
  };
  const gate = async (
    thunk: (feedback: string | undefined, attempt: number) => Promise<unknown> | unknown,
    validator: (r: unknown) => Promise<{ ok: boolean; feedback?: string }> | { ok: boolean; feedback?: string },
    opts: { attempts?: number } = {},
  ) => {
    throwIfAdmissionClosed();
    const attempts = normalizeHelperCount(opts.attempts, 3);
    let feedback: string | undefined;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      last = await thunk(feedback, i);
      const verdict = await validator(last);
      const accepted = Boolean(verdict?.ok);
      observers.onRuntimeEvent?.({ type: "control-attempt", helper: "gate", attempt: i + 1, accepted });
      if (accepted) return { ok: true, value: last, attempts: i + 1 };
      feedback = verdict?.feedback; // fed into the next attempt
    }
    return { ok: false, value: last, attempts };
  };

  // Deterministic, journaled, replayable human checkpoint. Spends no tokens, so it
  // is gated on the agent counter + abort (not budget). On resume the human's reply
  // replays by callIndex exactly like a cached agent() — the genuine edge over CC,
  // whose steering is in-session only. Headless (no UI threaded in): takes the
  // declared default and journals THAT, so a detached/background run never hangs.
  const checkpoint = async (promptText: string, checkpointOptions: CheckpointOptions = {}) => {
    // JSON.stringify drops an undefined journal result. Reject it on both live
    // and replay paths rather than silently changing the human's answer.
    const requireCheckpointResult = (result: unknown): unknown => {
      if (result !== undefined) return result;
      throw new WorkflowError(
        "checkpoint() requires confirm/default to resolve to a defined value; undefined cannot be journaled or replayed",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    };
    // Admission must precede validation, callSeq reservation, and any human/UI
    // confirmation so a retained checkpoint closure is side-effect free.
    throwIfAdmissionClosed();
    throwIfAborted();
    if (typeof promptText !== "string") throw new TypeError("checkpoint(promptText, options?) needs a prompt string");
    if (shared.agentCount >= maxAgents) {
      throw agentLimitError();
    }
    const callIndex = state.callSeq++;
    const callHash = hashCheckpoint(promptText, checkpointOptions, options.resumeContextHash);
    // Namespaced by runId like agent()'s deltaKey — see JournalEntry.runId.
    const journalKey = `${runId}:${callIndex}`;
    const cached = options.resumeJournal?.get(journalKey);
    const cachedRunMatches = cached != null && (cached.runId === undefined || cached.runId === runId);
    if (cachedRunMatches && cached.hash === callHash && callIndex < state.firstMiss) {
      shared.agentCount++;
      return requireCheckpointResult(cached.result); // replay the journaled human reply
    }
    if (cached == null || !cachedRunMatches || cached.hash !== callHash) {
      const previous = state.firstMiss;
      state.firstMiss = Math.min(state.firstMiss, callIndex);
      if (state.firstMiss !== previous) options.onResumeMiss?.();
    }
    shared.agentCount++;

    let reply: unknown;
    if (options.confirm) {
      reply = await options.confirm(promptText, checkpointOptions);
    } else if (checkpointOptions.headless === "abort") {
      throw new WorkflowError(
        `checkpoint "${promptText}" needs human input but none is available (headless run)`,
        WorkflowErrorCode.WORKFLOW_ABORTED,
        { recoverable: false },
      );
    } else {
      reply = checkpointOptions.default ?? true;
    }
    throwIfAborted();
    throwIfAdmissionClosed();
    const persistedReply = requireCheckpointResult(reply);
    observers.onAgentJournal?.({ index: callIndex, runId, hash: callHash, result: persistedReply });
    return persistedReply;
  };

  const runtimeImplementations = {
    agent,
    parallel,
    pipeline,
    createTeam,
    workflow: workflowFn,
    verify,
    judgePanel,
    loopUntilDry,
    completenessCheck,
    retry,
    gate,
    checkpoint,
    deliver,
    log,
    phase,
    // args is replaced with a VM-realm clone below; do not expose the host
    // object (or a host Date/Math prototype) through the initial bindings.
    args: undefined,
    cwd: options.cwd ?? process.cwd(),
    process: Object.freeze({ cwd: () => options.cwd ?? process.cwd() }),
    budget,
    console: {
      log,
      info: log,
      warn: (m: unknown) => log(`[warn] ${String(m)}`),
      error: (m: unknown) => log(`[error] ${String(m)}`),
    },
  } satisfies WorkflowRuntimeImplementations;
  const { globals: projectGlobals, diagnostics: bindingDiagnostics } =
    WORKFLOW_CAPABILITY_CONTRACT.assembleRuntimeBindings(runtimeImplementations);
  for (const diagnostic of bindingDiagnostics) logger.warn(diagnostic.message);
  // Inject bridge globals under HIDDEN keys, then re-expose them through
  // wrappers created inside the vm realm. A host function injected directly
  // keeps the host Function as its .constructor, which is the classic
  // `fn.constructor("return process")()` escape; a wrapper built by vm-realm
  // code closes over the host implementation but presents a vm-realm
  // prototype chain. Return values are re-wrapped with the vm realm's
  // Promise.resolve so a host Promise's .constructor is never exposed either.
  const hostBridge: Record<string, unknown> = {};
  const bridgeGlobals: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(projectGlobals)) {
    if (typeof value === "function") {
      hostBridge[`__host_${name}`] = value;
    } else {
      bridgeGlobals[name] = value;
    }
  }
  const context = vm.createContext({
    ...hostBridge,
    ...bridgeGlobals,
    // Object/Array/JSON/Math/Date/Promise/Set/Map/etc. come from the vm realm
    // itself — we deliberately do NOT inject host built-ins, whose .constructor
    // would be the host Function (a determinism-guard bypass). Math/Date are
    // neutered in-realm by DETERMINISM_PRELUDE below.
  });
  // Build the realm-side wrappers in one vm evaluation. The wrapper generator
  // runs in the vm realm, so `Function` here is the VM realm's Function and
  // every wrapper it produces has a vm-realm prototype chain. Plain-data
  // globals (args, cwd, budget, ...) are copied as-is.
  new vm.Script(
    `"use strict";
for (const name of Object.getOwnPropertyNames(globalThis)) {
  if (!name.startsWith("__host_")) continue;
  const exposed = name.slice("__host_".length);
  const impl = globalThis[name];
  // Every bridge returns through the vm realm's Promise.resolve so a host
  // Promise's .constructor is never exposed. Sync bridges (log, phase) return
  // their value synchronously unless the host produced a thenable.
  globalThis[exposed] = (...args) => {
    const result = impl(...args);
    if (!result || typeof result.then !== "function") return result;
    // Attach a noop rejection handler to the HOST promise immediately so a
    // bridge rejection the script never awaits cannot surface as an
    // unhandledRejection in the host process; the vm-realm promise below
    // still carries the rejection to any real awaiter.
    Promise.resolve(result).catch(() => {});
    return Promise.resolve(result);
  };
  delete globalThis[name];
}`,
  ).runInContext(context);
  // JSON.parse executes in the VM realm, so even plain objects do not retain a
  // host Object/Array constructor. Descriptor-only cloning avoids getters and
  // user conversion hooks on host-provided args.
  const bridgedArgs = options.args === undefined ? undefined : cloneBridgeValue(options.args);
  let bridgeJson = "null";
  try {
    if (options.args !== undefined)
      bridgeJson = serializeIdentity(bridgedArgs, {
        maxBytes: MAX_AGENT_PROMPT_BYTES,
        maxItems: 100_000,
        maxNodes: 100_000,
        maxDepth: 64,
        maxStringBytes: MAX_AGENT_PROMPT_BYTES,
      });
  } catch {
    throw new WorkflowError(
      `Workflow args exceed their ${MAX_AGENT_PROMPT_BYTES}-byte bridge limit or contain unsupported data`,
      WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED,
      { recoverable: false },
    );
  }
  context.args =
    options.args === undefined
      ? undefined
      : new vm.Script(`JSON.parse(${JSON.stringify(bridgeJson)})`).runInContext(context);

  const wrapped = `${DETERMINISM_PRELUDE}\n(async () => {\n${body}\n})()`;
  try {
    // Bound synchronous VM execution (e.g. `while (true) {}`) independently
    // from provider timeouts. The timeout governs only uninterrupted script
    // CPU; async workflow promises continue normally once control returns to
    // Node's event loop.
    const frame = Promise.resolve(
      new vm.Script(wrapped, { filename: `${meta.name || "workflow"}.js` }).runInContext(context, {
        timeout: VM_EXECUTION_TIMEOUT_MS,
      }),
    );
    // A script can retain an endless Promise after the logical frame deadline.
    // Observe it, but never await it: the deadline owns logical settlement.
    frame.catch(() => {});
    const result = await withWorkflowDeadline(
      frame,
      workflowTimeoutMs,
      meta.name || "workflow",
      () => {
        // Seal admission before aborting provider attempts. This prevents a
        // late VM continuation from scheduling work while the logical result
        // is being finalized. It does not claim to interrupt a starved event
        // loop or a promise that ignores AbortSignal.
        closeAdmission();
        shared.runFatalController.abort();
      },
      options.signal,
      () => {
        closeAdmission();
      },
    );

    // Persist logs
    const logFile = logger.persist();
    if (logFile) {
      log(`Logs persisted to ${logFile}`);
    }

    if (shared.agentCount === 0) {
      throw new WorkflowError(
        "workflow scripts must call agent() at least once; this workflow did not run any subagents",
        WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
        { recoverable: false },
      );
    }

    return {
      meta,
      result: result as T,
      logs: state.logs,
      phases: state.phases,
      agentCount: shared.agentCount,
      durationMs: Date.now() - started,
      runId,
      tokenUsage: shared.tokenUsage,
    };
  } catch (error) {
    // This error just escaped THIS frame's own vm script execution completely
    // uncaught. For the top-level frame that means nothing anywhere in the
    // whole call chain (this script, any enclosing try/catch around a nested
    // workflow()/parallel()/agent()) caught it — the run's fate is genuinely
    // sealed now (see SharedRuntime.runFatalController). Sealing it here, not
    // inside agent()/parallel(), is what preserves parallel()'s "a thrown
    // thunk resolves to null without failing the others" contract and a
    // script's own try/catch around agent()/workflow(): both those cases are
    // swallowed well before an error would ever reach this catch. A NESTED
    // frame reaching here does NOT seal anything — the parent script may still
    // catch workflow()'s rejection and continue, so only isTopLevelRun acts.
    // Idempotent: if this is already an intentional pause/stop (options.signal
    // aborted) or a second escape after the fatal signal already fired,
    // aborting an already-aborted controller is a no-op.
    //
    // This also fires on a PROVIDER_USAGE_LIMIT escape (a quota/rate-limit
    // hit), not just a genuine bug — that error is non-recoverable too (see
    // errors.ts), so it escapes exactly like any other run-fatal error and
    // seals the same way. Deliberate tradeoff: any sibling still in flight
    // when the quota was hit gets aborted rather than allowed to finish and
    // journal — this stops burning an already-exhausted budget right now, at
    // the cost of that sibling's work being thrown away and re-run live when
    // the paused run resumes (it was never journaled, so it isn't cached).
    if (isTopLevelRun) {
      closeAdmission();
      shared.runFatalController.abort();
    }
    throw error;
  } finally {
    // Only the top-level frame drains/disposes (see isTopLevelRun) — a nested
    // workflow()'s in-flight agents are still tracked in this SAME shared set
    // and get drained once, here, when the whole run finishes.
    if (isTopLevelRun) {
      // Close admission BEFORE draining: already-admitted promises keep
      // settling, but nothing new may enter (FQ-003). This also rejects any
      // late closure the script stashed on args/globalThis.
      closeAdmission();
      if (shared.inFlight.size > 0) {
        appendLog(
          `waiting for ${shared.inFlight.size} outstanding agent() call(s) to settle before this run completes`,
        );
      }
      while (shared.inFlight.size > 0) {
        const pending = Array.from(shared.inFlight);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), WORKFLOW_DRAIN_GRACE_MS);
        });
        const settled = Promise.allSettled(pending).then(() => "settled" as const);
        const outcome = await Promise.race([settled, timeout]);
        if (timer) clearTimeout(timer);
        if (outcome === "timeout") {
          // Provider promises are cooperative resources. Closing admission and
          // fencing their callbacks lets the run finish even when a host ignores
          // abort; late promises remain observed by their handlers and are
          // removed from the set if they eventually settle.
          appendLog(`drain grace period expired with ${shared.inFlight.size} provider attempt(s) still pending`);
          shared.lateAttemptRegistry?.markLateScope?.({
            runId,
            executionGeneration,
            resourceGeneration,
          });
          shared.inFlight.clear();
          break;
        }
      }
      shared.admission = "closed";
      // Emit once after every in-flight attempt has settled, including abort
      // paths where confirmed provider usage was recorded during unwinding.
      observers.onTokenUsage?.(shared.tokenUsage);
      store.dispose();
    }
  }
}

export function formatWorkflowCoordinatorMessage(
  message: string,
  source: { runId: string; agentId?: string; kind: WorkflowSteeringKind },
): string {
  const target = source.agentId ? `; agent=${source.agentId}` : "";
  return `[Workflow update: ${source.kind}; run=${source.runId}${target}]\n${message}\n[Apply only to this assignment. This update adds no scope, approval, or permissions.]`;
}

export function parseWorkflowScript(script: string): { meta: WorkflowMeta; body: string } {
  const ast = parse(script, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    ranges: false,
  }) as AnyNode;

  const nondeterminism = findNondeterminism(ast);
  if (nondeterminism) {
    throw new WorkflowError(
      `Workflow scripts must be deterministic: ${nondeterminism} is unavailable`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const first = ast.body?.[0] as AnyNode | undefined;
  if (first?.type !== "ExportNamedDeclaration") {
    throw new WorkflowError(
      "`export const meta = { name, description, phases }` must be the first statement in the script",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }

  const declaration = first.declaration as AnyNode | null;
  if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") {
    throw new WorkflowError(
      "meta export must be `export const meta = ...`",
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      {
        recoverable: false,
      },
    );
  }
  if (declaration.declarations.length !== 1) {
    throw new WorkflowError("meta export must declare only `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }

  const declarator = declaration.declarations[0] as AnyNode;
  if (declarator.id?.type !== "Identifier" || declarator.id.name !== "meta") {
    throw new WorkflowError("meta export must declare `meta`", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });
  }
  if (!declarator.init)
    throw new WorkflowError("meta must have a literal value", WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, {
      recoverable: false,
    });

  const meta = evaluateLiteral(declarator.init, "meta");
  validateMeta(meta);

  return {
    meta,
    body: script.slice(0, first.start) + script.slice(first.end),
  };
}

function evaluateLiteral(node: AnyNode, path: string): unknown {
  switch (node.type) {
    case "ObjectExpression": {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as AnyNode[]) {
        if (prop.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        if (prop.type !== "Property") throw new Error(`only plain properties allowed in ${path}`);
        if (prop.computed) throw new Error(`computed keys not allowed in ${path}`);
        if (prop.kind !== "init" || prop.method) throw new Error(`methods/accessors not allowed in ${path}`);
        const key = propertyKey(prop.key as AnyNode, path);
        if (key === "__proto__" || key === "constructor" || key === "prototype") {
          throw new Error(`reserved key name not allowed in ${path}: ${key}`);
        }
        out[key] = evaluateLiteral(prop.value as AnyNode, `${path}.${key}`);
      }
      return out;
    }
    case "ArrayExpression":
      return (node.elements as Array<AnyNode | null>).map((element, index) => {
        if (!element) throw new Error(`sparse arrays not allowed in ${path}`);
        if (element.type === "SpreadElement") throw new Error(`spread not allowed in ${path}`);
        return evaluateLiteral(element, `${path}[${index}]`);
      });
    case "Literal":
      return node.value;
    case "TemplateLiteral":
      if (node.expressions.length > 0) throw new Error(`template interpolation not allowed in ${path}`);
      return node.quasis.map((quasi: AnyNode) => quasi.value.cooked ?? quasi.value.raw).join("");
    case "UnaryExpression":
      if (node.operator === "-" && node.argument?.type === "Literal" && typeof node.argument.value === "number") {
        return -node.argument.value;
      }
      throw new Error(`only negative-number unary allowed in ${path}`);
    default:
      throw new Error(`non-literal node type in ${path}: ${node.type}`);
  }
}

function propertyKey(node: AnyNode, path: string): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return String(node.value);
  throw new Error(`unsupported key type in ${path}: ${node.type}`);
}

function validateMeta(meta: unknown): asserts meta is WorkflowMeta {
  if (!meta || typeof meta !== "object") throw new Error("meta must be an object");
  const value = meta as WorkflowMeta;
  if (typeof value.name !== "string" || !value.name.trim()) throw new Error("meta.name must be a non-empty string");
  if (typeof value.description !== "string" || !value.description.trim())
    throw new Error("meta.description must be a non-empty string");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("meta.model must be a string");
  if (value.phases !== undefined) {
    if (!Array.isArray(value.phases)) throw new Error("meta.phases must be an array");
    for (const phase of value.phases) {
      if (!phase || typeof phase !== "object" || typeof (phase as WorkflowMetaPhase).title !== "string") {
        throw new Error("each meta phase must have a title string");
      }
    }
  }
}

function createLimiter(limit: number, isAdmissionOpen: () => boolean): WorkflowLimiter {
  type Waiter = {
    start: () => void;
    reject: (reason: Error) => void;
  };

  let active = 0;
  let closed = false;
  const queue: Waiter[] = [];
  let closeError: Error | undefined;
  const admissionClosedError = (): Error =>
    (closeError ??= new WorkflowError(
      "Workflow admission closed while waiting for concurrency",
      WorkflowErrorCode.WORKFLOW_ABORTED,
      { recoverable: true },
    ));

  const rejectQueued = (reason: Error): void => {
    while (queue.length) queue.shift()?.reject(reason);
  };

  const start = <T>(fn: () => Promise<T>): Promise<T> => {
    // A waiter can be granted in the same turn that deadline/abort closes the
    // run. Re-check admission immediately before invoking the callback.
    if (closed || !isAdmissionOpen()) return Promise.reject(admissionClosedError());
    active++;
    let result: Promise<T>;
    try {
      result = Promise.resolve(fn());
    } catch (error) {
      result = Promise.reject(error);
    }
    return result.finally(() => {
      active--;
      if (closed || !isAdmissionOpen()) {
        rejectQueued(admissionClosedError());
        return;
      }
      while (active < limit && queue.length) {
        const waiter = queue.shift();
        if (!waiter) break;
        waiter.start();
      }
    });
  };

  const limiter = (<T>(fn: () => Promise<T>): Promise<T> => {
    if (closed || !isAdmissionOpen()) return Promise.reject(admissionClosedError());
    if (active < limit) return start(fn);
    return new Promise<T>((resolve, reject) => {
      queue.push({
        start: () => resolve(start(fn)),
        reject,
      });
    });
  }) as WorkflowLimiter;

  limiter.close = (reason?: Error): void => {
    if (closed) return;
    closed = true;
    if (reason) closeError = reason;
    rejectQueued(admissionClosedError());
  };
  return limiter;
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

/**
 * Stable identity hash for a checkpoint() call — a cache miss on resume when
 * anything that could change its outcome changes. Must cover every
 * CheckpointOptions field that participates in the outcome, not just
 * promptText/kind/choices:
 *   - `default` and `headless` decide the reply in the headless (no `confirm`
 *     threaded in) path — a script edited to change either must not resume
 *     with the OLD default/behavior's stale journaled reply.
 *   - `timeoutMs` bounds the interactive prompt; a host `confirm` may itself
 *     fall back to `default` when the human doesn't answer in time, so it can
 *     also affect the outcome and is included for the same reason.
 *   - A nested frame's context prevents its checkpoint from colliding with a
 *     prior version of that child. Top-level edited scripts deliberately keep
 *     longest-unchanged-prefix replay: the checkpoint's own prompt/options are
 *     the identity boundary, just as an agent call hashes its own inputs.
 * NOTE: widening this hash is a one-time invalidation of any checkpoint
 * answers already persisted under the old (narrower) hash — on the first
 * resume after upgrading, those checkpoints will cache-miss and re-prompt (or
 * re-apply the default) once, live. That's intentional: a silently-stale
 * cached decision from before the identity surface was fixed is worse than a
 * one-time re-ask.
 */
function hashCheckpoint(promptText: string, options: CheckpointOptions, resumeContextHash?: string): string {
  const identity = serializeIdentity({
    identityVersion: 2,
    promptText,
    kind: options.kind ?? "confirm",
    choices: options.choices ?? null,
    default: options.default ?? null,
    headless: options.headless ?? "default",
    timeoutMs: options.timeoutMs ?? null,
    // A checkpoint in a nested frame has no provider call hash to carry the
    // child identity. Keep that boundary explicit without folding the entire
    // top-level script into every call and destroying prefix replay.
    resumeContextHash: resumeContextHash ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

interface ReplayContextIdentity {
  stable: boolean;
  hash?: string;
}

function functionReplayIdentity(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "function") throw new TypeError("replay identity expected a function");
  return Function.prototype.toString.call(value);
}

function toolReplayIdentity(tool: ToolDefinition): Record<string, unknown> {
  const definition = tool as ToolDefinition & {
    prepareArguments?: unknown;
    promptSnippet?: unknown;
    promptGuidelines?: unknown;
  };
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    promptSnippet: definition.promptSnippet ?? null,
    promptGuidelines: definition.promptGuidelines ?? null,
    prepareArguments: functionReplayIdentity(definition.prepareArguments),
    execute: functionReplayIdentity(definition.execute),
  };
}

/**
 * Identity for provider context inherited by every agent in a run. Script and
 * args are intentionally not global inputs: each call hashes its realized
 * prompt/options and the first changed call invalidates the suffix. Hashing the
 * whole script here would turn an edited tail into a full cache miss and defeat
 * the advertised longest-unchanged-prefix replay. Tools are represented by
 * their provider-visible contract and executable hooks; cwd captures their
 * common environment input. The injected runner is deliberately excluded: it
 * is the transport used to evaluate this contract, not part of the agent call.
 * Opaque session/resource state still fails closed.
 */
function createReplayContextIdentity(options: WorkflowRunOptions, effectiveCwd: string): ReplayContextIdentity {
  try {
    const identity = serializeIdentity(
      {
        version: 2,
        cwd: effectiveCwd,
        instructions: options.instructions ?? null,
        tools: options.tools?.map(toolReplayIdentity) ?? null,
        excludeTools: options.excludeTools ?? null,
        // This covers injected resourceLoader/settings/modelRuntime/session
        // context. serializeIdentity rejects functions/accessors/cycles, so a
        // dynamic resource context fails closed rather than colliding by tag.
        session: options.session ?? null,
      },
      { maxItems: 100_000, maxBytes: 1_000_000, maxNodes: 100_000 },
    );
    return { stable: true, hash: createHash("sha256").update(identity).digest("hex") };
  } catch {
    return { stable: false };
  }
}

function isCanonicalModelSpec(spec: string | undefined): boolean {
  const trimmed = spec?.trim() ?? "";
  if (!trimmed) return false;
  const withoutThinking = trimmed.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/i, "");
  const slash = withoutThinking.indexOf("/");
  return slash > 0 && slash < withoutThinking.length - 1;
}

function modelRegistryIdentityFor(
  registry: WorkflowRunOptions["modelRegistry"],
  requestedOrResolvedSpec?: string,
): string | undefined {
  if (!registry) return undefined;
  // A canonical provider/model is already part of the call identity. Do not
  // invalidate every explicit pin when an unrelated catalog entry changes;
  // only bare/fuzzy/implicit resolution depends on the catalog as a whole.
  if (isCanonicalModelSpec(requestedOrResolvedSpec)) return undefined;
  try {
    return serializeIdentity(
      registry
        .getAll()
        .map((model) => `${model.provider}/${model.id}`)
        .sort(),
      { maxItems: 100_000, maxBytes: 1_000_000 },
    );
  } catch {
    // A hostile/incomplete registry must not make a workflow call fail before
    // WorkflowAgent can report its normal model-resolution error.
    return undefined;
  }
}

function hashAgentCall(
  prompt: string,
  model: string | undefined,
  phase: string | undefined,
  options: AgentOptions,
  agentDefKey: string | null,
  resumeContextHash?: string,
  modelRegistryIdentity?: string,
  replayContextIdentity?: string,
): string {
  const identity = serializeIdentity({
    identityVersion: 2,
    prompt,
    model: model ?? null,
    tier: options.tier ?? null,
    phase: phase ?? null,
    label: options.label ?? null,
    isolation: options.isolation ?? null,
    // Distinguish omitted (inherit the run-level default) from explicit null
    // (disable the timeout/retry) — both previously hashed identically even
    // though their execution behavior differs (NID-002).
    timeoutMs:
      options.timeoutMs === undefined ? "inherited" : options.timeoutMs === null ? "disabled" : options.timeoutMs,
    retries: options.retries === undefined ? "inherited" : options.retries === null ? "disabled" : options.retries,
    agentType: options.agentType ?? null,
    // Resolved definition (tools/model/prompt) so editing an agent .md invalidates
    // this call's cached result on a later resume.
    agentDef: agentDefKey,
    schema: options.schema ?? null,
    // A nested frame's script and arguments are execution context, not merely
    // prompt text. Include their hash so an edited child cannot replay a stale
    // result whose prompt happened to remain unchanged.
    resumeContextHash: resumeContextHash ?? null,
    // Resolution catalogs are identity input when the requested spec is a
    // bare/fuzzy alias and therefore cannot be canonicalized before the live
    // session opens.
    modelRegistry: modelRegistryIdentity ?? null,
    // Run-level provider context (instructions/tools/session/cwd) is shared by
    // every call and is hashed once above. An unstable context still disables
    // replay at the call site rather than being represented by a collision.
    replayContext: replayContextIdentity ?? null,
  });
  return createHash("sha256").update(identity).digest("hex");
}

function buildAgentInstructions(
  phase: string | undefined,
  options: AgentOptions,
  def: AgentDefinition | undefined,
  resolvedIsolation?: "worktree",
): string | undefined {
  const lines: string[] = [];
  // A resolved agentType binds a real role prompt (the definition body). Only
  // fall back to the prose hint when the agentType named no known definition.
  if (def?.prompt) lines.push(def.prompt);
  else if (options.agentType) lines.push(`Act as workflow subagent type: ${options.agentType}`);
  if (phase) lines.push(`Workflow phase: ${phase}`);
  // Use resolvedIsolation so the annotation fires whether isolation came from
  // the call site or from the agentDef's isolation field.
  if (resolvedIsolation) lines.push(`Requested isolation: ${resolvedIsolation}`);
  // Note: options.model is applied for real via the session, not injected as prose.
  return lines.length ? lines.join("\n\n") : undefined;
}

function isEmptyTextAgentResult(result: unknown, schema: TSchema | undefined): boolean {
  return schema === undefined && typeof result === "string" && result.trim().length === 0;
}

function estimateTokens(value: unknown): number {
  // Accounting is a projection path. It must not stringify an adversarial
  // result in full or turn an otherwise successful run into a serialization
  // failure; the durable result remains on the native JSON path.
  return Math.ceil(Buffer.byteLength(serializeBounded(value ?? "", { maxBytes: 64_000 }), "utf8") / 4);
}

function normalizeHelperCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
  // Helper fan-out happens before agent() can enforce the run-wide limit, so
  // bound the allocation itself rather than relying on the downstream gate.
  return Math.min(100, Math.floor(value));
}

function normalizeMaxAgents(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new WorkflowError(
      `maxAgents must be a finite integer between 1 and ${MAX_AGENTS_PER_RUN}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  return Math.min(MAX_AGENTS_PER_RUN, value);
}

function normalizeConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 1;
  return Math.min(MAX_CONCURRENCY, Math.floor(value));
}

function normalizeAgentRetries(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_AGENT_RETRIES, Math.floor(value));
}

function normalizeAgentTimeout(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new WorkflowError(
      `agentTimeoutMs must be null or a finite integer between 1 and ${MAX_WORKFLOW_TIMEOUT_MS}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  return Math.min(MAX_WORKFLOW_TIMEOUT_MS, value);
}

function normalizeWorkflowTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new WorkflowError(
      `workflowTimeoutMs must be a finite integer between 1 and ${MAX_WORKFLOW_TIMEOUT_MS}`,
      WorkflowErrorCode.SCRIPT_VALIDATION_ERROR,
      { recoverable: false },
    );
  }
  return Math.min(MAX_WORKFLOW_TIMEOUT_MS, value);
}

/**
 * Race the complete VM frame against a finite logical deadline. The frame is
 * deliberately observed but not cancelled: Promise races cannot interrupt a
 * pending promise or a microtask-starved event loop. Admission and provider
 * aborts are the enforceable boundary.
 */
async function withWorkflowDeadline<T>(
  promise: Promise<T>,
  ms: number,
  workflowName: string,
  onTimeout: () => void,
  signal?: AbortSignal,
  onAbort?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onSignalAbort: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new WorkflowError(
          `Workflow "${workflowName}" exceeded its ${ms}ms wall-clock deadline`,
          WorkflowErrorCode.WORKFLOW_TIMEOUT,
          { recoverable: false },
        ),
      );
      try {
        onTimeout();
      } catch {
        // Deadline settlement must not be masked by best-effort abort wiring.
      }
    }, ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    const rejectAborted = () => {
      try {
        onAbort?.();
      } finally {
        reject(new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true }));
      }
    };
    if (signal?.aborted) rejectAborted();
    else if (signal) {
      onSignalAbort = rejectAborted;
      signal.addEventListener("abort", onSignalAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, deadline, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onSignalAbort) signal?.removeEventListener("abort", onSignalAbort);
  }
}

/**
 * Run a promise with a timeout.
 *
 * `onTimeout` fires when the deadline hits, BEFORE the timeout rejection wins the
 * race — the caller uses it to abort the underlying work (e.g. the subagent
 * session) so it can release its resources instead of streaming on in the
 * background with the whole session graph (messages, etc.) retained (#109).
 *
 * `signal` also makes a timeout-disabled (`ms === null`) attempt abortable at
 * the logical workflow layer. Providers are cooperative and may ignore abort;
 * their original promise remains separately tracked by the run's bounded drain,
 * but pause/stop must not await that promise forever before resume can proceed.
 * `reportedMs` preserves the configured end-to-end agent deadline when `ms`
 * is only the remainder left after waiting for provider admission.
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number | null,
  label: string,
  onTimeout?: () => void,
  signal?: AbortSignal,
  reportedMs: number | null = ms,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const races: Promise<T>[] = [promise];
  if (ms !== null) {
    races.push(
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          // Settle the logical race as a timeout before aborting the provider.
          // Abort listeners run synchronously, so reversing this order lets the
          // linked abort branch mask AGENT_TIMEOUT as generic WORKFLOW_ABORTED.
          reject(
            new WorkflowError(
              `Agent "${label}" timed out after ${reportedMs ?? ms}ms; raise or omit timeoutMs/agentTimeoutMs to allow longer runs`,
              WorkflowErrorCode.AGENT_TIMEOUT,
              { recoverable: true },
            ),
          );
          try {
            onTimeout?.();
          } catch {
            // Best-effort cleanup; never let it mask the timeout error.
          }
        }, ms);
      }),
    );
  }
  if (signal) {
    races.push(
      new Promise<never>((_, reject) => {
        const rejectAborted = () =>
          reject(new WorkflowError("workflow aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true }));
        if (signal.aborted) rejectAborted();
        else {
          onAbort = rejectAborted;
          signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    );
  }

  try {
    return await Promise.race(races);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}
