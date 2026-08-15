import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createCodingTools, defineTool, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
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
  createWorkflowControlTool,
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
  WorkflowManager,
} from "../src/index.js";
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
      "web-research": () => [...createCodingTools(cwd), ...createWebTools()],
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
 * Bridge workflow messages into this session's conversation. Script delivery
 * and automatic subagent results participate in LLM context and appear in the TUI.
 * deliverAs "steer" lands at the next safe point of an active turn, after its
 * current tool-call batch. triggerTurn wakes an idle main session immediately,
 * so subagent messages behave like asynchronous tool results instead of waiting
 * for another user prompt. Re-bound on every generation/manager rebuild because
 * `pi` is generation-bound.
 */
const COLLAPSED_MESSAGE_LINES = 8;
const COLLAPSED_MESSAGE_CHARS = 1_200;

function customMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content
    .filter((part): part is { type: "text"; text: string } => {
      if (!part || typeof part !== "object") return false;
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((part) => part.text)
    .join("\n");
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

/** Display-only folding: the full custom-message content remains in LLM context. */
function registerWorkflowMessageRenderers(pi: ExtensionAPI): void {
  for (const customType of ["workflow-agent", "workflow-deliver", "workflow-result"] as const) {
    pi.registerMessageRenderer(customType, (message, { expanded, outputPad }, theme) => {
      const full = customMessageText(message.content);
      const preview = expanded ? { text: full, omitted: false } : collapsedMessageText(full);
      const box = new Box(Math.max(0, outputPad), 1, (text) => theme.bg("customMessageBg", text));
      box.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[${customType}]`)), 0, 0));
      box.addChild(new Spacer(1));
      box.addChild(new Markdown(preview.text, 0, 0, getMarkdownTheme(), {
        color: (text) => theme.fg("customMessageText", text),
      }));
      if (preview.omitted) {
        box.addChild(new Spacer(1));
        box.addChild(new Text(theme.fg("dim", "… message folded; expand tool output to view the full delivery"), 0, 0));
      }
      return box;
    });
  }

  // Compatibility renderer for durable/display-only workflow-agent entries.
  // Live final reports use custom messages so they can join the provider-bound
  // workflow batch; appendEntry callers remain visible without entering context.
  pi.registerEntryRenderer("workflow-agent", (entry, { expanded }, theme) => {
    const data = entry.data && typeof entry.data === "object" ? (entry.data as Record<string, unknown>) : {};
    const label = typeof data.label === "string" && data.label ? ` ${data.label}` : "";
    const text = typeof data.text === "string" ? data.text : customMessageText(data.text);
    const full = `${label ? `[${label.trim()}]\n` : ""}${text}`;
    const preview = expanded ? { text: full, omitted: false } : collapsedMessageText(full);
    const box = new Box(0, 1, (value) => theme.bg("customMessageBg", value));
    box.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[workflow-agent]")), 0, 0));
    box.addChild(new Spacer(1));
    box.addChild(new Markdown(preview.text, 0, 0, getMarkdownTheme(), {
      color: (value) => theme.fg("customMessageText", value),
    }));
    if (preview.omitted) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg("dim", "… message folded; expand tool output to view the full result"), 0, 0));
    }
    return box;
  });
}

const WORKFLOW_CUSTOM_TYPES = new Set(["workflow-agent", "workflow-deliver", "workflow-result"]);
const WORKFLOW_BRIDGE_QUEUE_LIMIT = 64;
const WORKFLOW_BRIDGE_DEDUP_LIMIT = 256;
const WORKFLOW_BRIDGE_PAYLOAD_LIMIT = 256_000;
const WORKFLOW_BRIDGE_COALESCED_LIMIT = 512_000;

type WorkflowDeliveryDetails = {
  isError?: boolean;
  status?: "completed" | "failed" | "paused";
  notificationKind?: "agent-completed" | "workflow-message" | "workflow-result";
  runId?: string;
  agentId?: string;
  label?: string;
  sequence?: number;
};

type WorkflowBridgeDelivery = {
  id: string;
  customType: "workflow-agent" | "workflow-deliver" | "workflow-result";
  content: string;
  details?: WorkflowDeliveryDetails;
  wake: boolean;
};

type WorkflowBridge = {
  pi: ExtensionAPI;
  suspended: boolean;
  generation: number;
  nextEventSeq: number;
  pending: WorkflowBridgeDelivery[];
  delivered: Set<string>;
};

type ManagerWithWorkflowBridge = WorkflowManager & { __workflowBridge?: WorkflowBridge };

function bridgeFor(manager: WorkflowManager): WorkflowBridge | undefined {
  return (manager as ManagerWithWorkflowBridge).__workflowBridge;
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
  if (content.length <= WORKFLOW_BRIDGE_PAYLOAD_LIMIT) return content;
  return `${content.slice(0, WORKFLOW_BRIDGE_PAYLOAD_LIMIT)}\n\n[workflow delivery truncated at ${WORKFLOW_BRIDGE_PAYLOAD_LIMIT} characters; the complete run result remains persisted on disk]`;
}

function normalizedWorkflowDelivery(delivery: WorkflowBridgeDelivery): WorkflowBridgeDelivery {
  const content = boundedWorkflowContent(delivery.content);
  return content === delivery.content ? delivery : { ...delivery, content };
}

function queueWorkflowDelivery(bridge: WorkflowBridge, rawDelivery: WorkflowBridgeDelivery): void {
  const delivery = normalizedWorkflowDelivery(rawDelivery);
  if (bridge.delivered.has(delivery.id) || bridge.pending.some((item) => item.id === delivery.id)) return;
  if (bridge.pending.length >= WORKFLOW_BRIDGE_QUEUE_LIMIT) {
    // Bound both queue cardinality and retained text. A stalled/dying session
    // must not become an unbounded memory sink when hundreds of agents finish.
    const retained = bridge.pending.splice(0, bridge.pending.length);
    const combined = [...retained, delivery]
      .map((item) => `[${item.customType}]\n${item.content}`)
      .join("\n\n");
    const content =
      combined.length <= WORKFLOW_BRIDGE_COALESCED_LIMIT
        ? combined
        : `${combined.slice(0, WORKFLOW_BRIDGE_COALESCED_LIMIT)}\n\n[additional coalesced workflow output omitted; complete run results remain persisted on disk]`;
    bridge.pending.push({
      id: hashDeliveryId(`coalesced:${content}`),
      customType: "workflow-deliver",
      content: `Several workflow messages were coalesced while the session was unavailable.\n\n${content}`,
      details: { isError: retained.some((item) => item.details?.isError === true) || delivery.details?.isError === true },
      wake: retained.some((item) => item.wake) || delivery.wake,
    });
    return;
  }
  bridge.pending.push(delivery);
}

function sendWorkflowDelivery(bridge: WorkflowBridge, rawDelivery: WorkflowBridgeDelivery): void {
  const delivery = normalizedWorkflowDelivery(rawDelivery);
  if (bridge.suspended) {
    queueWorkflowDelivery(bridge, delivery);
    return;
  }
  if (bridge.delivered.has(delivery.id)) return;
  rememberDelivery(bridge, delivery.id);
  const startedGeneration = bridge.generation;
  try {
    // All final reports and explicit parent deliveries use steer+triggerTurn.
    // Pi batches messages already present in the steering queue before the next
    // provider call; it does not abort the request that is currently streaming.
    // Routine progress/status UI events remain display-only outside this bridge.
    const sent = bridge.pi.sendMessage(
      {
        customType: delivery.customType,
        content: delivery.content,
        display: true,
        details: delivery.details,
      },
      // Every provider-bound workflow delivery uses the safe-point steering
      // queue. `wake` controls only whether an idle main session starts a turn.
      { triggerTurn: delivery.wake, deliverAs: "steer" },
    );
    // Current Pi types this as void, but tolerate hosts returning a Promise so
    // a rejected generation-bound send cannot become an unhandled rejection or
    // silently lose the delivery.
    void Promise.resolve(sent).catch((err: unknown) => {
      bridge.delivered.delete(delivery.id);
      queueWorkflowDelivery(bridge, delivery);
      console.warn(`[workflow-delivery] async send failed; queued for retry: ${err instanceof Error ? err.message : String(err)}`);
      if (bridge.generation !== startedGeneration && !bridge.suspended) flushWorkflowBridge(bridge);
    });
  } catch (err) {
    bridge.delivered.delete(delivery.id);
    queueWorkflowDelivery(bridge, delivery);
    console.warn(`[workflow-delivery] send failed; queued for retry: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function flushWorkflowBridge(bridge: WorkflowBridge): void {
  if (bridge.suspended || bridge.pending.length === 0) return;
  const queued = bridge.pending.splice(0, bridge.pending.length);
  for (const delivery of queued) sendWorkflowDelivery(bridge, delivery);
}

function suspendWorkflowBridge(manager: WorkflowManager): void {
  const bridge = bridgeFor(manager);
  if (bridge) bridge.suspended = true;
}

function resumeWorkflowBridge(manager: WorkflowManager): void {
  const bridge = bridgeFor(manager);
  if (!bridge) return;
  bridge.suspended = false;
  flushWorkflowBridge(bridge);
}

function bindDeliverBridge(manager: WorkflowManager, pi: ExtensionAPI): void {
  const target = manager as ManagerWithWorkflowBridge;
  const bridge = target.__workflowBridge ?? {
    pi,
    // The extension factory runs before bindCore. Do not call the old pi
    // during that window; session_start explicitly resumes this generation.
    suspended: true,
    generation: 0,
    nextEventSeq: 0,
    pending: [],
    delivered: new Set<string>(),
  } satisfies WorkflowBridge;
  bridge.pi = pi;
  bridge.generation += 1;
  bridge.suspended = true;
  target.__workflowBridge = bridge;

  manager.onDeliver = (message) => {
    const content = typeof message === "string" ? message : String(message ?? "");
    const sequence = bridge.nextEventSeq++;
    sendWorkflowDelivery(bridge, {
      id: hashDeliveryId(`deliver:${bridge.generation}:${sequence}:${content}`),
      customType: "workflow-deliver",
      content,
      details: { notificationKind: "workflow-message", sequence },
      // Explicit child→parent deliveries are important and wake the parent.
      wake: true,
    });
  };
  manager.onAgentMessage = ({ runId, id, label, result, error }) => {
    let text: string;
    try {
      text = error ?? (typeof result === "string" ? result : JSON.stringify(result) ?? "");
    } catch {
      text = String(result);
    }
    // Claude Code models this as a task_notification synthetic turn tied to a
    // stable task/tool identity. Pi has no native task-notification origin, so
    // preserve the same semantics with a dedicated tool-result notification:
    // it is real steer delivery, not a user message or a display-only entry.
    const sequence = bridge.nextEventSeq++;
    sendWorkflowDelivery(bridge, {
      id: hashDeliveryId(`agent:${runId}:${id}:${error ? "failed" : "completed"}:${text}`),
      customType: "workflow-agent",
      content: text,
      details: {
        notificationKind: "agent-completed",
        runId,
        agentId: id,
        label,
        sequence,
        isError: Boolean(error),
        status: error ? "failed" : "completed",
      },
      wake: true,
    });
  };
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
  if (typeof customType !== "string" || !WORKFLOW_CUSTOM_TYPES.has(customType)) return undefined;
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
    case "workflow-agent":
      return (
        "<task-notification>\n" +
        "A background workflow subagent has just completed. Treat this notification as " +
        "the cause of the current synthetic continuation. Respond to the NEW report below, " +
        "not to the older user message. State what new information/action it adds; do not " +
        "repeat an earlier acknowledgment or re-answer unrelated prior context. If several " +
        "task notifications are present in this same batch, handle them together.\n" +
        "</task-notification>\n\n" +
        text
      );
    case "workflow-result":
      return (
        "<workflow-result-notification>\n" +
        "The background workflow has just finished. Treat this final result as the cause " +
        "of the current synthetic continuation. Give one consolidated, action-oriented " +
        "update based on the new result; do not repeat older acknowledgments or re-answer " +
        "an unrelated previous user message.\n" +
        "</workflow-result-notification>\n\n" +
        text
      );
    case "workflow-deliver":
      return (
        "<workflow-message-notification>\n" +
        "A workflow explicitly sent this new message to the parent. Treat it as the cause " +
        "of the current continuation and act on its latest content. Do not merely confirm " +
        "receipt and do not repeat the previous answer.\n" +
        "</workflow-message-notification>\n\n" +
        text
      );
    default:
      return text;
  }
}

function workflowNotificationToolName(customType: string): string {
  if (customType === "workflow-agent") return "workflow_task_notification";
  if (customType === "workflow-result") return "workflow_result_notification";
  return "workflow_message_notification";
}

function installWorkflowToolResultContextBridge(pi: ExtensionAPI): void {
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

      const rawText = customMessageText(message.content) || "(empty workflow delivery)";
      const text = providerWorkflowDeliveryText(message.customType, rawText);
      const toolCallId = hashDeliveryId(
        `${message.customType}:${typeof message.timestamp === "number" ? message.timestamp : ""}:${messageIndex}:${rawText}`,
      );
      const details = (message.details && typeof message.details === "object"
        ? message.details
        : {}) as WorkflowDeliveryDetails;
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
  });
  suspendResultDelivery(manager);
  bindDeliverBridge(manager, pi);

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
  });
  const workflowControlTool = createWorkflowControlTool({ getManager });
  pi.registerTool(workflowTool);
  pi.registerTool(workflowControlTool);
  registerWorkflowMessageRenderers(pi);
  // Keep workflow history as custom entries for the UI, but expose it to the
  // provider as tool_result semantics through the context transform.
  installWorkflowToolResultContextBridge(pi);
  // Pi's compaction/tree summarizers call raw convertToLlm() and do not emit
  // the normal context hook. Sanitize workflow custom messages in their mutable
  // preparation arrays so they cannot become ordinary role=user content.
  installWorkflowSummaryBridge(pi);

  pi.registerTool(
    defineTool({
      name: "workflow_send",
      label: "Workflow Send",
      description:
        "Send a follow-up from the main session to a running workflow. With agentId, deliver immediately to that live subagent; without it, queue for the next subagent call.",
      promptSnippet: "Send a main-session follow-up to a running workflow or a specific live subagent.",
      promptGuidelines: [
        "Use after the user gives new direction; use the agentId shown in subagent messages for an immediate targeted reply.",
        "Without agentId, the message is queued for the newest running workflow's next subagent call.",
      ],
      parameters: Type.Object({
        message: Type.String({ minLength: 1, description: "Follow-up instruction for a subagent." }),
        runId: Type.Optional(Type.String({ minLength: 1, description: "Specific workflow run ID; omit when agentId identifies the target." })),
        agentId: Type.Optional(Type.String({ minLength: 1, description: "Exact live subagent ID from a workflow-agent message for immediate delivery." })),
      }),
      async execute(_toolCallId, params) {
        if (params.agentId) {
          const targetRunId = await manager.sendToAgent(params.message, params.agentId, params.runId);
          if (!targetRunId) {
            throw new Error(`Subagent ${params.agentId} is not currently running`);
          }
          return {
            content: [{ type: "text", text: `Delivered message immediately to subagent ${params.agentId}.` }],
            details: { runId: targetRunId, agentId: params.agentId, message: params.message, mode: "immediate" },
          };
        }

        const queuedRunId = manager.enqueueUserMessage(params.message, params.runId);
        if (!queuedRunId) {
          throw new Error(params.runId ? `Workflow ${params.runId} is not running` : "No running workflow");
        }
        return {
          content: [{ type: "text", text: `Queued message for workflow ${queuedRunId}; it will be injected into the next subagent call.` }],
          details: { runId: queuedRunId, agentId: "", message: params.message, mode: "next-agent" },
        };
      },
    }),
  );

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

    const active = pi.getActiveTools();
    const workflowTools = [workflowTool.name, workflowControlTool.name];
    const missing = workflowTools.filter((name) => !active.includes(name));
    if (missing.length) pi.setActiveTools([...active, ...missing]);

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
