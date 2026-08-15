import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { WorkflowMeta } from "./workflow.js";
export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";
export interface WorkflowAgentSnapshot {
    id: number;
    /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
    callId?: string;
    label: string;
    phase?: string;
    prompt: string;
    status: WorkflowAgentStatus;
    /** Full agent result, retained for the interactive detail pager. */
    result?: unknown;
    resultPreview?: string;
    error?: string;
    errorCode?: WorkflowErrorCode;
    recoverable?: boolean;
    history?: AgentHistoryEntry[];
    /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
    tokens?: number;
    /** Per-agent token usage breakdown (fresh input+output vs cached), when known. */
    tokenUsage?: AgentUsage;
    /** The model this agent ran on (provider/id), when known. */
    model?: string;
}
export interface WorkflowSnapshot {
    name: string;
    description?: string;
    phases: string[];
    currentPhase?: string;
    logs: string[];
    agents: WorkflowAgentSnapshot[];
    agentCount: number;
    runningCount: number;
    doneCount: number;
    errorCount: number;
    durationMs?: number;
    result?: unknown;
    tokenUsage?: {
        input: number;
        output: number;
        total: number;
        cost?: number;
        cacheRead?: number;
        cacheWrite?: number;
    };
    runId?: string;
}
export interface WorkflowDisplay {
    update(snapshot: WorkflowSnapshot): void;
    complete(snapshot: WorkflowSnapshot): void;
    clear(): void;
}
export interface WorkflowDisplayOptions {
    key?: string;
    placement?: "aboveEditor" | "belowEditor";
    maxAgents?: number;
    showStatus?: boolean;
    showResultPreviews?: boolean;
}
/**
 * Displayable fresh/cached figures from a usage breakdown and/or a scalar
 * estimate. The token pipeline has two sources that don't always agree: the
 * provider-reported breakdown (input/output/cacheRead/cacheWrite) and a scalar
 * estimate (`total` at run level, `tokens` per agent) that keeps accruing even
 * when the provider reports nothing. Two rules:
 * - `fresh` counts input+output+cacheWrite: cache writes are first-time
 *   ingestion billed at full (or premium) price, so hiding them would
 *   under-report real spend; only cacheRead is the cheap reuse shown apart.
 * - `fresh` is never less than what the estimate can account for after
 *   removing cache reads, so estimate-only providers, cost-only providers
 *   (billed but zero token counts), and mixed runs keep the count the display
 *   showed before the split existed, instead of a false "0 tok".
 */
export declare function tokenFigures(usage: Partial<AgentUsage> | undefined, scalarTokens?: number): {
    fresh: number;
    cacheRead: number;
};
/** Sum a set of agents into fresh vs cacheRead totals, via {@link tokenFigures}. */
export declare function aggregateAgentUsage(agents: ReadonlyArray<Pick<WorkflowAgentSnapshot, "tokens" | "tokenUsage">>): {
    fresh: number;
    cacheRead: number;
};
/**
 * Format a token count for a display surface: "12.4K tok" on its own, or
 * "89K tok · 3.0M cached" when there were cache reads. The cache segment is shown
 * only when `cacheRead > 0`, so a non-caching provider (or a single-turn agent that
 * never re-reads its cache) reads as a plain "tok" rather than a bare, contextless
 * "fresh". `fmt` adapts the number style per surface (compact in panels, full in
 * the print view).
 */
export declare function fmtTokenCount(fresh: number, cacheRead: number, fmt: (n: number) => string): string;
/**
 * Like {@link fmtTokenCount}, but "" when nothing is known yet (both figures 0),
 * so surfaces omit the segment instead of rendering a false "0 tok" — e.g. for a
 * journal-replayed resume or a run whose agents were all skipped. Every surface
 * should use this rather than re-implementing the zero guard.
 */
export declare function fmtTokenSegment(figures: {
    fresh: number;
    cacheRead: number;
}, fmt: (n: number) => string): string;
/**
 * "$1.23" from one cent up, four decimals below it, and "<$0.0001" for
 * anything smaller — a real cost never rounds to a zero-looking "$0.00".
 */
export declare function fmtCost(cost: number): string;
/** Full (non-compact) number style for print/text surfaces: locale-grouped digits. */
export declare const fmtFull: (n: number) => string;
export declare function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot;
export declare function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot;
export declare function createWidgetWorkflowDisplay(ctx: Pick<ExtensionContext, "ui" | "hasUI">, options?: WorkflowDisplayOptions): WorkflowDisplay;
export declare function createToolUpdateWorkflowDisplay(onUpdate: ((result: {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: unknown;
}) => void) | undefined, ctx?: Pick<ExtensionContext, "ui" | "hasUI">, options?: WorkflowDisplayOptions & {
    streamToolUpdates?: boolean;
}): WorkflowDisplay;
/** Minimal theme surface so rendering works without a real Theme (tool output, tests). */
export interface ThemeLike {
    fg(color: string, text: string): string;
    bold(text: string): string;
}
export declare function renderWorkflowLines(snapshot: WorkflowSnapshot, options?: WorkflowDisplayOptions, theme?: ThemeLike): string[];
export declare function renderWorkflowText(snapshot: WorkflowSnapshot, completed?: boolean): string;
export declare function statusIcon(status: WorkflowAgentStatus): string;
export declare function shorten(value: string, max: number): string;
export declare function preview(value: unknown, max?: number): string;
