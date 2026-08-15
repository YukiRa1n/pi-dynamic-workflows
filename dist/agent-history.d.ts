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
export declare function compactAgentHistory(messages: unknown[], options?: AgentHistoryOptions): AgentHistoryEntry[];
