/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */

import { join } from "node:path";
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  aggregateAgentUsage,
  fmtCost,
  fmtTokenSegment,
  shorten,
  statusIcon,
  tokenFigures,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { shortModel } from "./workflow-ui.js";
import { safeStringify } from "./safe-serialize.js";

// `tokenUsage` is included so the detailed panel's live token/s counter refreshes
// as tokens accrue (not only on agent start/end). It is harmless in compact mode —
// it redraws identical content.
const RUN_EVENTS = [
  "agentStart",
  "agentEnd",
  "phase",
  "log",
  "tokenUsage",
  "complete",
  "error",
  "stopped",
  "paused",
  "resumed",
];
/** Events after which a run is gone and its token-rate samples can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped"] as const;

export interface TaskPanelOptions {
  storage?: WorkflowStorage;
  cwd?: string;
  /**
   * Live settings loader. When provided, the panel reads it fresh (with a short
   * TTL cache) on each render so `/workflows-progress` takes effect without a
   * restart. Omitted in tests / minimal hosts → always compact.
   */
  loadSettings?: () => WorkflowSettings;
}

const DEFAULT_DELIVERY_RESULT_CHARS = 12_000;

/**
 * Build a bounded provider-visible projection of the workflow's semantic return
 * value. The complete value remains in the persisted run and interactive pager.
 * We intentionally use the workflow return — never "the last agent" — because
 * execution order is not a product contract. Strings are the common final-report
 * shape; structured returns are serialized deterministically and truncated with
 * an explicit retrieval pointer supplied by deliverText().
 */
function summarizeResult(result: unknown, maxChars = DEFAULT_DELIVERY_RESULT_CHARS): string {
  let serialized: string;
  if (typeof result === "string") {
    serialized = result;
  } else if (result && typeof result === "object" && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    // Built-ins and well-authored workflows conventionally expose their user-
    // facing artifact as report/synthesis/summary/answer. Put that semantic
    // product first so a bounded projection never spends its entire budget on
    // large intermediate arrays that precede `report` in object insertion order.
    const preferredKey = ["report", "synthesis", "summary", "answer"].find(
      (key) => typeof record[key] === "string" && (record[key] as string).trim().length > 0,
    );
    if (preferredKey) {
      const artifact = record[preferredKey] as string;
      const metadata = Object.fromEntries(Object.entries(record).filter(([key]) => key !== preferredKey));
      const metadataText = safeStringify(metadata);
      serialized = `${artifact}\n\n[Workflow metadata]\n${metadataText}`;
    } else {
      serialized = safeStringify(result);
    }
  } else {
    serialized = safeStringify(result);
  }
  if (serialized.length <= maxChars) return serialized;
  // Keep both beginning and end: prefix-only truncation can hide conclusions,
  // caveats, or security findings placed at the tail. Exact content remains in
  // the durable run record.
  const marker = `\n\n[... middle omitted; final workflow result projected to ${maxChars} characters ...]\n\n`;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  const available = maxChars - marker.length;
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return `${serialized.slice(0, head)}${marker}${serialized.slice(serialized.length - tail)}`;
}

function safeAgentSnapshots(value: unknown): WorkflowAgentSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.filter((agent): agent is WorkflowAgentSnapshot => {
    return !!agent && typeof agent === "object" && typeof (agent as { status?: unknown }).status === "string";
  });
}

function fitLine(line: string, width?: number): string {
  if (typeof width !== "number" || !Number.isFinite(width)) return line;
  const maxWidth = Math.max(0, Math.floor(width));
  if (visibleWidth(line) <= maxWidth) return line;
  return truncateToWidth(line, maxWidth);
}

