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
  tokenFigures,
  type WorkflowAgentSnapshot,
  type WorkflowSnapshot,
} from "./display.js";
import { type IconMode, type PanelSkin, paintStatus, panelSkin, resolveIconMode, treeConnector } from "./panel-skin.js";
import { redactAbsolutePaths, redactForModel, sanitizeForTerminal } from "./sanitize.js";
import { shimmerText } from "./shimmer.js";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import { DEFAULT_WORKFLOW_RESULT_CHARS, summarizeWorkflowResult } from "./workflow-result-projection.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
import { shortModel, WORKFLOW_NAV_SHORTCUT_LABEL } from "./workflow-ui.js";

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
  "deleted",
];
/** Events after which a run is gone and its token-rate samples can be dropped. */
// Pausing is a temporary state. Keep its token-rate samples so a resumed run
// can continue the same rolling window instead of looking like a new run.
const RUN_END_EVENTS = ["complete", "error", "stopped", "deleted"] as const;
const MAX_TOKEN_SAMPLES_PER_RUN = 128;
const MAX_TOKEN_SAMPLE_RUNS = 1024;
/** OMP's loader redraw cadence: fast enough for a one-cell-per-frame light sweep. */
const SHIMMER_FRAME_MS = 1000 / 30;
/** Avoid filling the rolling token window with identical 30 FPS animation samples. */
const MIN_UNCHANGED_TOKEN_SAMPLE_MS = 1000;
/**
 * Animation CPU ceiling, mirroring OMP's loader backpressure: idle for nine
 * times the last frame's cost so a burst of provider events cannot turn the
 * panel into a busy render loop.
 */
const FRAME_BACKPRESSURE_MULTIPLIER = 9;
/**
 * Terminal output backlog above which new frames are deferred (OMP's
 * pending-output gate): a slow PTY cannot drain queued bytes, so composing
 * more frames would only stack stale paints behind the backlog.
 */
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024;
/** Retry cadence while the output-backlog gate holds renders back. */
const OUTPUT_BACKLOG_RETRY_MS = 10;
/** Observed-snapshot window (OMP's AgentProgress): log entries surfaced in the detailed run body. */
const RECENT_LOG_LINES = 3;
/**
 * Coalesce bursts of manager events into one repaint per frame budget
 * (OMP's requestComponentRender semantics): events set a dirty flag; a
 * trailing-edge timer flushes at most one `requestRender` per cadence.
 */
const EVENT_FLUSH_MIN_INTERVAL_MS = SHIMMER_FRAME_MS;

/**
 * Frame scheduler for the panel's animation and event-driven repaints.
 * Mirrors OMP's loader tick loop: a recursive (not fixed-interval) timer that
 * measures each paint's cost, sleeps proportionally (adaptive backpressure),
 * and defers paints while the terminal's output backlog exceeds
 * {@link MAX_PENDING_OUTPUT_BYTES}.
 */
class PanelFrameScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private lastFrameCostMs = 0;

  /** Test hook: injects the delay between frames. Defaults to SHIMMER_FRAME_MS. */
  constructor(
    private readonly requestRender: () => void,
    private readonly readPendingOutputBytes: (() => number | undefined) | undefined,
    private readonly frameIntervalMs: number = SHIMMER_FRAME_MS,
  ) {}

  /** Request one repaint, coalesced into the running tick loop. */
  requestFrame(): void {
    if (this.disposed || this.timer) return;
    this.scheduleTick(0);
  }

  stop(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleTick(delayMs: number): void {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.disposed) return;
      const startedAt = performance.now();
      // Pending-output gate: while the terminal cannot drain what is already
      // queued, retry shortly instead of composing another stale frame.
      const pending = this.readPendingOutputBytes?.();
      if (typeof pending === "number" && pending > MAX_PENDING_OUTPUT_BYTES) {
        this.scheduleTick(OUTPUT_BACKLOG_RETRY_MS);
        return;
      }
      this.requestRender();
      this.lastFrameCostMs = performance.now() - startedAt;
      const cadenceDelayMs = Math.max(0, this.frameIntervalMs - this.lastFrameCostMs);
      // Adaptive backpressure: idle for nine times the paint cost so the
      // animation stays at or below ~10% CPU even when a slow terminal write
      // exceeds the normal cadence.
      const backpressureDelayMs = this.lastFrameCostMs * FRAME_BACKPRESSURE_MULTIPLIER;
      this.scheduleTick(Math.max(cadenceDelayMs, backpressureDelayMs));
    }, delayMs);
    (this.timer as { unref?: () => void }).unref?.();
  }
}

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

