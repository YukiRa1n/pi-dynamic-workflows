import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type ExtensionAPI, type ExtensionContext, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import {
  claimWorkflowRuntime,
  discardWorkflowRuntime,
  handoffWorkflowRuntime,
  pauseStrandedWorkflowRuntime,
  SESSION_REPLACEMENT_REASONS,
  WORKFLOW_EXTENSION_VERSION,
  type WorkflowReloadRuntime,
} from "../src/extension-reload.js";
import {
  createEffortState,
  createWebTools,
  createWorkflowStorage,
  createWorkflowTool,
  type EffortState,
  installResultDelivery,
  installTaskPanel,
  installWorkflowKeywordArming,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  resumeResultDelivery,
  saveWorkflowSettingsForCwd,
  suspendResultDelivery,
  UsageLimitScheduler,
  type WorkflowDeliveryPayload,
  WorkflowManager,
} from "../src/index.js";
import { truncateUtf8 } from "../src/safe-serialize.js";
import type { WorkflowStorage } from "../src/workflow-saved.js";

/**
 * Bound for the read-only session-header probe (first line only). Independent of
 * pi's own ~1MiB session scan — we only need the header and keep the read small.
 */
const SESSION_HEADER_SCAN_BYTES = 64 * 1024;

/**
 * Read-only probe of a session JSONL file's project cwd from its header line.
 * Does NOT call SessionManager.open() — that API creates directories, may rewrite
 * empty/legacy files, and loads the full history. Used on session_shutdown for
 * resume/fork destination checks. Unreadable / oversized / non-session files
 * return undefined; callers decide fail-closed vs allow based on the shutdown reason.
 */
export function sessionFileCwd(sessionFile: string | undefined): string | undefined {
  if (!sessionFile || !existsSync(sessionFile)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, "r");
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(4096);
    const chunks: string[] = [];
    let scanned = 0;
    while (scanned < SESSION_HEADER_SCAN_BYTES) {
      const n = readSync(fd, buffer, 0, Math.min(buffer.length, SESSION_HEADER_SCAN_BYTES - scanned), null);
      if (n === 0) {
        chunks.push(decoder.end());
        break;
      }
      scanned += n;
      const chunk = decoder.write(buffer.subarray(0, n));
      const nl = chunk.indexOf("\n");
      if (nl !== -1) {
        chunks.push(chunk.slice(0, nl));
        break;
      }
      chunks.push(chunk);
    }
    const line = chunks.join("").trim();
    if (!line) return undefined;
    const entry = JSON.parse(line) as { type?: string; cwd?: unknown };
    if (entry.type !== "session" || typeof entry.cwd !== "string" || !entry.cwd) return undefined;
    return resolve(entry.cwd);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors on the probe fd
      }
    }
  }
}

/** Windows paths are case-insensitive; comparing raw resolved strings can
 * incorrectly rebuild a manager or reject a same-project resume. */
function sameWorkflowPath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return left === right;
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function buildManagerOptions(cwd: string, storage: WorkflowStorage) {
  const settings = loadWorkflowSettings({ cwd });
  return {
    loadSavedWorkflow: (name: string) => storage.load(name)?.script,
    toolsets: {
      // Least privilege: research subagents need network retrieval, not shell or
      // filesystem mutation. WorkflowAgent uses this toolset as its complete
      // base tool list for the run.
      "web-research": () => createWebTools(),
    },
    excludeSubagentTools: settings.excludeSubagentTools,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    defaultTokenBudget: settings.defaultTokenBudget ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
    persistAgentSessions: settings.persistAgentSessions,
  };
}

/**
 * Bridge terminal results and explicit task-changing alerts into this session.
 * Routine subagent completions stay in the durable run record and UI instead of
 * consuming provider context. deliverAs "steer" lands at the next safe point of
 * an active turn, after its current tool-call batch. triggerTurn wakes an idle
 * main session. Re-bound on every generation/manager rebuild because `pi` is
 * generation-bound.
 */
const COLLAPSED_MESSAGE_LINES = 8;
const COLLAPSED_MESSAGE_CHARS = 1_200;

function customMessageText(content: unknown): string {
  const limit = 32_000;
  if (typeof content === "string") return truncateUtf8(content, limit, "…");
  if (!Array.isArray(content)) return truncateUtf8(String(content ?? ""), limit, "…");
  let output = "";
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as { type?: unknown; text?: unknown };
    if (candidate.type !== "text" || typeof candidate.text !== "string") continue;
    const separator = output ? "\n" : "";
    const remaining = limit - Buffer.byteLength(output, "utf8") - Buffer.byteLength(separator, "utf8");
    if (remaining <= 0) break;
    output += separator + truncateUtf8(candidate.text, remaining, "");
  }
  return truncateUtf8(output, limit, "…");
}

function collapsedMessageText(text: string): { text: string; omitted: boolean } {
  const lines = text.split("\n");
  let preview = lines.slice(0, COLLAPSED_MESSAGE_LINES).join("\n");
  let omitted = lines.length > COLLAPSED_MESSAGE_LINES;
  if (preview.length > COLLAPSED_MESSAGE_CHARS) {
    preview = preview.slice(0, COLLAPSED_MESSAGE_CHARS);
    omitted = true;
  }
  return { text: preview, omitted };
}

