import { serializeBounded, truncateUtf8 } from "./safe-serialize.js";

export type AgentHistoryRole = "user" | "assistant" | "tool";

export type AgentHistoryKind = "text" | "toolCall" | "toolResult" | "error";

export interface AgentHistoryEntry {
  role: AgentHistoryRole;
  kind: AgentHistoryKind;
  text: string;
  toolName?: string;
  /** Source path for file-oriented tool calls rendered specially by the pager. */
  path?: string;
  /** Pi's display-oriented edit diff, preserved from EditToolDetails. */
  diff?: string;
  isError?: boolean;
  timestamp?: number;
}

export interface AgentHistoryOptions {
  maxEntries?: number;
  maxTextChars?: number;
  maxTotalChars?: number;
}

const DEFAULT_MAX_ENTRIES = 40;
const DEFAULT_MAX_TEXT_CHARS = 2000;
const DEFAULT_MAX_TOTAL_CHARS = 20000;
// Callers may tune projection size, but never disable the finite-memory guard
// with an attacker-controlled or malformedly large option.
const HARD_MAX_ENTRIES = 1_000;
const HARD_MAX_TEXT_CHARS = 100_000;
const HARD_MAX_TOTAL_CHARS = 1_000_000;

export function compactAgentHistory(messages: unknown[], options: AgentHistoryOptions = {}): AgentHistoryEntry[] {
  const maxEntries = positiveInt(options.maxEntries, DEFAULT_MAX_ENTRIES, HARD_MAX_ENTRIES);
  const maxTextChars = positiveInt(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS, HARD_MAX_TEXT_CHARS);
  const maxTotalChars = positiveInt(options.maxTotalChars, DEFAULT_MAX_TOTAL_CHARS, HARD_MAX_TOTAL_CHARS);
  const entries: AgentHistoryEntry[] = [];
  const retain = (entry: AgentHistoryEntry): void => {
    entries.push(entry);
    // Keep only a small bounded candidate tail while parsing. fitEntries still
    // applies the exact caller limits after per-entry truncation.
    const candidateLimit = Math.max(maxEntries, 1) * 2;
    if (entries.length > candidateLimit) entries.splice(0, entries.length - candidateLimit);
  };

  for (const raw of messages) {
    const message = asRecord(raw);
    if (!message) continue;
    const role = message.role;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : undefined;

    if (role === "user") {
      const text = textFromContent(message.content);
      if (text.trim()) retain({ role: "user", kind: "text", text: truncateText(text, maxTextChars), timestamp });
      continue;
    }

    if (role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        const block = asRecord(part);
        if (!block || typeof block.type !== "string") continue;
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          retain({ role: "assistant", kind: "text", text: truncateText(block.text, maxTextChars), timestamp });
        } else if (block.type === "toolCall" && typeof block.name === "string") {
          const args = asRecord(block.arguments);
          const filePath =
            (block.name === "write" || block.name === "edit") && typeof args?.path === "string" ? args.path : undefined;
          const writeContent =
            block.name === "write" && filePath && typeof args?.content === "string" ? args.content : undefined;
          retain({
            role: "assistant",
            kind: "toolCall",
            toolName: truncateText(block.name, 256),
            // A write's JSON envelope is both noisy and likely to be truncated
            // into invalid JSON. Preserve its source directly so the pager can
            // render it as code. Edit calls retain their path so the pager can
            // pair the compact call header with the result's native Pi diff.
            text: truncateText(writeContent ?? stringifyCompact(block.arguments ?? {}), maxTextChars),
            path: filePath ? truncateText(filePath, 1024) : undefined,
            timestamp,
          });
        }
      }
      if (typeof message.errorMessage === "string" && message.errorMessage.trim()) {
        retain({
          role: "assistant",
          kind: "error",
          text: truncateText(message.errorMessage, maxTextChars),
          isError: true,
          timestamp,
        });
      }
      continue;
    }

    if (role === "toolResult") {
      const toolName = typeof message.toolName === "string" ? message.toolName : undefined;
      const text = textFromContent(message.content) || "(no text output)";
      const details = asRecord(message.details);
      const diff = toolName === "edit" && typeof details?.diff === "string" ? details.diff : undefined;
      retain({
        role: "tool",
        kind: message.isError ? "error" : "toolResult",
        toolName: toolName ? truncateText(toolName, 256) : undefined,
        text: truncateText(text, maxTextChars),
        diff: diff ? truncateText(diff, maxTextChars) : undefined,
        isError: Boolean(message.isError),
        timestamp,
      });
    }
  }

  return fitEntries(entries, maxEntries, maxTextChars, maxTotalChars);
}

function fitEntries(
  entries: AgentHistoryEntry[],
  maxEntries: number,
  maxTextChars: number,
  maxTotalChars: number,
): AgentHistoryEntry[] {
  const fitted: AgentHistoryEntry[] = [];
  let total = 0;

  for (const entry of entries.slice(-maxEntries).reverse()) {
    const remaining = maxTotalChars - total;
    if (remaining <= 0) break;

    // Treat an edit diff as the entry's primary display payload. Keeping it
    // within the same per-entry and total bounds prevents EditToolDetails from
    // bypassing history compaction with a large changed file.
    let entryBudget = Math.min(maxTextChars, remaining);
    const diff = entry.diff ? truncateText(entry.diff, entryBudget) : undefined;
    entryBudget -= diff?.length ?? 0;
    const text = truncateText(entry.text, entryBudget);
    fitted.unshift({ ...entry, text, diff });
    total += text.length + (diff?.length ?? 0);
  }

  return fitted;
}

function textFromContent(content: unknown): string {
  const limit = 32_000;
  if (typeof content === "string") return truncateUtf8(content, limit, "... [truncated]");
  if (!Array.isArray(content)) return "";
  let output = "";
  for (const part of content) {
    const block = asRecord(part);
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const remaining = limit - Buffer.byteLength(output, "utf8");
    if (remaining <= 0) break;
    output += truncateUtf8(block.text, remaining, "");
  }
  return Buffer.byteLength(output, "utf8") >= limit ? `${truncateUtf8(output, limit - 15, "")}... [truncated]` : output;
}

function stringifyCompact(value: unknown): string {
  return serializeBounded(value, { maxBytes: 8_000, pretty: false });
}

function truncateText(text: string, maxChars: number): string {
  const bounded = truncateUtf8(text, maxChars, "... [truncated]");
  return bounded;
}

function positiveInt(value: number | undefined, fallback: number, hardMax: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, hardMax) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