export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const maxChars =
    typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)
      ? Math.max(0, Math.floor(opts.maxChars))
      : DEFAULT_DELIVERY_RESULT_CHARS;
  const summary = summarizeResult(run.result?.result, maxChars);
  const tu = run.result?.tokenUsage;
  const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
  const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}).`,
    "",
    summary,
  ];
  // The full result is intentionally not duplicated into provider context.
  // Point at the durable run record for exact JSON and per-agent reports.
  if (opts.resultPath) lines.push("", `↳ Full result and subagent reports: ${opts.resultPath}`);
  return lines.join("\n");
}

/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager: WorkflowManager, runId: string): string | undefined {
  try {
    return join(manager.getPersistence().getRunsDir(), `${runId}.json`);
  } catch {
    return undefined;
  }
}

/**
 * Generation-bound delivery state lives on the manager so listeners registered
 * once can keep working across session replacements (/reload, /new, resume,
 * fork). See installResultDelivery / suspendResultDelivery.
 */
interface DeliveryHolder {
  pi: ExtensionAPI;
  loadSettings?: () => WorkflowSettings;
  /** Extension-level batching bridge. Standalone consumers leave this unset. */
  sendResult?: (payload: WorkflowDeliveryPayload) => void;
  /**
   * When true, do not call pi.sendMessage — only enqueue. Set for the whole
   * window between session_shutdown and the next generation's install, so a
   * completion cannot land on a dying session (or a just-invalidated ctx).
   */
  suspended: boolean;
  /** Deliveries that failed to send or arrived while suspended; flushed on resume. */
  pending: WorkflowDeliveryPayload[];
  /**
   * Generation counter bumped on every install/refresh. An in-flight send's
   * rejection handler captures the generation it started under; if a newer
   * generation has already installed by the time the rejection lands, the
   * handler must flush immediately — otherwise the content sits in `pending`
   * until some later install happens to run.
   */
  generation: number;
}

export type WorkflowDeliveryPayload = {
  content: string;
  details?: {
    isError?: boolean;
    status?: "completed" | "failed" | "paused";
    notificationKind?: "workflow-result";
    runId?: string;
    sequence?: number;
  };
};

type DeliveryManager = WorkflowManager & {
  __deliveryInstalled?: boolean;
  __holder?: DeliveryHolder;
};

function deliveryManager(manager: WorkflowManager): DeliveryManager {
  return manager as DeliveryManager;
}

function enqueuePending(holder: DeliveryHolder, payload: WorkflowDeliveryPayload): void {
  // Soft-cap only: warn loudly, never drop. The full result is also on disk
  // via the run JSON pointer in deliverText, but conversation delivery is the
  // contract the tool promises — silent shift() would break it.
  if (holder.pending.length >= 32) {
    console.warn(
      `[workflow-delivery] pending queue at ${holder.pending.length} entries; ` +
        "delivery is stalled (no successful flush since suspend/failure). " +
        "Results remain on disk via /workflows.",
    );
  }
  holder.pending.push(payload);
}

function trySend(holder: DeliveryHolder, payload: WorkflowDeliveryPayload): void {
  const startedGeneration = holder.generation;
  try {
    if (holder.sendResult) {
      holder.sendResult(payload);
      return;
    }
    const ret = holder.pi.sendMessage(
      { customType: "workflow-result", content: payload.content, display: true, details: payload.details },
      // DELIVERY-PRODUCT-001: final results must land at the next safe point of
      // an ACTIVE turn (like activity messages and like tool results), not wait
      // for the whole turn to finish. triggerTurn wakes an idle session.
      { triggerTurn: true, deliverAs: "steer" },
    );
    // sendMessage may return a promise (defensive — current pi types it void).
    // On rejection: re-queue, and if a newer generation already installed
    // while we were in flight, flush now so the content is not stranded.
    void Promise.resolve(ret).catch((err: unknown) => {
      enqueuePending(holder, payload);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[workflow-delivery] async send failed; queued for retry: ${msg}`);
      if (holder.generation !== startedGeneration && !holder.suspended) {
        flushPending(holder);
      }
    });
  } catch (err) {
    enqueuePending(holder, payload);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[workflow-delivery] send failed; queued for retry: ${msg}`);
  }
}

function flushPending(holder: DeliveryHolder): void {
  if (holder.suspended || holder.pending.length === 0) return;
  const queued = holder.pending.splice(0, holder.pending.length);
  for (const payload of queued) trySend(holder, payload);
}

/**
 * Stop live sends on this manager. In-flight completions only enqueue until
 * {@link resumeResultDelivery} runs (from session_start, after Pi has bound
 * the extension runtime) or the process exits (quit — results stay on disk).
 *
 * Call from session_shutdown BEFORE handoff or discard so a completion that
 * races the teardown cannot deliver into the outgoing session.
 */
export function suspendResultDelivery(manager: WorkflowManager): void {
  const holder = deliveryManager(manager).__holder;
  if (holder) holder.suspended = true;
}

/**
 * Unsuspend and flush any queued deliveries. Must run only after Pi has
 * finished constructing the AgentSession and bound sendMessage (i.e. from
 * session_start) — calling it from the extension factory hits the
 * "runtime not initialized" stub and re-queues forever.
 */
export function resumeResultDelivery(manager: WorkflowManager): void {
  const holder = deliveryManager(manager).__holder;
  if (!holder) return;
  holder.suspended = false;
  flushPending(holder);
}

/**
 * When a background run finishes (or fails), deliver its result back into the
 * conversation AND continue the turn so the assistant can act on it — without
 * blocking the user meanwhile:
 *
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the
 *    result to the model so the paused conversation continues.
 *  - `deliverAs: "steer"` means that if the user is busy in another turn, the
 *    result is queued and picked up at the next safe point — the active provider
 *    request is never aborted.
 *
 * Set up once per extension; idempotent via an internal guard. Across session
 * replacement the manager (and this listener) survive via the handoff path;
 * each new generation only refreshes `holder.pi` and flushes any messages that
 * failed or arrived while delivery was suspended.
 */
const resultContextBridges = new WeakSet<object>();

/**
 * Package-root consumers do not load extensions/workflow.ts, so they do not
 * receive the extension's broader custom-message bridge. Install the minimal
 * workflow-result bridge alongside the delivery API to preserve tool-result
 * semantics for standalone package users too.
 */
function installResultContextBridge(pi: ExtensionAPI): void {
  const key = pi as unknown as object;
  if (resultContextBridges.has(key)) return;
  resultContextBridges.add(key);
  pi.on("context", (event) => {
    const output: any[] = [];
    for (let index = 0; index < event.messages.length; index++) {
      const message = event.messages[index] as any;
      if (!message || message.role !== "custom" || message.customType !== "workflow-result") {
        output.push(message && typeof message === "object" ? { ...message } : message);
        continue;
      }
      const text = typeof message.content === "string" ? message.content : String(message.content ?? "");
      const toolCallId = `workflow_result_${index}_${message.timestamp ?? 0}`;
      output.push({
        role: "assistant",
        content: [{
          type: "toolCall",
          id: toolCallId,
          name: "workflow_delivery",
          arguments: { customType: "workflow-result", status: message.details?.status ?? null },
        }],
        stopReason: "toolUse",
        timestamp: message.timestamp ?? Date.now(),
      });
      output.push({
        role: "toolResult",
        toolCallId,
        toolName: "workflow_delivery",
        content: [{ type: "text", text }],
        isError: message.details?.isError === true,
        timestamp: message.timestamp ?? Date.now(),
      });
    }
    return { messages: output };
  });
}

export function installResultDelivery(
  pi: ExtensionAPI,
  manager: WorkflowManager,
  opts: {
    loadSettings?: () => WorkflowSettings;
    installContextBridge?: boolean;
    /** Route terminal results through an extension-owned batching/dedup bridge. */
    sendResult?: (payload: WorkflowDeliveryPayload) => void;
  } = {},
): void {
  // Standalone package-root consumers need this minimal bridge. The full Pi
  // extension installs a richer task-notification bridge for all workflow
  // message types and disables this one to avoid double transformation.
  if (opts.installContextBridge !== false) installResultContextBridge(pi);
  const m = deliveryManager(manager);
  if (m.__deliveryInstalled) {
    // The manager and listeners survive session replacement. Refresh every
    // generation-bound dependency and bump the generation (so in-flight
    // rejects from the previous pi can self-flush once resumed). Do NOT
    // unsuspend or flush here: the factory runs before Pi bindCore(), so
    // sendMessage is still the "runtime not initialized" stub. session_start
    // calls resumeResultDelivery() once the runtime is live.
    if (m.__holder) {
      m.__holder.pi = pi;
      m.__holder.loadSettings = opts.loadSettings;
      m.__holder.sendResult = opts.sendResult;
      m.__holder.generation += 1;
    }
    return;
  }
  m.__deliveryInstalled = true;
  m.__holder = {
    pi,
    loadSettings: opts.loadSettings,
    sendResult: opts.sendResult,
    suspended: false,
    pending: [],
    generation: 0,
  };

  const deliver = (payload: WorkflowDeliveryPayload) => {
    const holder = m.__holder;
    if (!holder) return;
    if (holder.suspended) {
      enqueuePending(holder, payload);
      return;
    }
    trySend(holder, payload);
  };

  let notificationSequence = 0;
  manager.on("complete", ({ runId }: { runId: string }) => {
    const run = manager.getRun(runId);
    // Only background/resumed runs are delivered: a foreground (sync) run already
    // returns its result inline as the tool result, so re-delivering would dup it.
    if (run?.background) {
      let maxChars: number | undefined;
      try {
        maxChars = m.__holder?.loadSettings?.().deliveredResultMaxChars;
      } catch {
        // Settings are optional presentation input; delivery must still proceed.
      }
      deliver({
        content: deliverText(run, {
          resultPath: persistedResultPath(manager, runId),
          maxChars,
        }),
        details: {
          status: "completed",
          isError: false,
          notificationKind: "workflow-result",
          runId,
          sequence: notificationSequence++,
        },
      });
    }
  });
  manager.on("error", ({ runId, error }: { runId: string; error?: { message?: string } }) => {
    if (!manager.getRun(runId)?.background) return;
    deliver({
      content: `✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`,
      details: {
        status: "failed",
        isError: true,
        notificationKind: "workflow-result",
        runId,
        sequence: notificationSequence++,
      },
    });
  });
  // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
  // user it is resumable once their budget refills, rather than letting it look dead.
  // Manual pause() also emits "paused" but with no reason — guard so only the
  // usage-limit case delivers a message.
  manager.on(
    "paused",
    ({
      runId,
      reason,
      error,
      resetHint,
    }: {
      runId: string;
      reason?: string;
      error?: { message?: string };
      resetHint?: string;
    }) => {
      if (reason !== "usage_limit") return;
      if (!manager.getRun(runId)?.background) return;
      const when = resetHint ? ` (${resetHint})` : "";
      const cause = error?.message ?? "provider usage limit reached";
      deliver({
        content:
          `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
          `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`,
        details: {
          status: "paused",
          isError: true,
          notificationKind: "workflow-result",
          runId,
          sequence: notificationSequence++,
        },
      });
    },
  );
}