/** Display-only folding. Provider-facing types retain their bounded full payload; legacy workflow-agent entries stay display-only. */
function registerWorkflowMessageRenderers(pi: ExtensionAPI): void {
  // Minimal/headless hosts and older Pi test doubles may not expose renderer
  // registration. Rendering is optional and must never prevent the delivery,
  // persistence, or lifecycle bridges from installing.
  if (typeof pi.registerMessageRenderer === "function") {
    for (const customType of ["workflow-agent", "workflow-deliver", "workflow-result"] as const) {
      pi.registerMessageRenderer(customType, (message, { expanded, outputPad }, theme) => {
        const full = customMessageText(message.content);
        const preview = expanded ? { text: full, omitted: false } : collapsedMessageText(full);
        // Pi 0.80.x did not pass outputPad to custom renderers. Keep the
        // published peer range honest instead of feeding NaN into the TUI.
        const leftPad = Number.isFinite(outputPad) ? Math.max(0, outputPad) : 0;
        const box = new Box(leftPad, 1, (text) => theme.bg("customMessageBg", text));
        box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[${customType}]`)), 0, 0));
        box.addChild(new Spacer(1));
        box.addChild(
          new Markdown(preview.text, 0, 0, getMarkdownTheme(), {
            color: (text) => theme.fg("customMessageText", text),
          }),
        );
        if (preview.omitted) {
          box.addChild(new Spacer(1));
          box.addChild(
            new Text(theme.fg("dim", "… message folded; expand tool output to view the full delivery"), 0, 0),
          );
        }
        return box;
      });
    }
  }

  // Compatibility renderer for durable/display-only workflow-agent entries.
  // Automatic final reports stay in run persistence/pagers and never enter the
  // provider context; older sessions may still contain legacy custom entries.
  if (typeof pi.registerEntryRenderer !== "function") return;
  pi.registerEntryRenderer("workflow-agent", (entry, { expanded }, theme) => {
    const data = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : {};
    const label = typeof data.label === "string" && data.label ? ` ${data.label}` : "";
    const text = typeof data.text === "string" ? data.text : customMessageText(data.text);
    const full = `${label ? `[${label.trim()}]\n` : ""}${text}`;
    const preview = expanded ? { text: full, omitted: false } : collapsedMessageText(full);
    const box = new Box(0, 1, (value) => theme.bg("customMessageBg", value));
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[workflow-agent]")), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(
      new Markdown(preview.text, 0, 0, getMarkdownTheme(), {
        color: (value) => theme.fg("customMessageText", value),
      }),
    );
    if (preview.omitted) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("dim", "… message folded; expand tool output to view the full result"), 0, 0));
    }
    return box;
  });
}

const WORKFLOW_CUSTOM_TYPES = new Set(["workflow-agent", "workflow-deliver", "workflow-result"]);
const PROVIDER_WORKFLOW_CUSTOM_TYPES = new Set(["workflow-deliver", "workflow-result"]);
const WORKFLOW_BRIDGE_QUEUE_LIMIT = 64;
const WORKFLOW_BRIDGE_DEDUP_LIMIT = 256;
const WORKFLOW_BRIDGE_PAYLOAD_LIMIT = 32_000;
const WORKFLOW_BRIDGE_IN_FLIGHT_LIMIT = 64;
const WORKFLOW_BRIDGE_UNCERTAIN_LIMIT = 64;
const WORKFLOW_BRIDGE_ACK_TIMEOUT_MS = 120_000;
/** A terminal record is never displaced by an explicit burst. This bound is
 * independent of ordinary queue pressure; older terminals remain durable in
 * the run outbox if the bridge reaches this ceiling. */
const WORKFLOW_BRIDGE_TERMINAL_LIMIT = 256;

type WorkflowDeliveryDetails = {
  isError?: boolean;
  status?: "completed" | "failed" | "paused";
  notificationKind?: "agent-completed" | "workflow-message" | "workflow-result";
  runId?: string;
  agentId?: string;
  label?: string;
  alertKind?: "blocker" | "critical_finding" | "decision";
  sequence?: number;
  /** Internal acknowledgement identity; forwarded only as notification metadata. */
  deliveryId?: string;
  /** Generation that submitted the message to Pi's steering queue. */
  deliveryGeneration?: number;
};

type WorkflowBridgeDelivery = {
  id: string;
  customType: "workflow-agent" | "workflow-deliver" | "workflow-result";
  content: string;
  details?: WorkflowDeliveryDetails;
  wake: boolean;
};

type WorkflowBridgeUncertainDelivery = {
  delivery: WorkflowBridgeDelivery;
  generation: number;
};

type WorkflowBridgeAckWatchdog = {
  generation: number;
  /** Absolute deadline while armed. */
  deadline: number;
  /** Remaining duration captured when the timer is paused for compaction. */
  remainingMs?: number;
  timer?: ReturnType<typeof setTimeout>;
};

type WorkflowBridge = {
  manager: WorkflowManager;
  pi: ExtensionAPI;
  suspended: boolean;
  /** True from session_before_compact until a post-compaction safe point. */
  compacting: boolean;
  /** Fences delayed completion/abort callbacks from an older compaction. */
  compactionGeneration: number;
  generation: number;
  nextEventSeq: number;
  pending: WorkflowBridgeDelivery[];
  delivered: Set<string>;
  /** Sent to Pi but not yet accepted by a provider request. */
  awaitingAck: Map<string, WorkflowBridgeDelivery>;
  /** Timed out without proof of delivery; never retried in the same generation. */
  uncertainAck: Map<string, WorkflowBridgeUncertainDelivery>;
  /** Generation-fenced timers for awaitingAck entries. */
  ackWatchdogs: Map<string, WorkflowBridgeAckWatchdog>;
  /** IDs observed in the latest context projection, consumed by before_provider_request. */
  projectedForNextRequest: Array<{ id: string; generation: number }>;
  /** Included in a provider request; retained until after_provider_response. */
  includedInProviderRequest: Array<{ id: string; generation: number }>;
  /** One-shot safe-point retries for rejected sends or durable phase-transition failures. */
  retryingSendIds: Set<string>;
  /** Set after a user-aborted agent run; delivery must not wake a new run until input. */
  abortFence: boolean;
};

type ManagerWithWorkflowBridge = WorkflowManager & { __workflowBridge?: WorkflowBridge };

function bridgeFor(manager: WorkflowManager): WorkflowBridge | undefined {
  return (manager as ManagerWithWorkflowBridge).__workflowBridge;
}

function persistDeliveryPhase(
  manager: WorkflowManager,
  runId: string | undefined,
  deliveryId: string,
  generation: number,
  phase: "submitted" | "projected" | "acknowledged",
): boolean {
  if (!runId || typeof manager.acknowledgeDelivery !== "function") return false;
  try {
    return manager.acknowledgeDelivery(runId, deliveryId, generation, phase);
  } catch {
    // Durable replay remains conservative when a generation is stale or a CAS
    // loses a race; never turn a provider hook failure into message loss.
    return false;
  }
}

function hashDeliveryId(value: string): string {
  // Stable, dependency-free 64-bit ID. It is deliberately restricted to the
  // provider-safe tool-call ID alphabet and is not used as a security token.
  // Two independent 32-bit lanes avoid the practical collision rate of the
  // old single-lane FNV ID when hundreds/thousands of messages are delivered.
  let left = 2166136261;
  let right = 0x9e3779b9;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    left = Math.imul(left ^ code, 16777619);
    right = Math.imul(right ^ (code + i), 2246822519);
  }
  return `wf_${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}

function rememberDelivery(bridge: WorkflowBridge, id: string): void {
  bridge.delivered.add(id);
  while (bridge.delivered.size > WORKFLOW_BRIDGE_DEDUP_LIMIT) {
    const oldest = bridge.delivered.values().next().value as string | undefined;
    if (oldest === undefined) break;
    bridge.delivered.delete(oldest);
  }
}

function boundedWorkflowContent(content: string): string {
  if (Buffer.byteLength(content, "utf8") <= WORKFLOW_BRIDGE_PAYLOAD_LIMIT) return content;
  const marker =
    "\n\n[workflow-delivery payload omitted; inspect the durable run record for the complete artifact]\n\n";
  const available = Math.max(0, WORKFLOW_BRIDGE_PAYLOAD_LIMIT - Buffer.byteLength(marker, "utf8"));
  const head = Math.ceil(available * 0.7);
  const tail = available - head;
  return `${truncateUtf8(content, head, "")}${marker}${truncateUtf8(content.slice(-tail), tail, "")}`;
}

function normalizedWorkflowDelivery(delivery: WorkflowBridgeDelivery): WorkflowBridgeDelivery {
  const content = boundedWorkflowContent(delivery.content);
  return content === delivery.content ? delivery : { ...delivery, content };
}

function workflowBridgeAckTimeoutMs(): number {
  const configured = Number(process.env.PI_WORKFLOW_DELIVERY_ACK_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 10 && configured <= 10 * 60_000
    ? configured
    : WORKFLOW_BRIDGE_ACK_TIMEOUT_MS;
}

function isUncertainInCurrentGeneration(bridge: WorkflowBridge, deliveryId: string): boolean {
  return bridge.uncertainAck.get(deliveryId)?.generation === bridge.generation;
}

function clearWorkflowAckWatchdog(bridge: WorkflowBridge, deliveryId: string, generation?: number): void {
  const watchdog = bridge.ackWatchdogs.get(deliveryId);
  if (!watchdog || (generation !== undefined && watchdog.generation !== generation)) return;
  if (watchdog.timer) clearTimeout(watchdog.timer);
  bridge.ackWatchdogs.delete(deliveryId);
}

function clearWorkflowProviderTracking(bridge: WorkflowBridge, deliveryId: string, generation: number): void {
  bridge.projectedForNextRequest = bridge.projectedForNextRequest.filter(
    (entry) => entry.id !== deliveryId || entry.generation !== generation,
  );
  bridge.includedInProviderRequest = bridge.includedInProviderRequest.filter(
    (entry) => entry.id !== deliveryId || entry.generation !== generation,
  );
}

function startWorkflowAckWatchdog(
  bridge: WorkflowBridge,
  delivery: WorkflowBridgeDelivery,
  generation: number,
  timeoutMs = workflowBridgeAckTimeoutMs(),
): void {
  clearWorkflowAckWatchdog(bridge, delivery.id);
  const deadline = Date.now() + timeoutMs;
  const watchdog: WorkflowBridgeAckWatchdog = { generation, deadline };
  const timer = setTimeout(() => {
    const watchdog = bridge.ackWatchdogs.get(delivery.id);
    if (!watchdog || watchdog.generation !== generation) return;
    bridge.ackWatchdogs.delete(delivery.id);
    const awaiting = bridge.awaitingAck.get(delivery.id);
    if (awaiting?.details?.deliveryGeneration !== generation) return;
    if (bridge.uncertainAck.size >= WORKFLOW_BRIDGE_UNCERTAIN_LIMIT) {
      // Preserve bounded backpressure when too many acknowledgements are
      // uncertain. The session boundary still requeues this awaiting entry.
      console.warn("[workflow-delivery] uncertain acknowledgement ceiling reached; retaining in-flight fence");
      return;
    }
    bridge.awaitingAck.delete(delivery.id);
    clearWorkflowProviderTracking(bridge, delivery.id, generation);
    bridge.uncertainAck.set(delivery.id, { delivery: awaiting, generation });
    console.warn("[workflow-delivery] acknowledgement timed out; deferred until the next session generation");
    flushWorkflowBridge(bridge);
  }, timeoutMs);
  timer.unref?.();
  watchdog.timer = timer;
  bridge.ackWatchdogs.set(delivery.id, watchdog);
}

/** Pause acknowledgement deadlines while Pi owns the compaction stack. */
function pauseWorkflowAckWatchdogs(bridge: WorkflowBridge): void {
  const now = Date.now();
  for (const watchdog of bridge.ackWatchdogs.values()) {
    if (watchdog.timer) {
      watchdog.remainingMs = Math.max(1, watchdog.deadline - now);
      clearTimeout(watchdog.timer);
      watchdog.timer = undefined;
    }
  }
}

/** Resume deadlines captured by pauseWorkflowAckWatchdogs(). */
function resumeWorkflowAckWatchdogs(bridge: WorkflowBridge): void {
  if (bridge.compacting || bridge.abortFence) return;
  const now = Date.now();
  for (const [deliveryId, watchdog] of [...bridge.ackWatchdogs.entries()]) {
    if (watchdog.timer) continue;
    const delivery = bridge.awaitingAck.get(deliveryId);
    if (!delivery || delivery.details?.deliveryGeneration !== watchdog.generation) {
      bridge.ackWatchdogs.delete(deliveryId);
      continue;
    }
    const remainingMs = watchdog.remainingMs ?? Math.max(1, watchdog.deadline - now);
    startWorkflowAckWatchdog(bridge, delivery, watchdog.generation, remainingMs);
  }
}

function queueWorkflowDelivery(bridge: WorkflowBridge, rawDelivery: WorkflowBridgeDelivery): void {
  if (rawDelivery.customType === "workflow-agent") return;
  const delivery = normalizedWorkflowDelivery(rawDelivery);
  if (
    bridge.delivered.has(delivery.id) ||
    bridge.awaitingAck.has(delivery.id) ||
    isUncertainInCurrentGeneration(bridge, delivery.id) ||
    bridge.pending.some((item) => item.id === delivery.id)
  )
    return;
  if (bridge.pending.length >= WORKFLOW_BRIDGE_QUEUE_LIMIT) {
    const terminals = bridge.pending.filter((item) => item.customType === "workflow-result");
    // Terminal lifecycle records are never shifted or folded into ordinary
    // text. Keep them all up to a finite bridge ceiling; the durable outbox is
    // the recovery path beyond it rather than silently discarding a terminal.
    if (delivery.customType === "workflow-result") {
      if (terminals.length >= WORKFLOW_BRIDGE_TERMINAL_LIMIT) {
        console.warn("[workflow-delivery] terminal bridge ceiling reached; terminal remains in durable outbox");
        return;
      }
      bridge.pending.push(delivery);
      return;
    }

    // Ordinary explicit records remain durable in the run outbox. Do not
    // coalesce them into a new, non-durable ID: that would replay the originals
    // after reload and create duplicate logical continuations. Leave this one
    // for replay once the current batch drains, while terminals stay queued.
    console.warn("[workflow-delivery] explicit bridge queue is full; retaining delivery in durable outbox");
    return;
  }
  bridge.pending.push(delivery);
}

function bridgeManager(bridge: WorkflowBridge): WorkflowManager {
  return bridge.manager;
}

function scheduleWorkflowDeliveryRetry(bridge: WorkflowBridge, deliveryId: string, generation: number): void {
  if (bridge.abortFence || bridge.retryingSendIds.has(deliveryId)) return;
  bridge.retryingSendIds.add(deliveryId);
  const timer = setTimeout(() => {
    if (bridge.generation === generation && !bridge.suspended && !bridge.compacting) flushWorkflowBridge(bridge);
    // Keep the fence through promise-rejection microtasks created by this
    // retry. An immediate second rejection therefore remains queued instead
    // of creating an unbounded zero-delay retry loop.
    queueMicrotask(() => bridge.retryingSendIds.delete(deliveryId));
  }, 0);
  timer.unref?.();
}

function requeueWorkflowDeliveryAfterPersistenceFailure(
  bridge: WorkflowBridge,
  item: { id: string; generation: number },
  phase: "projected" | "acknowledged",
): void {
  const awaiting = bridge.awaitingAck.get(item.id);
  if (awaiting?.details?.deliveryGeneration !== item.generation) return;
  clearWorkflowAckWatchdog(bridge, item.id, item.generation);
  bridge.awaitingAck.delete(item.id);
  clearWorkflowProviderTracking(bridge, item.id, item.generation);
  queueWorkflowDelivery(bridge, {
    ...awaiting,
    details: { ...awaiting.details, deliveryGeneration: undefined },
  });
  console.warn(`[workflow-delivery] durable ${phase} transition failed; queued for safe-point retry`);
  scheduleWorkflowDeliveryRetry(bridge, item.id, bridge.generation);
}

function sendWorkflowDeliveryNow(bridge: WorkflowBridge, rawDelivery: WorkflowBridgeDelivery): void {
  const delivery = normalizedWorkflowDelivery(rawDelivery);
  if (bridge.suspended || bridge.compacting || bridge.abortFence) {
    queueWorkflowDelivery(bridge, delivery);
    return;
  }
  if (
    bridge.delivered.has(delivery.id) ||
    bridge.awaitingAck.has(delivery.id) ||
    isUncertainInCurrentGeneration(bridge, delivery.id)
  )
    return;
  if (bridge.awaitingAck.size >= WORKFLOW_BRIDGE_IN_FLIGHT_LIMIT) {
    queueWorkflowDelivery(bridge, delivery);
    return;
  }
  const startedGeneration = bridge.generation;
  const durable = Boolean(delivery.details?.runId && delivery.details?.deliveryId);
  if (
    durable &&
    !persistDeliveryPhase(bridgeManager(bridge), delivery.details?.runId, delivery.id, startedGeneration, "submitted")
  ) {
    queueWorkflowDelivery(bridge, delivery);
    scheduleWorkflowDeliveryRetry(bridge, delivery.id, startedGeneration);
    return;
  }
  const submitted = {
    ...delivery,
    details: { ...delivery.details, deliveryGeneration: startedGeneration },
  };
  // A fulfilled send only means Pi admitted the custom message; it is not a
  // provider acknowledgement. Keep the payload until the context hook observes
  // it entering a provider-bound continuation.
  bridge.awaitingAck.set(delivery.id, submitted);
  startWorkflowAckWatchdog(bridge, submitted, startedGeneration);
  try {
    // All final reports and explicit parent deliveries use steer+triggerTurn.
    // Pi batches messages already present in the steering queue before the next
    // provider call; it does not abort the request that is currently streaming.
    // Routine progress/status UI events remain display-only outside this bridge.
    const sent = bridge.pi.sendMessage(
      {
        customType: delivery.customType,
        content: submitted.content,
        display: true,
        details: { ...submitted.details, deliveryId: submitted.id },
      },
      // Every provider-bound workflow delivery uses the safe-point steering
      // queue. `wake` controls only whether an idle main session starts a turn.
      { triggerTurn: delivery.wake, deliverAs: "steer" },
    );
    // Stock Pi exposes this as fire-and-forget (runtime value: void). Some
    // compatible hosts return a Promise, so observe that optional extension
    // without making the lifecycle depend on it.
    if (sent && typeof (sent as any).then === "function") {
      void Promise.resolve(sent).catch((err: unknown) => {
        const awaiting = bridge.awaitingAck.get(delivery.id);
        if (awaiting?.details?.deliveryGeneration !== startedGeneration) return;
        clearWorkflowAckWatchdog(bridge, delivery.id, startedGeneration);
        bridge.awaitingAck.delete(delivery.id);
        clearWorkflowProviderTracking(bridge, delivery.id, startedGeneration);
        queueWorkflowDelivery(bridge, delivery);
        console.warn(
          `[workflow-delivery] async send failed; queued for retry: ${err instanceof Error ? err.message : String(err)}`,
        );
        if (bridge.generation !== startedGeneration && !bridge.suspended) flushWorkflowBridge(bridge);
        else scheduleWorkflowDeliveryRetry(bridge, delivery.id, startedGeneration);
      });
    }
  } catch (err) {
    clearWorkflowAckWatchdog(bridge, delivery.id, startedGeneration);
    bridge.awaitingAck.delete(delivery.id);
    clearWorkflowProviderTracking(bridge, delivery.id, startedGeneration);
    queueWorkflowDelivery(bridge, delivery);
    console.warn(
      `[workflow-delivery] send failed; queued for retry: ${err instanceof Error ? err.message : String(err)}`,
    );
    scheduleWorkflowDeliveryRetry(bridge, delivery.id, startedGeneration);
  }
}

function requeueUnacknowledgedForNextGeneration(bridge: WorkflowBridge): void {
  for (const watchdog of bridge.ackWatchdogs.values()) {
    if (watchdog.timer) clearTimeout(watchdog.timer);
  }
  bridge.ackWatchdogs.clear();
  const unacknowledged = new Map<string, WorkflowBridgeDelivery>();
  for (const delivery of bridge.awaitingAck.values()) unacknowledged.set(delivery.id, delivery);
  for (const { delivery } of bridge.uncertainAck.values()) unacknowledged.set(delivery.id, delivery);
  bridge.awaitingAck.clear();
  bridge.uncertainAck.clear();
  bridge.includedInProviderRequest = [];
  bridge.projectedForNextRequest = [];
  for (const delivery of unacknowledged.values()) {
    queueWorkflowDelivery(bridge, {
      ...delivery,
      details: { ...delivery.details, deliveryGeneration: undefined },
    });
  }
}

function sendWorkflowDelivery(bridge: WorkflowBridge, delivery: WorkflowBridgeDelivery): void {
  // Automatic subagent completions remain available in the run journal, pager,
  // and persisted JSON. They are intentionally not injected into the parent
  // conversation: execution order does not identify which agent is the final
  // product, and forwarding every report creates unbounded context growth and
  // one-at-a-time turn storms. The workflow's explicit return value is the
  // semantic final product; explicit deliver() remains the urgent live channel.
  if (delivery.customType === "workflow-agent") return;
  sendWorkflowDeliveryNow(bridge, delivery);
}

/**
 * A user abort ends the current host turn. Do not let a rejected custom-message
 * promise, an ack timeout, or agent_settled turn that abort wake the model again.
 * Move only in-memory submissions back to the durable/pending path; the durable
 * outbox itself remains untouched and is therefore replayable after input or a
 * session replacement.
 */
function fenceWorkflowBridgeAfterAbort(bridge: WorkflowBridge): void {
  bridge.abortFence = true;
  bridge.retryingSendIds.clear();
  for (const watchdog of bridge.ackWatchdogs.values()) {
    if (watchdog.timer) clearTimeout(watchdog.timer);
  }
  bridge.ackWatchdogs.clear();

  const unacknowledged = new Map<string, WorkflowBridgeDelivery>();
  for (const delivery of bridge.awaitingAck.values()) unacknowledged.set(delivery.id, delivery);
  for (const { delivery } of bridge.uncertainAck.values()) unacknowledged.set(delivery.id, delivery);
  bridge.awaitingAck.clear();
  bridge.uncertainAck.clear();
  bridge.projectedForNextRequest = [];
  bridge.includedInProviderRequest = [];
  for (const delivery of unacknowledged.values()) {
    queueWorkflowDelivery(bridge, {
      ...delivery,
      details: { ...delivery.details, deliveryGeneration: undefined },
    });
  }
}

function flushWorkflowBridge(bridge: WorkflowBridge): void {
  if (bridge.suspended || bridge.compacting || bridge.abortFence) return;
  replayDurableOutbox(bridge.manager, bridge);
  if (bridge.pending.length === 0) return;
  const queued = bridge.pending.splice(0, bridge.pending.length);
  // One batch selects at most one idle-session wake. Prefer the terminal record
  // so ordinary explicit messages cannot consume or obscure the terminal wake.
  const wakeIndex = queued.findIndex((item) => item.wake && item.customType === "workflow-result");
  const selectedWake = wakeIndex >= 0 ? wakeIndex : queued.findIndex((item) => item.wake);
  for (let index = 0; index < queued.length; index++) {
    const delivery = queued[index];
    if (delivery.customType !== "workflow-agent") {
      sendWorkflowDeliveryNow(bridge, index === selectedWake ? delivery : { ...delivery, wake: false });
    }
  }
  // Queue-full records were intentionally left only in the durable outbox.
  // Refill bridge capacity after the batch drains; a later safe-point flush
  // submits them without requiring a session reload.
  replayDurableOutbox(bridge.manager, bridge);
}

function suspendWorkflowBridge(manager: WorkflowManager): void {
  const bridge = bridgeFor(manager);
  if (!bridge) return;
  bridge.suspended = true;
  // Pi aborts the outgoing session before session_shutdown. Any unacknowledged
  // submission is uncertain and must be retried by the next generation with the
  // same stable ID but a NEW deliveryGeneration. Clear provider-tracking batches
  // so late old-session hooks cannot acknowledge the resend.
  requeueUnacknowledgedForNextGeneration(bridge);
}

function replayDurableOutbox(manager: WorkflowManager, bridge: WorkflowBridge): void {
  if (typeof manager.listPendingDeliveries !== "function") return;
  for (const record of manager.listPendingDeliveries()) {
    if (
      bridge.delivered.has(record.deliveryId) ||
      bridge.awaitingAck.has(record.deliveryId) ||
      isUncertainInCurrentGeneration(bridge, record.deliveryId) ||
      bridge.pending.some((item) => item.id === record.deliveryId)
    )
      continue;
    const live = manager.getRun(record.runId);
    const content =
      record.content ??
      (live
        ? live.status === "completed"
          ? `✓ Background workflow "${record.workflowName}" finished.\n\n↳ Full result and subagent reports: ${manager.getPersistence().getRunsDir()}/${record.runId}.json`
          : `✗ Background workflow ${record.runId} ${record.runStatus}.\n\n↳ Full result and subagent reports: ${manager.getPersistence().getRunsDir()}/${record.runId}.json`
        : `Background workflow ${record.runId} ${record.runStatus}; inspect the durable run record for the complete result.`);
    queueWorkflowDelivery(bridge, {
      id: record.deliveryId,
      customType: record.kind === "terminal" ? "workflow-result" : "workflow-deliver",
      content,
      details: {
        notificationKind: record.kind === "terminal" ? "workflow-result" : "workflow-message",
        runId: record.runId,
        alertKind: record.alertKind,
        sequence: record.sequence,
        deliveryId: record.deliveryId,
        status: record.kind === "terminal" ? (record.runStatus === "failed" ? "failed" : "completed") : undefined,
      },
      wake: true,
    });
  }
}

function resumeWorkflowBridge(manager: WorkflowManager): void {
  const bridge = bridgeFor(manager);
  if (!bridge) return;
  replayDurableOutbox(manager, bridge);
  bridge.suspended = false;
  flushWorkflowBridge(bridge);
}

function releaseCompactionFence(bridge: WorkflowBridge, generation: number): void {
  if (bridge.compactionGeneration !== generation || !bridge.compacting) return;
  bridge.compacting = false;
  resumeWorkflowAckWatchdogs(bridge);
  flushWorkflowBridge(bridge);
}

/**
 * Pi's custom-message API historically allowed an idle triggerTurn delivery to
 * start a provider run while manual compaction still owned the session. Keep
 * workflow outbox records outside Pi until the host reaches a safe boundary:
 * manual compaction releases after session_compact returns; threshold/overflow
 * compaction releases only at agent_settled, after retries and queued turns.
 */
function installWorkflowCompactionFence(pi: ExtensionAPI, getManager: () => WorkflowManager): void {
  pi.on("session_before_compact", (event) => {
    const bridge = bridgeFor(getManager());
    if (!bridge) return;
    bridge.compacting = true;
    pauseWorkflowAckWatchdogs(bridge);
    const generation = ++bridge.compactionGeneration;
    let releaseScheduled = false;
    const scheduleRelease = () => {
      if (releaseScheduled) return;
      releaseScheduled = true;
      // Abort listeners run inside Pi's compaction stack. Defer the wake so
      // the host can clear its compaction controller before any provider run.
      setTimeout(() => releaseCompactionFence(bridge, generation), 0);
    };
    event.signal.addEventListener("abort", scheduleRelease, { once: true });
    if (event.signal.aborted) scheduleRelease();
  });

  pi.on("session_compact", (event) => {
    if (event.reason !== "manual") return;
    const bridge = bridgeFor(getManager());
    if (!bridge) return;
    const generation = bridge.compactionGeneration;
    // session_compact fires before AgentSession clears its manual-compaction
    // controller. A macrotask is the first safe opportunity to wake the host.
    setTimeout(() => releaseCompactionFence(bridge, generation), 0);
  });

  pi.on("agent_settled", () => {
    const bridge = bridgeFor(getManager());
    if (!bridge) return;
    if (bridge.compacting) releaseCompactionFence(bridge, bridge.compactionGeneration);
    else flushWorkflowBridge(bridge);
  });
}

function installWorkflowAbortFence(pi: ExtensionAPI, getManager: () => WorkflowManager): void {
  // agent_end is the stock Pi lifecycle boundary that carries the final
  // assistant stopReason. It is preferable to guessing from a rejected
  // sendMessage promise, which can also represent a transient host race.
  pi.on("agent_end", (event) => {
    const bridge = bridgeFor(getManager());
    if (!bridge) return;
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const lastAssistant = [...messages].reverse().find((message: any) => message?.role === "assistant");
    if (lastAssistant?.stopReason === "aborted") fenceWorkflowBridgeAfterAbort(bridge);
  });

  // A real user prompt is the explicit release point. Do not flush here: the
  // host is still assembling that prompt, and sendMessage(triggerTurn) would
  // otherwise create a second overlapping turn. The normal settled safe point
  // flushes the durable/pending records after the user's turn.
  pi.on("before_agent_start", (event) => {
    const bridge = bridgeFor(getManager());
    if (!bridge?.abortFence) return;
    if (typeof event.prompt === "string" && event.prompt.trim().length > 0) bridge.abortFence = false;
  });
}

function deliverWorkflowResult(manager: WorkflowManager, payload: WorkflowDeliveryPayload): void {
  const bridge = bridgeFor(manager);
  if (!bridge) return;
  const sequence = payload.details?.sequence ?? bridge.nextEventSeq++;
  sendWorkflowDelivery(bridge, {
    id:
      payload.details?.deliveryId ??
      hashDeliveryId(
        `result:${payload.details?.runId ?? "unknown"}:${payload.details?.status ?? "completed"}:${payload.content}`,
      ),
    customType: "workflow-result",
    content: payload.content,
    details: { ...payload.details, notificationKind: "workflow-result", sequence },
    wake: true,
  });
}

function bindDeliverBridge(manager: WorkflowManager, pi: ExtensionAPI): void {
  const target = manager as ManagerWithWorkflowBridge;
  const bridge =
    target.__workflowBridge ??
    ({
      manager,
      pi,
      // The extension factory runs before bindCore. Do not call the old pi
      // during that window; session_start explicitly resumes this generation.
      suspended: true,
      compacting: false,
      compactionGeneration: 0,
      generation: 0,
      nextEventSeq: 0,
      pending: [],
      delivered: new Set<string>(),
      awaitingAck: new Map<string, WorkflowBridgeDelivery>(),
      uncertainAck: new Map<string, WorkflowBridgeUncertainDelivery>(),
      ackWatchdogs: new Map<string, WorkflowBridgeAckWatchdog>(),
      projectedForNextRequest: [],
      includedInProviderRequest: [],
      retryingSendIds: new Set<string>(),
      abortFence: false,
    } satisfies WorkflowBridge);
  // Backfill fields when handing off a manager created by an older extension
  // generation that predates batching support.
  bridge.awaitingAck ??= new Map<string, WorkflowBridgeDelivery>();
  bridge.uncertainAck ??= new Map<string, WorkflowBridgeUncertainDelivery>();
  bridge.ackWatchdogs ??= new Map<string, WorkflowBridgeAckWatchdog>();
  bridge.projectedForNextRequest ??= [];
  bridge.includedInProviderRequest ??= [];
  bridge.retryingSendIds ??= new Set<string>();
  bridge.abortFence ??= false;
  bridge.retryingSendIds.clear();
  requeueUnacknowledgedForNextGeneration(bridge);
  bridge.compacting = false;
  bridge.compactionGeneration = (bridge.compactionGeneration ?? 0) + 1;
  // Handoff from the short-lived batching implementation: cancel and discard
  // retained automatic reports so no stale timer can bypass the new default.
  const legacy = bridge as WorkflowBridge & {
    pendingAgentReports?: Map<string, WorkflowBridgeDelivery[]>;
    agentReportTimers?: Map<string, ReturnType<typeof setTimeout>>;
  };
  if (legacy.agentReportTimers) {
    for (const timer of legacy.agentReportTimers.values()) clearTimeout(timer);
    legacy.agentReportTimers.clear();
  }
  legacy.pendingAgentReports?.clear();
  bridge.pending = bridge.pending.filter((delivery) => delivery.customType !== "workflow-agent");
  for (const [id, delivery] of bridge.awaitingAck) {
    if (delivery.customType === "workflow-agent") bridge.awaitingAck.delete(id);
  }
  bridge.projectedForNextRequest = bridge.projectedForNextRequest.filter(({ id }) => bridge.awaitingAck.has(id));
  bridge.manager = manager;
  bridge.pi = pi;
  bridge.generation += 1;
  bridge.suspended = true;
  target.__workflowBridge = bridge;

  manager.onDeliver = (message, source) => {
    const content = typeof message === "string" ? message : String(message ?? "");
    const sequence = bridge.nextEventSeq++;
    sendWorkflowDelivery(bridge, {
      id: source?.deliveryId ?? hashDeliveryId(`deliver:${source?.runId ?? "unknown"}:${sequence}:${content}`),
      customType: "workflow-deliver",
      content,
      details: {
        notificationKind: "workflow-message",
        runId: source?.runId,
        alertKind: source?.alertKind,
        sequence: source?.sequence ?? sequence,
        deliveryId: source?.deliveryId,
      },
      // Explicit child→parent deliveries are important and wake the parent.
      wake: true,
    });
  };
  // Automatic subagent finals are intentionally persistence/UI-only. A workflow
  // author who needs the parent to react before terminal completion uses the
  // explicit deliver()/workflow_alert_parent channel. This avoids assuming
  // the last completed agent is a summary and prevents N automatic reports from
  // consuming N provider continuations. Keep the callback assigned (rather than
  // leaving an older generation's function installed) but make it side-effect free.
  manager.onAgentMessage = () => {};
}

/**
 * Convert workflow custom messages only in the provider-bound context copy.
 * The session history remains role=custom for TUI rendering and persistence,
 * while the provider receives a valid assistant tool-call + tool-result pair.
 * This mirrors Claude Code's background-task completion semantics without
 * presenting the workflow payload as a user-authored text message.
 */
function cloneContextMessage(message: any): any {
  if (!message || typeof message !== "object") return message;
  const clone = { ...message };
  if (Array.isArray(message.content)) {
    clone.content = message.content.map((block: any) => {
      if (!block || typeof block !== "object") return block;
      const blockClone = { ...block };
      if (block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments)) {
        blockClone.arguments = { ...block.arguments };
      }
      return blockClone;
    });
  }
  return clone;
}

function workflowSummaryAssistantMessage(message: any): any | undefined {
  if (!message || typeof message !== "object") return undefined;
  const customType = message.customType;
  if (typeof customType !== "string" || !PROVIDER_WORKFLOW_CUSTOM_TYPES.has(customType)) return undefined;
  const text = customMessageText(message.content) || "(empty workflow delivery)";
  const details = message.details as { isError?: unknown; status?: unknown } | undefined;
  const suffix = details?.isError === true ? " [error]" : "";
  return {
    role: "assistant",
    content: [{ type: "text", text: `[Workflow ${customType}${suffix}]\n${text}` }],
    timestamp: message.timestamp ?? Date.now(),
  };
}

function sanitizeSummaryMessages(messages: unknown): any[] {
  if (!Array.isArray(messages)) return [];
  const output: any[] = [];
  for (const message of messages) {
    if (message?.role === "custom") {
      const safe = workflowSummaryAssistantMessage(message);
      if (safe) output.push(safe);
      // Non-workflow custom/control messages are display metadata, not
      // conversation content; omit them rather than letting Pi convert them to
      // role=user inside the summarizer.
      continue;
    }
    output.push(cloneContextMessage(message));
  }
  return output;
}

function sanitizeBranchSummaryEntries(entries: unknown): any[] {
  if (!Array.isArray(entries)) return [];
  const output: any[] = [];
  for (const entry of entries) {
    if (entry?.type === "custom_message") {
      const safe = workflowSummaryAssistantMessage({
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        details: entry.details,
        timestamp: entry.timestamp,
      });
      if (safe) output.push({ ...entry, type: "message", message: safe });
      continue;
    }
    if (entry?.type === "message" && entry.message?.role === "custom") {
      const safe = workflowSummaryAssistantMessage(entry.message);
      if (safe) output.push({ ...entry, message: safe });
      continue;
    }
    output.push(entry);
  }
  return output;
}

function installWorkflowSummaryBridge(pi: ExtensionAPI): void {
  pi.on("session_before_compact", (event) => {
    const preparation = event.preparation as any;
    if (Array.isArray(preparation?.messagesToSummarize)) {
      preparation.messagesToSummarize = sanitizeSummaryMessages(preparation.messagesToSummarize);
    }
    if (Array.isArray(preparation?.turnPrefixMessages)) {
      preparation.turnPrefixMessages = sanitizeSummaryMessages(preparation.turnPrefixMessages);
    }
  });
  pi.on("session_before_tree", (event) => {
    const entries = event.preparation?.entriesToSummarize as any;
    if (!Array.isArray(entries)) return;
    const safe = sanitizeBranchSummaryEntries(entries);
    // The host retains a local reference to this array after emitting the hook;
    // mutate in place so the sanitized projection is what the summarizer sees.
    entries.splice(0, entries.length, ...safe);
  });
}

function providerWorkflowDeliveryText(customType: string, text: string): string {
  switch (customType) {
    case "workflow-result":
      return `[workflow result; newer user input has priority]\n${text}`;
    case "workflow-deliver":
      return `[workflow message for its identified run; not user input]\n${text}`;
    default:
      return text;
  }
}

function workflowNotificationToolName(customType: string): string {
  if (customType === "workflow-result") return "workflow_result_notification";
  return "workflow_message_notification";
}

function installWorkflowToolResultContextBridge(pi: ExtensionAPI, getManager: () => WorkflowManager): void {
  pi.on("context", (event) => {
    const output: any[] = [];
    const sourceMessages = event.messages as any[];
    for (let messageIndex = 0; messageIndex < sourceMessages.length; messageIndex++) {
      const message = sourceMessages[messageIndex];
      if (!message || !WORKFLOW_CUSTOM_TYPES.has(message.role === "custom" ? message.customType : "")) {
        // The bridge appends synthetic tool calls to the previous assistant copy.
        // Never retain a reference into the session history: repeated context
        // events must not accumulate tool calls or corrupt persisted messages.
        output.push(cloneContextMessage(message));
        continue;
      }

      // Legacy automatic-agent custom messages are display/persistence metadata,
      // not a reason to spend provider context. Drop them from the projection.
      if (message.customType === "workflow-agent") continue;

      const rawText = customMessageText(message.content) || "(empty workflow delivery)";
      const text = boundedWorkflowContent(providerWorkflowDeliveryText(message.customType, rawText));
      const sourceDetails = (
        message.details && typeof message.details === "object" ? message.details : {}
      ) as WorkflowDeliveryDetails;
      const boundedDetail = (value: unknown, bytes: number): string | undefined =>
        typeof value === "string" ? truncateUtf8(value, bytes, "…") : undefined;
      const details: WorkflowDeliveryDetails = {
        notificationKind: boundedDetail(
          sourceDetails.notificationKind,
          64,
        ) as WorkflowDeliveryDetails["notificationKind"],
        status: boundedDetail(sourceDetails.status, 32) as WorkflowDeliveryDetails["status"],
        alertKind: boundedDetail(sourceDetails.alertKind, 32) as WorkflowDeliveryDetails["alertKind"],
        runId: boundedDetail(sourceDetails.runId, 256),
        agentId: boundedDetail(sourceDetails.agentId, 256),
        label: boundedDetail(sourceDetails.label, 512),
        deliveryId: boundedDetail(sourceDetails.deliveryId, 256),
        deliveryGeneration: Number.isSafeInteger(sourceDetails.deliveryGeneration)
          ? sourceDetails.deliveryGeneration
          : undefined,
        sequence: Number.isSafeInteger(sourceDetails.sequence) ? sourceDetails.sequence : undefined,
      };
      // Bridge-originated notifications carry a stable delivery ID across
      // generation retries. Legacy persisted messages fall back to a stable
      // content/timestamp/index digest.
      const toolCallId =
        details.deliveryId ??
        hashDeliveryId(
          `${message.customType}:${typeof message.timestamp === "number" ? message.timestamp : ""}:${messageIndex}:${rawText}`,
        );
      // Context projection is not yet provider acceptance. Record the stable ID
      // and submission generation; before_provider_request promotes this exact
      // batch, and after_provider_response acknowledges only a successful HTTP
      // response for that request. This fences late old-session context events
      // from acknowledging a newer generation's resend.
      if (details.deliveryId && typeof details.deliveryGeneration === "number") {
        const bridge = bridgeFor(getManager());
        const uncertain = bridge?.uncertainAck.get(details.deliveryId);
        if (
          bridge &&
          !bridge.awaitingAck.has(details.deliveryId) &&
          uncertain?.generation === details.deliveryGeneration &&
          uncertain.delivery.details?.deliveryGeneration === details.deliveryGeneration
        ) {
          // The same persisted custom message has re-entered provider context.
          // Resume acknowledgement tracking without calling sendMessage again;
          // this avoids duplicate wake turns after a slow or failed request.
          bridge.uncertainAck.delete(details.deliveryId);
          bridge.awaitingAck.set(details.deliveryId, uncertain.delivery);
          startWorkflowAckWatchdog(bridge, uncertain.delivery, details.deliveryGeneration);
        }
        const awaiting = bridge?.awaitingAck.get(details.deliveryId);
        if (
          bridge &&
          awaiting?.details?.deliveryGeneration === details.deliveryGeneration &&
          !bridge.projectedForNextRequest.some(
            (item) => item.id === details.deliveryId && item.generation === details.deliveryGeneration,
          )
        ) {
          bridge.projectedForNextRequest.push({ id: details.deliveryId, generation: details.deliveryGeneration });
        }
      }
      const toolName = workflowNotificationToolName(message.customType);
      const toolCall = {
        type: "toolCall",
        id: toolCallId,
        name: toolName,
        arguments: {
          origin: "task-notification",
          notificationKind: details.notificationKind ?? message.customType,
          customType: message.customType,
          status: details.status ?? null,
          alertKind: details.alertKind ?? null,
          runId: details.runId ?? null,
          agentId: details.agentId ?? null,
          label: details.label ?? null,
          sequence: details.sequence ?? null,
        },
      };

      // Anthropic requires tool results to follow an assistant tool-use. Merge
      // into an existing assistant message when possible to avoid consecutive
      // assistant messages in histories that end with an assistant response.
      const previous = output[output.length - 1];
      const canExtendAssistant =
        previous?.role === "assistant" &&
        previous.stopReason !== "error" &&
        previous.stopReason !== "aborted" &&
        Array.isArray(previous.content);
      if (canExtendAssistant) {
        previous.content = [...previous.content, toolCall];
      } else {
        output.push({
          role: "assistant",
          content: [toolCall],
          api: "workflow-delivery",
          provider: "workflow",
          model: "workflow-delivery",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "toolUse",
          timestamp: message.timestamp ?? Date.now(),
        });
      }
      output.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text }],
        isError: (message.details as { isError?: unknown } | undefined)?.isError === true,
        timestamp: message.timestamp ?? Date.now(),
      });
    }
    return { messages: output };
  });

  pi.on("before_provider_request", () => {
    const bridge = bridgeFor(getManager());
    if (!bridge || bridge.projectedForNextRequest.length === 0) return;
    const batch = bridge.projectedForNextRequest.splice(0, bridge.projectedForNextRequest.length);
    let deferredRetry = false;
    // before_provider_request acknowledges inclusion only. Keep each stable ID
    // until after_provider_response so a failed/uncertain transport retries it.
    for (const item of batch) {
      const awaiting = bridge.awaitingAck.get(item.id);
      if (awaiting?.details?.deliveryGeneration !== item.generation) continue;
      const durable = Boolean(awaiting.details?.runId && awaiting.details?.deliveryId);
      if (
        durable &&
        !persistDeliveryPhase(bridge.manager, awaiting.details?.runId, item.id, item.generation, "projected")
      ) {
        requeueWorkflowDeliveryAfterPersistenceFailure(bridge, item, "projected");
        deferredRetry = true;
        continue;
      }
      if (
        !bridge.includedInProviderRequest.some(
          (included) => included.id === item.id && included.generation === item.generation,
        )
      ) {
        bridge.includedInProviderRequest.push(item);
      }
      bridge.pending = bridge.pending.filter((delivery) => delivery.id !== item.id);
    }
    if (!deferredRetry) flushWorkflowBridge(bridge);
  });
  pi.on("after_provider_response", (event) => {
    const bridge = bridgeFor(getManager());
    if (!bridge || bridge.includedInProviderRequest.length === 0) return;
    const successfulResponse = Number.isInteger(event.status) && event.status >= 200 && event.status < 300;
    if (!successfulResponse) {
      // Some providers report each HTTP retry attempt. Keep the original
      // request association intact across 429/5xx responses: a later 2xx can
      // acknowledge it, while agent_settled cannot create a duplicate wake.
      // A final transport failure remains bounded by the acknowledgement
      // watchdog and can be re-observed from the persisted custom message on a
      // later real user turn without another sendMessage call.
      return;
    }
    const included = bridge.includedInProviderRequest.splice(0, bridge.includedInProviderRequest.length);
    let deferredRetry = false;
    for (const item of included) {
      const awaiting = bridge.awaitingAck.get(item.id);
      if (awaiting?.details?.deliveryGeneration !== item.generation) continue;
      const durable = Boolean(awaiting.details?.runId && awaiting.details?.deliveryId);
      if (
        durable &&
        !persistDeliveryPhase(bridge.manager, awaiting.details?.runId, item.id, item.generation, "acknowledged")
      ) {
        requeueWorkflowDeliveryAfterPersistenceFailure(bridge, item, "acknowledged");
        deferredRetry = true;
        continue;
      }
      bridge.awaitingAck.delete(item.id);
      clearWorkflowAckWatchdog(bridge, item.id, item.generation);
      rememberDelivery(bridge, item.id);
    }
    if (!deferredRetry) flushWorkflowBridge(bridge);
  });
}

export default function extension(pi: ExtensionAPI) {
  // Mutable host state. Tools/commands resolve through getters so a
  // session_start that discovers a cross-project cwd can replace the manager
  // without leaving closed-over references pointing at the source project.
  //
  // Factory-time cwd is process.cwd() only (Pi does not pass the host session
  // cwd into the factory). The real session cwd arrives on session_start as
  // ctx.cwd; if it differs we rebuild manager/storage against it and pause
  // any foreign live runs that rode in via handoff.
  let cwd = resolve(process.cwd());
  let storage = createWorkflowStorage(cwd);
  let managerOptions = buildManagerOptions(cwd, storage);

  // Process-wide handoff slot (not cwd-keyed): the previous generation may have
  // been bound to ctx.cwd while this factory only sees process.cwd(). Claim
  // whatever is staged; session_start then keeps or rebuilds based on the true
  // session project (manager.getCwd() vs ctx.cwd).
  const runtimeClaim = claimWorkflowRuntime();
  const previousRuntime = runtimeClaim.compatible;
  let pausedForMismatch = runtimeClaim.versionMismatch ? pauseStrandedWorkflowRuntime(runtimeClaim.versionMismatch) : 0;

  // Prefer the claimed manager's own project path for construction defaults
  // when it already points at a real project (not just the launch dir).
  if (previousRuntime) {
    const claimedCwd = resolve(previousRuntime.manager.getCwd());
    if (!sameWorkflowPath(claimedCwd, cwd)) {
      cwd = claimedCwd;
      storage = createWorkflowStorage(cwd);
      managerOptions = buildManagerOptions(cwd, storage);
    }
  }

  let manager = previousRuntime?.manager ?? new WorkflowManager({ cwd, ...managerOptions });
  if (previousRuntime) manager.reconfigureAfterReload(managerOptions);

  // Stable effort object: /effort and keyword arming close over this reference.
  // When a handoff brings a different EffortState, copy the level in place
  // rather than rebinding the local binding.
  const effort: EffortState = (previousRuntime ?? runtimeClaim.versionMismatch)?.effort ?? createEffortState();
  if (previousRuntime?.effort && previousRuntime.effort !== effort) {
    effort.level = previousRuntime.effort.level;
  }

  const getManager = () => manager;
  const getCwd = () => cwd;
  const getStorage = () => storage;

  // Install delivery listeners once. Keep suspended until session_start —
  // factory runs before Pi bindCore(), so sendMessage is still the
  // "runtime not initialized" stub. Flushing here would re-queue forever.
  // The extension's richer task-notification context bridge is installed below;
  // disable task-panel's standalone minimal bridge to avoid double conversion.
  installResultDelivery(pi, manager, {
    loadSettings: () => loadWorkflowSettings({ cwd: getCwd() }),
    installContextBridge: false,
    sendResult: (payload) => deliverWorkflowResult(manager, payload),
  });
  suspendResultDelivery(manager);
  bindDeliverBridge(manager, pi);
  installWorkflowCompactionFence(pi, getManager);
  installWorkflowAbortFence(pi, getManager);

  const workflowTool = createWorkflowTool({
    getManager,
    getCwd,
    getStorage,
    get manager() {
      return manager;
    },
    get cwd() {
      return cwd;
    },
    get storage() {
      return storage;
    },
    // The public Pi surface starts fresh work only. Existing-run lifecycle and
    // steering are explicit /workflows commands, so a new request cannot be
    // silently attached to an old workflow by a model tool call.
    allowResume: false,
    // Keep policy knobs (limits/replay) in the library API, not in the
    // provider-visible Pi schema. Existing-run lifecycle is explicit below.
    exposeAdvancedParameters: false,
    modelFacing: true,
  });
  pi.registerTool(workflowTool);
  registerWorkflowMessageRenderers(pi);
  // Keep workflow history as custom entries for the UI, but expose it to the
  // provider as tool_result semantics through the context transform.
  installWorkflowToolResultContextBridge(pi, getManager);
  // Pi's compaction/tree summarizers call raw convertToLlm() and do not emit
  // the normal context hook. Sanitize workflow custom messages in their mutable
  // preparation arrays so they cannot become ordinary role=user content.
  installWorkflowSummaryBridge(pi);

  let usageLimitScheduler = new UsageLimitScheduler(manager);

  pi.on("session_shutdown", (event?: { reason?: string; targetSessionFile?: string }) => {
    usageLimitScheduler.dispose();
    // Always stop live sends first so a completion racing teardown cannot
    // deliver into the outgoing session (or throw on a just-stale ctx and be
    // lost). Replacement reasons stage the runtime for the next generation
    // only when the destination is the same project; quit/unknown/cross-project
    // pause in-flight runs onto the journal path.
    suspendResultDelivery(manager);
    suspendWorkflowBridge(manager);

    const reason = event?.reason;
    const runtime: WorkflowReloadRuntime = {
      cwd,
      extensionVersion: WORKFLOW_EXTENSION_VERSION,
      manager,
      effort,
    };

    if (reason && SESSION_REPLACEMENT_REASONS.has(reason)) {
      // Destination checks differ by reason:
      // - resume: fail-closed. Only hand off when the target session header
      //   positively reads as this same project. Missing/corrupt/unreadable
      //   headers must not smuggle a source-project manager across.
      // - fork: Pi forks stay in the same project; the new session file may
      //   not exist yet so a missing header is not a cross-project signal.
      //   Only refuse when we positively read a different cwd.
      // - reload/new: same project; always hand off.
      if (reason === "resume") {
        const targetCwd = sessionFileCwd(event?.targetSessionFile);
        if (!sameWorkflowPath(targetCwd, cwd)) {
          pauseStrandedWorkflowRuntime(runtime);
          discardWorkflowRuntime(cwd, runtime);
          return;
        }
        handoffWorkflowRuntime(runtime);
        return;
      }
      if (reason === "fork") {
        const targetCwd = sessionFileCwd(event?.targetSessionFile);
        if (targetCwd && !sameWorkflowPath(targetCwd, cwd)) {
          pauseStrandedWorkflowRuntime(runtime);
          discardWorkflowRuntime(cwd, runtime);
          return;
        }
        handoffWorkflowRuntime(runtime);
        return;
      }
      handoffWorkflowRuntime(runtime);
      return;
    }

    pauseStrandedWorkflowRuntime(runtime);
    discardWorkflowRuntime(cwd, runtime);
  });

  registerWorkflowCommands(pi, getManager, {
    getStorage,
    getCwd,
    effort,
  });
  registerWorkflowModelsCommand(pi);
  registerBuiltinWorkflows(pi, { getManager, getCwd, getStorage });
  // Saved project commands are registered on session_start (after the real
  // ctx.cwd is known and any cross-project rebuild has finished). Registering
  // them in the factory would stamp source-project descriptions onto slash
  // commands before a resume into another project could correct the cwd —
  // and Pi cannot unregister/replace a command's metadata once registered.
  registerEffortCommand(pi, effort);

  let armingInstalled = false;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    // True project cwd for this session. Pi keeps process.cwd() on the
    // launching directory across /resume into another project; ctx.cwd is
    // the session header's project path.
    const sessionCwd = resolve(ctx.cwd || process.cwd());

    if (!sameWorkflowPath(sessionCwd, manager.getCwd())) {
      // Cross-project: the live manager is for the wrong tree. Pause anything
      // still on it, then rebuild against the real session project.
      const stranded: WorkflowReloadRuntime = {
        cwd: manager.getCwd(),
        extensionVersion: WORKFLOW_EXTENSION_VERSION,
        manager,
        effort,
      };
      const n = pauseStrandedWorkflowRuntime(stranded);
      if (n > 0) pausedForMismatch += n;

      cwd = sessionCwd;
      storage = createWorkflowStorage(cwd);
      managerOptions = buildManagerOptions(cwd, storage);
      manager = new WorkflowManager({ cwd, ...managerOptions });
      installResultDelivery(pi, manager, {
        loadSettings: () => loadWorkflowSettings({ cwd: getCwd() }),
        installContextBridge: false,
        sendResult: (payload) => deliverWorkflowResult(manager, payload),
      });
      bindDeliverBridge(manager, pi);
      usageLimitScheduler.dispose();
      usageLimitScheduler = new UsageLimitScheduler(manager);
    } else if (!sameWorkflowPath(cwd, sessionCwd)) {
      // Manager already owns the session project; just align the local cwd/storage.
      cwd = sessionCwd;
      storage = createWorkflowStorage(cwd);
      managerOptions = buildManagerOptions(cwd, storage);
      manager.reconfigureAfterReload(managerOptions);
    }

    // First registration (and post-rebuild catch-up for target-only names).
    // Handlers load by name from the live storage, so a later same-session
    // overwrite picks up the new script; Pi still cannot drop source-only
    // names left over from a prior generation — those handlers notify.
    registerAllSavedWorkflows(pi, getCwd, getStorage, getManager);

    if (pausedForMismatch > 0) {
      ctx.ui.notify(
        `Paused ${pausedForMismatch} active workflow(s) that could not safely continue in this session (extension update or project switch). Resume them from /workflows when ready.`,
        "warning",
      );
      pausedForMismatch = 0;
    }

    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    manager.setModelRegistry(ctx.modelRegistry);

    // Bind + adopt before resuming delivery so a flushed completion is tagged
    // with this session and visible in its panel.
    let sessionId: string | undefined;
    try {
      sessionId = ctx.sessionManager?.getSessionId();
    } catch {
      // sessionManager may be unavailable — fall back to global history.
    }
    manager.setSessionId(sessionId);
    manager.adoptLiveRunsToSession(sessionId);
    usageLimitScheduler.bindSession(sessionId);

    // Runtime is bound now (session_start fires after bindCore). Unsuspend and
    // flush anything queued while the previous ctx was dying or this factory
    // was still loading.
    resumeResultDelivery(manager);
    resumeWorkflowBridge(manager);

    installTaskPanel(pi, manager, ctx.ui, {
      storage,
      cwd,
      loadSettings: () => loadWorkflowSettings({ cwd: getCwd() }),
    });
    if (!armingInstalled) {
      installWorkflowKeywordArming(pi, effort, {
        settingsStore: {
          load: () => loadWorkflowSettings({ cwd: getCwd() }),
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, getCwd()),
        },
      });
      armingInstalled = true;
    }
  });
}