/** Standalone retry projections are only a cache. Durable terminal deliveries
 * remain authoritative in WorkflowManager's outbox and are reconstructed on
 * every resume, so this queue can be hard-bounded without losing results. */
const MAX_PENDING_DELIVERY_PROJECTIONS = 32;
/** Standalone hosts cannot observe provider acceptance, so submit only a
 * bounded number of durable records per host generation. Remaining records
 * stay in the outbox for a later generation instead of expanding a process-
 * lifetime dedup set without limit. */
const MAX_STANDALONE_SUBMISSIONS_PER_GENERATION = 512;

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

function terminalText(value: unknown): string {
  try {
    return sanitizeForTerminal(typeof value === "string" ? value : String(value ?? ""));
  } catch {
    return "";
  }
}

function modelText(value: string): string {
  return sanitizeForTerminal(redactForModel(value, Buffer.byteLength(value, "utf8")));
}

export function deliverText(run: ManagedRun, opts: { resultPath?: string; maxChars?: number } = {}): string {
  const maxChars =
    typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)
      ? Math.max(0, Math.floor(opts.maxChars))
      : DEFAULT_WORKFLOW_RESULT_CHARS;
  const summary = summarizeWorkflowResult(run.result?.result, maxChars);
  const tu = run.result?.tokenUsage;
  const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
  const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
  const agents = run.result?.agentCount ?? run.snapshot.agentCount;
  const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
  const lines = [
    `✓ Background workflow "${terminalText(run.snapshot.name)}" finished (${agents} agents${tokens}${duration}).`,
    "",
    summary,
  ];
  // The full result is intentionally not duplicated into provider context.
  // Point at the durable run record for exact JSON and per-agent reports. The
  // path may live outside the user's home (workspace/UNC/tmp), so redact the
  // absolute location before it enters provider context.
  if (opts.resultPath) lines.push("", `↳ Full result and subagent reports: ${redactAbsolutePaths(opts.resultPath)}`);
  return modelText(lines.join("\n"));
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
  manager: WorkflowManager;
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
  /** Durable IDs submitted during the current host generation. This prevents
   * outbox refill from resending the same record repeatedly in one resume pump. */
  submittedGeneration: Map<string, number>;
  /** Rate-limit projection-eviction warnings until a flush makes progress. */
  warnedProjectionEviction: boolean;
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
    deliveryId?: string;
  };
};

type DeliveryManager = WorkflowManager & {
  __deliveryInstalled?: boolean;
  __deliveryDisposer?: () => void;
  __holder?: DeliveryHolder;
};

function deliveryManager(manager: WorkflowManager): DeliveryManager {
  return manager as DeliveryManager;
}

function enqueuePending(holder: DeliveryHolder, payload: WorkflowDeliveryPayload): void {
  const deliveryId = payload.details?.deliveryId;
  if (deliveryId && holder.pending.some((item) => item.details?.deliveryId === deliveryId)) return;
  if (holder.pending.length >= MAX_PENDING_DELIVERY_PROJECTIONS) {
    // Durable records are replayed from WorkflowManager's stable-ID outbox on
    // resume. Keep the bounded in-memory cache biased toward the newest event;
    // an evicted durable projection is not acknowledged or deleted and will be
    // reconstructed later. Non-durable usage-limit notices are best-effort and
    // may be displaced under sustained delivery failure.
    holder.pending.shift();
    if (!holder.warnedProjectionEviction) {
      holder.warnedProjectionEviction = true;
      console.warn(
        `[workflow-delivery] pending projection cache reached ${MAX_PENDING_DELIVERY_PROJECTIONS} entries; ` +
          "older projections may be evicted from memory. Durable results remain replayable via /workflows.",
      );
    }
  }
  holder.pending.push(payload);
}