export function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const rows = active.map((r) => {
    const live = manager.getRun(r.runId);
    // UIOBS-007: persisted JSON is not structurally validated — a corrupt or
    // legacy `agents` value (null/object) must never crash the panel render.
    const agents = safeAgentSnapshots(live?.snapshot.agents ?? r.agents);
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const phase = live?.snapshot.currentPhase ? ` · ${live.snapshot.currentPhase}` : "";
    return `  ${icon} ${r.workflowName}  ${done}/${agents.length} agents${phase}`;
  });
  // Finished runs leave this live panel but are kept in the navigator. Tell the
  // user so a completed run doesn't look like it vanished.
  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  const hint = theme.fg(
    "dim",
    finished > 0
      ? `  /workflows — open navigator (${finished} finished kept in history)`
      : "  /workflows — open navigator",
  );
  return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}

// ─── Detailed mode: live token rate ────────────────────────────────────────────

/** Rolling window for the token/s rate. Older samples age out so a stall decays to 0. */
const RATE_WINDOW_MS = 10_000;
/** Per-run (timestamp, cumulative total) samples, keyed by the persisted runId so
 *  the rolling rate survives pause→resume. Cleared when a run ends. */
const tokenSamples = new Map<string, Array<{ ts: number; total: number }>>();

/** Record a token-total sample for `runId` at time `now` (ms). */
export function sampleTokens(runId: string, total: number, now: number): void {
  const samples = tokenSamples.get(runId) ?? [];
  const last = samples[samples.length - 1];
  // Collapse repeat renders within the same instant (e.g. width recalcs).
  if (last && last.ts === now && last.total === total) return;
  samples.push({ ts: now, total });
  // Drop samples beyond the rolling window, always keeping ≥2 so a rate is computable.
  while (samples.length > 2 && now - samples[0].ts > RATE_WINDOW_MS) samples.shift();
  tokenSamples.set(runId, samples);
}

