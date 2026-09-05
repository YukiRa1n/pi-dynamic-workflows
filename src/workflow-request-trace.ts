import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "./safe-serialize.js";

const MAX_PAYLOAD_CHARS = 8 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;

/** Preserve prompt text while excluding credentials and opaque binary/reasoning blobs.
 * This is a diagnostic copy only; never return it to the provider pipeline. */
export function serializeRequestTrace(payload: unknown): { text: string; truncated: boolean } {
  const text =
    JSON.stringify(payload, (key, value) => {
      if (
        /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|headers|encrypted_content|signature|thinkingSignature)$/i.test(
          key,
        )
      )
        return "[omitted]";
      if (typeof value === "string") {
        if (/^data:[^;]+;base64,/.test(value) || (key === "data" && value.length > 1024)) return "[binary omitted]";
        return value
          .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
          .replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted API key]");
      }
      return value;
    }) ?? "null";
  return { text: truncateUtf8(text, MAX_PAYLOAD_CHARS, ""), truncated: Buffer.byteLength(text) > MAX_PAYLOAD_CHARS };
}

export function requestTracePath(sessionId: string): string {
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  return join(homedir(), ".pi", "workflows", "request-traces", `${key}.jsonl`);
}

export function appendRequestTrace(path: string, record: unknown): void {
  const dir = join(path, "..");
  mkdirSync(dir, { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_LOG_BYTES) throw new Error("trace record exceeds log limit");
  if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
    // Replace the one rotation slot rather than growing an unbounded trace.
    if (existsSync(`${path}.1`)) writeFileSync(`${path}.1`, "", { mode: 0o600 });
    renameSync(path, `${path}.1`);
  }
  appendFileSync(path, line, { mode: 0o600 });
}

export function installWorkflowRequestTrace(pi: ExtensionAPI): void {
  const instance = randomUUID();
  let enabled = true;
  let sessionId = "";
  let request = 0;
  let preparedSeen = false;
  let failed = false;
  let projection: unknown[] = [];
  const write = (stage: string, data: Record<string, unknown>, ctx?: any) => {
    if (!enabled || !sessionId) return;
    try {
      appendRequestTrace(requestTracePath(sessionId), {
        time: new Date().toISOString(),
        sessionId,
        instance,
        request,
        stage,
        ...data,
      });
    } catch (error) {
      if (!failed) ctx?.ui?.notify?.(`Workflow request trace failed: ${String(error)}`, "warning");
      failed = true;
    }
  };
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
    preparedSeen = false;
    projection = [];
  });
  pi.on("context", (event) => {
    preparedSeen = false;
    if (!enabled) {
      projection = [];
      return;
    }
    // Installed after the workflow projector. This is a local stage, not proof
    // that a later extension or provider retained the same text.
    projection = event.messages
      .filter(
        (message: any) =>
          message.role === "toolResult" &&
          (message.toolName === "get_workflow_output" || message.toolName?.startsWith("workflow_")),
      )
      .slice(-16)
      .map((message: any) => ({ tool: message.toolName, id: message.toolCallId, content: message.content }));
  });
  pi.on("before_provider_request", (event, ctx) => {
    request++;
    preparedSeen = false;
    if (!enabled) return;
    write("workflow-projection", serializeRequestTrace(projection), ctx);
    // Do not call this final: later handlers may replace event.payload.
    write("before-provider-hooks-finished", { payloadAvailable: event.payload !== undefined }, ctx);
  });
  // The small host patch emits this only AFTER all payload-mutating handlers.
  (pi.on as any)("provider_request_prepared", (event: any, ctx: any) => {
    preparedSeen = true;
    if (!enabled) return;
    write(
      "provider-request-prepared",
      { ...serializeRequestTrace(event.payload), model: ctx.model?.id, provider: ctx.model?.provider },
      ctx,
    );
  });
  pi.on("after_provider_response", (event, ctx) => {
    write("provider-response", { status: event.status, finalPayloadObserved: preparedSeen }, ctx);
  });
  pi.on("message_end", (event, ctx) => {
    if (!enabled) return;
    if (event.message.role === "custom" && event.message.customType.startsWith("workflow-")) {
      write(
        "history-delivery",
        serializeRequestTrace({
          type: event.message.customType,
          details: event.message.details,
          content: event.message.content,
        }),
        ctx,
      );
      return;
    }
    if (event.message.role !== "assistant") return;
    write(
      "assistant-response",
      {
        stopReason: event.message.stopReason,
        finalPayloadObserved: preparedSeen,
        ...serializeRequestTrace(
          event.message.content.filter((part: any) => part.type === "text" || part.type === "toolCall"),
        ),
      },
      ctx,
    );
  });
  pi.registerCommand("workflow-trace", {
    description: "Workflow request trace: on, off, or status",
    handler: async (args, ctx) => {
      if (args.trim() === "off") enabled = false;
      else if (args.trim() === "on") enabled = true;
      ctx.ui.notify(
        `Request trace ${enabled ? "on" : "off"}; final payload ${preparedSeen ? "observed" : "not observed yet"}; ${requestTracePath(sessionId || ctx.sessionManager.getSessionId())}`,
        "info",
      );
    },
  });
}