function trySend(holder: DeliveryHolder, payload: WorkflowDeliveryPayload): void {
  const startedGeneration = holder.generation;
  const runId = payload.details?.runId;
  const deliveryId = payload.details?.deliveryId;
  const standalone = !holder.sendResult;
  if (
    standalone &&
    deliveryId &&
    !holder.submittedGeneration.has(deliveryId) &&
    holder.submittedGeneration.size >= MAX_STANDALONE_SUBMISSIONS_PER_GENERATION
  ) {
    enqueuePending(holder, payload);
    return;
  }
  if (runId && deliveryId && !holder.manager.acknowledgeDelivery(runId, deliveryId, startedGeneration, "submitted")) {
    enqueuePending(holder, payload);
    return;
  }
  if (standalone && deliveryId) holder.submittedGeneration.set(deliveryId, startedGeneration);
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
    // Standalone delivery has no provider-response hook, so even a successful
    // host submission remains in the durable outbox. The next generation can
    // replay it at-least-once; only the full extension bridge can acknowledge
    // after provider acceptance.
    void Promise.resolve(ret).catch((err: unknown) => {
      if (standalone && deliveryId && holder.submittedGeneration.get(deliveryId) === startedGeneration) {
        holder.submittedGeneration.delete(deliveryId);
      }
      enqueuePending(holder, payload);
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[workflow-delivery] async send failed; queued for retry: ${msg}`);
      if (holder.generation !== startedGeneration && !holder.suspended) {
        flushPending(holder);
      }
    });
  } catch (err) {
    if (standalone && deliveryId && holder.submittedGeneration.get(deliveryId) === startedGeneration) {
      holder.submittedGeneration.delete(deliveryId);
    }
    enqueuePending(holder, payload);
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[workflow-delivery] send failed; queued for retry: ${msg}`);
  }
}

function flushPending(holder: DeliveryHolder): void {
  if (holder.suspended || holder.pending.length === 0) return;
  const queued = holder.pending.splice(0, holder.pending.length);
  holder.warnedProjectionEviction = false;
  for (const payload of queued) trySend(holder, payload);
}

/** Reconstruct terminal notifications that survived a process/session restart.
 * Standalone consumers do not have extensions/workflow.ts's richer bridge, so
 * they must refill from the manager's durable outbox themselves. */