/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export function tokensPerSecond(runId: string): number {
  const samples = tokenSamples.get(runId);
  if (!samples || samples.length < 2) return 0;
  const oldest = samples[0];
  const newest = samples[samples.length - 1];
  const elapsedMs = newest.ts - oldest.ts;
  if (elapsedMs <= 0) return 0;
  const delta = newest.total - oldest.total;
  if (delta <= 0) return 0;
  return (delta / elapsedMs) * 1000;
}

/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export function clearTokenSamples(runId: string): void {
  tokenSamples.delete(runId);
}

/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return 8;
  return Math.min(1000, Math.floor(value));
}

/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(
  snap: WorkflowSnapshot,
  agents: WorkflowAgentSnapshot[],
  maxAgents: number,
  theme: Theme,
): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const lines: string[] = [];
  // Group agents by phase, declared order first then discovery order (as the navigator does).
  const order = snap.phases.length ? [...snap.phases] : [];
  const byPhase = new Map<string, WorkflowAgentSnapshot[]>();
  for (const a of agents) {
    const key = a.phase ?? "(no phase)";
    if (!byPhase.has(key)) byPhase.set(key, []);
    byPhase.get(key)?.push(a);
    if (!order.includes(key)) order.push(key);
  }
  for (const title of order) {
    const phaseAgents = byPhase.get(title) ?? [];
    if (!phaseAgents.length) continue;
    const done = phaseAgents.filter((a) => a.status === "done").length;
    const running = phaseAgents.filter((a) => a.status === "running").length;
    const errors = phaseAgents.filter((a) => a.status === "error").length;
    const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
    const complete = done + errors + skipped === phaseAgents.length;
    const marker = running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
    const phaseMeta = [
      `${done}/${phaseAgents.length} agents`,
      running ? `${running} running` : "",
      errors ? `${errors} errors` : "",
      fmtTokenSegment(aggregateAgentUsage(phaseAgents), fmtTokensShort),
    ]
      .filter(Boolean)
      .join(" · ");
    lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));

    const visible = phaseAgents.slice(-maxAgents);
    for (const a of visible) {
      const segment = fmtTokenSegment(tokenFigures(a.tokenUsage, a.tokens), fmtTokensShort);
      const tok = segment ? dim(` ${segment}`) : "";
      const mdl = shortModel(a.model);
      const model = mdl ? dim(` · ${mdl}`) : "";
      lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}`);
    }
    if (phaseAgents.length > visible.length) {
      lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier agents`));
    }
  }
  return lines;
}