function replayStandaloneOutbox(holder: DeliveryHolder): void {
  if (holder.sendResult) return;
  try {
    const records = holder.manager
      .listPendingDeliveries()
      .filter((record) => record.kind === "terminal")
      .sort((a, b) => (a.generation ?? -1) - (b.generation ?? -1) || a.sequence - b.sequence);
    for (const record of records) {
      if (holder.pending.length >= MAX_PENDING_DELIVERY_PROJECTIONS) break;
      if (holder.submittedGeneration.get(record.deliveryId) === holder.generation) continue;
      if (holder.pending.some((item) => item.details?.deliveryId === record.deliveryId)) continue;

      // A paused checkpoint (usage-limit auto-pause) is NOT a terminal outcome:
      // it must be replayed as "paused", never as the deliverText "finished"
      // copy or the completed/failed binary, so a restart does not misreport a
      // resumable run as done (or failed).
      const run = holder.manager.getRun(record.runId);
      if (record.checkpoint === "paused" || run?.status === "paused") {
        enqueuePending(holder, {
          content: `⏸ Background workflow ${record.runId} paused. Completed steps are saved — resume it once the limit resets.`,
          details: {
            status: "paused",
            isError: false,
            notificationKind: "workflow-result",
            runId: record.runId,
            sequence: record.sequence,
            deliveryId: record.deliveryId,
          },
        });
        continue;
      }

      const content = run
        ? deliverText(run, { resultPath: persistedResultPath(holder.manager, record.runId) })
        : `${record.runStatus === "completed" ? "✓" : "✗"} Background workflow ${record.runId} ${record.runStatus}.`;
      enqueuePending(holder, {
        content,
        details: {
          status: record.runStatus === "completed" ? "completed" : "failed",
          isError: record.runStatus !== "completed",
          notificationKind: "workflow-result",
          runId: record.runId,
          sequence: record.sequence,
          deliveryId: record.deliveryId,
        },
      });
    }
  } catch {
    // A transient persistence/read failure leaves the durable outbox untouched;
    // the next generation can retry reconstruction.
  }
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
  // First submit the bounded live retry cache, then refill from the durable
  // outbox in finite batches. Durable outboxes are schema-bounded (512 records),
  // so this pump cannot grow memory or loop without progress.
  flushPending(holder);
  while (true) {
    const before = holder.submittedGeneration.size;
    replayStandaloneOutbox(holder);
    if (holder.pending.length === 0) break;
    flushPending(holder);
    if (holder.pending.length > 0 || holder.submittedGeneration.size === before) break;
  }
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
 * Returns an idempotent disposer that removes the three manager listeners and
 * clears the installation marker so a later session can install a fresh holder.
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
      if (message?.role !== "custom" || message.customType !== "workflow-result") {
        output.push(message && typeof message === "object" ? { ...message } : message);
        continue;
      }
      const contentDescriptor =
        message && typeof message === "object" ? Object.getOwnPropertyDescriptor(message, "content") : undefined;
      const rawText =
        contentDescriptor && !contentDescriptor.get && !contentDescriptor.set ? contentDescriptor.value : "";
      const raw = typeof rawText === "string" ? rawText : String(rawText ?? "");
      const text = sanitizeForTerminal(redactForModel(raw, 32_000));
      const deliveryId =
        message.details && typeof message.details.deliveryId === "string" ? message.details.deliveryId : undefined;
      // A corrupt/persisted deliveryId may contain characters a provider rejects
      // in a toolCall id; fall back to a positional id instead of passing it through.
      const PROVIDER_TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
      const toolCallId =
        deliveryId && PROVIDER_TOOL_CALL_ID.test(deliveryId)
          ? deliveryId
          : `workflow_result_${index}_${message.timestamp ?? 0}`;
      output.push({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: "workflow_delivery",
            arguments: { customType: "workflow-result", status: message.details?.status ?? null },
          },
        ],
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
): () => void {
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
      m.__holder.submittedGeneration.clear();
    }
    return m.__deliveryDisposer ?? (() => {});
  }
  m.__deliveryInstalled = true;
  m.__holder = {
    manager,
    pi,
    loadSettings: opts.loadSettings,
    sendResult: opts.sendResult,
    suspended: false,
    pending: [],
    submittedGeneration: new Map(),
    warnedProjectionEviction: false,
    generation: 0,
  };

  const deliver = (payload: WorkflowDeliveryPayload) => {
    const holder = m.__holder;
    if (!holder) return;
    const content = modelText(payload.content);
    const safePayload = content === payload.content ? payload : { ...payload, content };
    if (holder.suspended) {
      enqueuePending(holder, safePayload);
      return;
    }
    trySend(holder, safePayload);
  };

  let notificationSequence = 0;
  const onComplete = ({ runId, deliveryId, sequence }: { runId: string; deliveryId?: string; sequence?: number }) => {
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
          sequence: sequence ?? notificationSequence++,
          deliveryId,
        },
      });
    }
  };
  manager.on("complete", onComplete);
  const onError = ({
    runId,
    error,
    deliveryId,
    sequence,
  }: {
    runId: string;
    error?: { message?: string };
    deliveryId?: string;
    sequence?: number;
  }) => {
    if (!manager.getRun(runId)?.background) return;
    deliver({
      content: `✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`,
      details: {
        status: "failed",
        isError: true,
        notificationKind: "workflow-result",
        runId,
        sequence: sequence ?? notificationSequence++,
        deliveryId,
      },
    });
  };
  manager.on("error", onError);
  // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
  // user it is resumable once their budget refills, rather than letting it look dead.
  // Manual pause() also emits "paused" but with no reason — guard so only the
  // usage-limit case delivers a message.
  const onPaused = ({
    runId,
    reason,
    error,
    resetHint,
    deliveryId,
    sequence,
    content,
  }: {
    runId: string;
    reason?: string;
    error?: { message?: string };
    resetHint?: string;
    deliveryId?: string;
    sequence?: number;
    content?: string;
  }) => {
    if (reason !== "usage_limit") return;
    if (!manager.getRun(runId)?.background) return;
    const when = resetHint ? ` (${resetHint})` : "";
    const cause = error?.message ?? "provider usage limit reached";
    deliver({
      content:
        content ??
        `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
          `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`,
      details: {
        status: "paused",
        isError: true,
        notificationKind: "workflow-result",
        runId,
        sequence: sequence ?? notificationSequence++,
        deliveryId,
      },
    });
  };
  manager.on("paused", onPaused);

  const disposer = () => {
    if (!m.__deliveryInstalled || m.__deliveryDisposer !== disposer) return;
    manager.off("complete", onComplete);
    manager.off("error", onError);
    manager.off("paused", onPaused);
    m.__deliveryInstalled = false;
    m.__deliveryDisposer = undefined;
    m.__holder = undefined;
  };
  m.__deliveryDisposer = disposer;
  return disposer;
}

/** Options for the zentui-style tree renderers. */
export interface PanelSkinOptions {
  /** Glyph set: "auto" Unicode tree glyphs (default) or "ascii" fallbacks. */
  iconMode?: IconMode;
  /** Show the navigator hint row (default true). */
  hint?: boolean;
}

/**
 * Zentui-style tree panel (compact): one summary header, then each active run
 * as a tree row with its aggregate progress. Phase and agent labels belong to
 * the detailed view so the compact row stays easy to scan.
 */
export function renderPanel(
  manager: WorkflowManager,
  theme: Theme,
  width?: number,
  now = Date.now(),
  options?: PanelSkinOptions,
): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const skin = panelSkin(options?.iconMode ?? "auto");
  const dim = (text: string) => theme.fg("dim", text);
  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused");
  const failedCount = finished.filter((r) => r.status === "failed").length;
  const finishedCount = finished.length;

  const segments = [`${active.length} active`, `${finishedCount - failedCount} done`, `${failedCount} failed`];
  const header = `${theme.fg("accent", skin.headerDot)} ${theme.fg("accent", theme.bold("Workflows"))} ${theme.fg(
    "muted",
    "—",
  )} ${dim(segments.join(" · "))}`;

  const rows = active.map((r, index) => {
    const last = index === active.length - 1;
    const connector = treeConnector(skin, last, theme);
    const live = manager.getRun(r.runId);
    // UIOBS-007: persisted JSON is not structurally validated — a corrupt or
    // legacy `agents` value (null/object) must never crash the panel render.
    const agents = safeAgentSnapshots(live?.snapshot.agents ?? r.agents);
    const done = agents.filter((a) => a.status === "done").length;
    const runningAgents = agents.filter((a) => a.status === "running");
    const queued = agents.filter((a) => a.status === "queued").length;
    const errors = agents.filter((a) => a.status === "error").length;
    const state = r.status === "paused" ? "paused" : "running";
    const icon = paintStatus(r.status === "paused" ? skin.paused : skin.running, state, theme);
    const runUsage = aggregateAgentUsage(agents);
    sampleTokens(r.runId, runUsage.fresh + runUsage.cacheRead, now);
    const rate = r.status === "running" ? tokensPerSecond(r.runId) : 0;
    const cost = live?.snapshot.tokenUsage?.cost ?? r.tokenUsage?.cost ?? 0;
    const meta = [
      `${done}/${agents.length} agents`,
      runningAgents.length ? `${runningAgents.length} running` : "",
      queued ? `${queued} queued` : "",
      errors ? `${errors} ${errors === 1 ? "error" : "errors"}` : "",
      fmtTokenSegment(runUsage, fmtTokensShort),
      cost > 0 ? fmtCost(cost) : "",
      rate > 0 ? `${Math.round(rate)} tok/s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const workflowName = terminalText(r.workflowName);
    if (r.status === "running") {
      const rawConnector = last ? skin.lastBranch : skin.branch;
      return shimmerText(`${rawConnector} ${skin.running} ${workflowName}  ${meta}`, theme, now);
    }
    return `${connector} ${icon} ${workflowName}  ${dim(meta)}`;
  });
  // Finished runs leave this live panel but are kept in the navigator. Tell
  // the user so a completed run doesn't look like it vanished. The hint row is
  // optional: pass hint: false to drop it entirely.
  if (options?.hint !== false) {
    const hint = theme.fg(
      "dim",
      finishedCount > 0
        ? `  ${WORKFLOW_NAV_SHORTCUT_LABEL} open · ↑/↓ select · Enter inspect · /workflows fallback (${finishedCount} finished kept in history)`
        : `  ${WORKFLOW_NAV_SHORTCUT_LABEL} open · ↑/↓ select · Enter inspect · /workflows fallback`,
    );
    rows.push(hint);
  }
  return [header, ...rows].map((line) => fitLine(line, width));
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
  // Shimmer repaints at 30 FPS. Keep plateau samples coarse while still adding
  // one each second so a stalled rate naturally decays to zero.
  if (last && last.total === total && now - last.ts < MIN_UNCHANGED_TOKEN_SAMPLE_MS) return;
  samples.push({ ts: now, total });
  if (samples.length > MAX_TOKEN_SAMPLES_PER_RUN) samples.splice(0, samples.length - MAX_TOKEN_SAMPLES_PER_RUN);
  if (!tokenSamples.has(runId) && tokenSamples.size >= MAX_TOKEN_SAMPLE_RUNS) {
    const oldestRun = tokenSamples.keys().next().value as string | undefined;
    if (oldestRun) tokenSamples.delete(oldestRun);
  }
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
  now: number,
  skin: PanelSkin,
): string[] {
  const dim = (t: string) => theme.fg("dim", t);
  const muted = (t: string) => theme.fg("muted", t);
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
  const renderedPhases = order.filter((title) => (byPhase.get(title) ?? []).length > 0);
  for (let phaseIndex = 0; phaseIndex < renderedPhases.length; phaseIndex++) {
    const title = renderedPhases[phaseIndex];
    const lastPhase = phaseIndex === renderedPhases.length - 1;
    const phaseAgents = byPhase.get(title) ?? [];
    if (!phaseAgents.length) continue;
    const done = phaseAgents.filter((a) => a.status === "done").length;
    const running = phaseAgents.filter((a) => a.status === "running").length;
    const errors = phaseAgents.filter((a) => a.status === "error").length;
    const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
    const complete = done + errors + skipped === phaseAgents.length;
    const livePhase = running > 0 || (!complete && snap.currentPhase === title);
    const marker = livePhase
      ? paintStatus(skin.running, "running", theme)
      : complete
        ? paintStatus(skin.done, "done", theme)
        : paintStatus(skin.pending, "queued", theme);
    const phaseMeta = [
      `${done}/${phaseAgents.length} agents`,
      running ? `${running} running` : "",
      errors ? `${errors} errors` : "",
      fmtTokenSegment(aggregateAgentUsage(phaseAgents), fmtTokensShort),
    ]
      .filter(Boolean)
      .join(" · ");
    const phaseTitle = terminalText(title);
    const styledTitle = livePhase ? shimmerText(phaseTitle, theme, now) : theme.fg("accent", phaseTitle);
    lines.push(`${muted("│ ")}${marker} ${styledTitle}${dim(`  ${phaseMeta}`)}`);

    const visible = phaseAgents.slice(-maxAgents);
    for (let i = 0; i < visible.length; i++) {
      const a = visible[i];
      const lastAgent = lastPhase && i === visible.length - 1;
      const childConnector = muted(lastAgent ? skin.lastBranch : skin.branch);
      const segment = fmtTokenSegment(tokenFigures(a.tokenUsage, a.tokens), fmtTokensShort);
      const tok = segment ? dim(` ${segment}`) : "";
      const mdl = terminalText(shortModel(a.model) ?? "");
      const model = mdl ? dim(` · ${mdl}`) : "";
      const label = shorten(terminalText(a.label), 40);
      const styledLabel = a.status === "running" ? shimmerText(label, theme, now) : label;
      const glyph =
        a.status === "running"
          ? skin.running
          : a.status === "done"
            ? skin.done
            : a.status === "error"
              ? skin.error
              : a.status === "skipped"
                ? skin.skipped
                : skin.pending;
      lines.push(`${childConnector} ${paintStatus(glyph, a.status, theme)} ${styledLabel}${tok}${model}`);
    }
    if (phaseAgents.length > visible.length) {
      lines.push(dim(`  ${skin.ellipsis} ${phaseAgents.length - visible.length} earlier agents`));
    }
  }
  // Observed-snapshot window: the last few log lines under the tree, capped so
  // the panel's row budget survives verbose runs. Mirrors OMP's AgentProgress
  // recent-output semantics — a bounded observation window, not the full log.
  const recentLogs = snap.logs.slice(-RECENT_LOG_LINES);
  for (const entry of recentLogs) {
    const text = terminalText(entry);
    if (!text) continue;
    lines.push(dim(`  ${skin.ellipsis} ${shorten(text, 72)}`));
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
  options?: PanelSkinOptions,
): string[] {
  const all = manager.listRuns();
  const active = all.filter((r) => r.status === "running" || r.status === "paused");
  if (!active.length) return [];
  const skin = panelSkin(options?.iconMode ?? "auto");
  const dim = (t: string) => theme.fg("dim", t);
  const finished = all.filter((r) => r.status !== "running" && r.status !== "paused");
  const failedCount = finished.filter((r) => r.status === "failed").length;
  const segments = [`${active.length} active`, `${finished.length - failedCount} done`, `${failedCount} failed`];
  const header = `${theme.fg("accent", skin.headerDot)} ${theme.fg("accent", theme.bold("Workflows"))} ${theme.fg(
    "muted",
    "—",
  )} ${dim(segments.join(" · "))}`;
  const out: string[] = [header];

  for (let index = 0; index < active.length; index++) {
    const r = active[index];
    const last = index === active.length - 1;
    const connector = treeConnector(skin, last, theme);
    const live = manager.getRun(r.runId);
    const snap = live?.snapshot;
    // UIOBS-007: same malformed-state guard as the compact panel.
    const agents = safeAgentSnapshots(snap?.agents ?? r.agents);
    const done = agents.filter((a) => a.status === "done").length;
    const state = r.status === "paused" ? "paused" : "running";
    const icon = paintStatus(r.status === "paused" ? skin.paused : skin.running, state, theme);
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
      fmtTokenSegment(runUsage, fmtTokensShort),
      // (cost is only known once the run finalizes its usage.)
      usage?.cost ? fmtCost(usage.cost) : "",
      rate > 0 ? `${Math.round(rate)} tok/s` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const workflowName = terminalText(r.workflowName);
    if (r.status === "running") {
      const rawConnector = last ? skin.lastBranch : skin.branch;
      out.push(shimmerText(`${rawConnector} ${skin.running} ${workflowName}  ${meta}`, theme, now));
    } else {
      out.push(`${connector} ${icon} ${theme.bold(workflowName)}  ${dim(meta)}`);
    }
    if (snap) out.push(...renderRunBody(snap, agents, maxAgents, theme, now, skin));
  }

  const finishedCount = finished.length;
  // The navigator hint row is optional: pass hint: false to drop it entirely.
  if (options?.hint !== false) {
    out.push(
      dim(
        finishedCount > 0
          ? `  ${WORKFLOW_NAV_SHORTCUT_LABEL} open · ↑/↓ select · Enter inspect · /workflows fallback (${finishedCount} finished kept in history)`
          : `  ${WORKFLOW_NAV_SHORTCUT_LABEL} open · ↑/↓ select · Enter inspect · /workflows fallback`,
      ),
    );
  }
  return out.map((line) => fitLine(line, width));
}

/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. The widget stays non-capturing so it never steals bare
 * arrow keys from the editor; Alt+↓ opens the focused navigator, where arrows
 * and Enter work directly. (`_pi` is kept for signature stability.)
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
  // Live shimmer and detailed token sampling need periodic ticks only while
  // providers are actually working. Paused panels stay event-driven.
  const hasActiveRun = () => manager.listRuns().some((r) => r.status === "running");

  ui.setWidget(
    "workflow-tasks",
    (tui: TUI, theme: Theme) => {
      // Coalesced repaint scheduler: manager events only set the dirty flag;
      // frames are composed at the shimmer cadence with OMP-style adaptive
      // backpressure. The TUI's own pending-output backlog feeds the gate when
      // the terminal exposes it, so a slow PTY never stacks stale frames.
      const scheduler = new PanelFrameScheduler(
        () => tui.requestRender(),
        () => (tui as { pendingOutputBytes?: number }).pendingOutputBytes,
      );
      let lastFlushAt = Number.NEGATIVE_INFINITY;
      const onEvent = () => {
        // Trailing-edge coalescing: one repaint per EVENT_FLUSH_MIN_INTERVAL
        // no matter how many events land in between. Without an active run the
        // panel is event-driven only — the scheduler timer is not running, so
        // flush immediately (once) here.
        if (!hasActiveRun()) {
          const now = performance.now();
          if (now - lastFlushAt >= EVENT_FLUSH_MIN_INTERVAL_MS) {
            lastFlushAt = now;
            cachedLines = undefined;
            cacheValid = false;
            tui.requestRender();
          }
          scheduler.stop();
          return;
        }
        lastFlushAt = performance.now();
        cachedLines = undefined;
        cacheValid = false;
        scheduler.requestFrame();
      };
      const onRunEnd = ({ runId }: { runId: string }) => {
        clearTokenSamples(runId);
        onEvent();
      };
      for (const ev of RUN_EVENTS) manager.on(ev, onEvent);
      for (const ev of RUN_END_EVENTS) manager.on(ev, onRunEnd);
      // Running panels repaint for the OMP-style light sweep. Idle and paused
      // panels own no periodic timer and perform no settings/disk reads merely
      // because the widget exists.
      // Non-capturing summary: it lists running runs and re-renders on events.
      // The extension-level Alt+↓ shortcut opens the focused navigator; the
      // widget itself takes no input and therefore cannot steal editor arrows.
      // Row-reference cache (OMP's Container/Box memo): when the width is
      // unchanged and no manager event has landed since the previous compose,
      // re-publish the previous line array reference. The host TUI then skips
      // diffing/padding identical rows, so idle shimmer frames cost a
      // reference comparison instead of a full snapshot walk.
      let cachedLines: string[] | undefined;
      let cachedWidth: number | undefined;
      let cacheValid = false;
      const comp: Component & { dispose?(): void } = {
        render: (width: number) => {
          if (cachedLines !== undefined && cacheValid && width === cachedWidth) {
            return cachedLines;
          }
          const s = settings();
          const iconMode = resolveIconMode(s.progressPanelIcons);
          const mode = s.progressPanelMode === "detailed" ? "detailed" : "compact";
          const now = Date.now();
          const lines =
            mode === "detailed"
              ? renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), now, {
                  iconMode,
                  hint: false,
                })
              : renderPanel(manager, theme, width, now, { iconMode, hint: false });
          // Shimmer labels repaint every frame while a run is live, so cache
          // only the settled (no active running run) composition; the live
          // path stays uncached to keep the light sweep moving. Manager
          // events invalidate via onEvent below, so a cached array is never
          // stale across a state change.
          if (!hasActiveRun()) {
            cachedLines = lines;
            cachedWidth = width;
            cacheValid = true;
          } else {
            cachedLines = undefined;
            cacheValid = false;
          }
          return lines;
        },
        invalidate: () => {
          cachedLines = undefined;
          cacheValid = false;
        },
        dispose: () => {
          scheduler.stop();
          for (const ev of RUN_EVENTS) manager.off(ev, onEvent);
          for (const ev of RUN_END_EVENTS) manager.off(ev, onRunEnd);
        },
      };
      return comp;
    },
    { placement: "belowEditor" },
  );
}