/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export function renderPanelDetailed(
  manager: WorkflowManager,
  theme: Theme,
  width: number | undefined,
  maxAgents: number,
  now: number,
): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const dim = (t: string) => theme.fg("dim", t);
  const out: string[] = [theme.bold(`Workflows running (${active.length}):`)];

  for (const r of active) {
    const live = manager.getRun(r.runId);
    const snap = live?.snapshot;
    // UIOBS-007: same malformed-state guard as the compact panel.
    const agents = safeAgentSnapshots(snap?.agents ?? r.agents);
    const done = agents.filter((a) => a.status === "done").length;
    const icon = r.status === "paused" ? "⏸" : "◆";
    const usage = snap?.tokenUsage ?? r.tokenUsage;
    // The run-level tokenUsage aggregate is only finalized when the run ends, so
    // it reads 0 for the whole live run; per-agent figures update on each agent
    // completion, so aggregate those instead. The rate samples the same
    // fresh+cacheRead sum the header displays, so tok/s tracks the visible
    // figures. Tokens land at agent-completion granularity, so the rate reflects
    // completion throughput — it decays to 0 during a single long-running agent
    // or a stall (which is the intended signal). Paused runs don't accrue
    // tokens, so their rate is suppressed (a stalled rate would mislead).
    const runUsage = aggregateAgentUsage(agents);
    sampleTokens(r.runId, runUsage.fresh + runUsage.cacheRead, now);
    const rate = r.status === "running" ? tokensPerSecond(r.runId) : 0;
    const meta = [
      `${done}/${agents.length} agents`,
      snap?.currentPhase || "",
      fmtTokenSegment(runUsage, fmtTokensShort),
      // (cost is only known once the run finalizes its usage.)
      usage?.cost ? fmtCost(usage.cost) : "",
      rate > 0 ? `${Math.round(rate)} tok/s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
    if (snap) out.push(...renderRunBody(snap, agents, maxAgents, theme));
  }

  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
  out.push(
    dim(
      finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator",
    ),
  );
  return out.map((line) => fitLine(line, width));
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(
  _pi: ExtensionAPI,
  manager: WorkflowManager,
  ui: ExtensionUIContext,
  opts: TaskPanelOptions = {},
): void {
  // Live-read settings with a ~1s TTL: a render-path disk read every frame would
  // be wasteful, but re-reading at most once a second still makes
  // /workflows-progress take effect "immediately" (no restart).
  let cached: WorkflowSettings = {};
  let cachedAt = Number.NEGATIVE_INFINITY;
  const settings = (): WorkflowSettings => {
    if (!opts.loadSettings) return cached;
    const now = Date.now();
    if (now - cachedAt > 1000) {
      try {
        cached = opts.loadSettings() ?? {};
      } catch {
        cached = {};
      }
      cachedAt = now;
    }
    return cached;
  };
  const hasActiveRun = () => manager.listRuns().some((r) => r.status === "running" || r.status === "paused");

  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      const onEvent = () => tui.requestRender();
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      const onRunEnd = ({ runId }: { runId: string }) => clearTokenSamples(runId);
      for (const ev of RUN_END_EVENTS) manager.on(ev, onRunEnd);
      // In detailed mode, force a redraw every 2s while a run is active so the
      // token/s rate keeps updating between sparse token events — and decays to 0
      // when an agent stalls. Gated + unref'd so it costs nothing when idle.
      const timer = setInterval(() => {
        if (settings().progressPanelMode === "detailed" && hasActiveRun()) tui.requestRender();
      }, 2000);
      (timer as { unref?: () => void }).unref?.();
      // Purely informational: it lists running runs and re-renders on events. To
      // open the navigator, the user runs /workflows (the panel takes no input).
      const comp: Component & { dispose?(): void } = {
        render: (width: number) => {
          const s = settings();
          if (s.progressPanelMode === "detailed") {
            return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
          }
          return renderPanel(manager, theme, width);
        },
        invalidate: () => {},
        dispose: () => {
          clearInterval(timer);
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
          for (const ev of RUN_END_EVENTS) manager.off(ev, onRunEnd);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
