/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */
import type { ExtensionAPI, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { ManagedRun, WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import type { WorkflowSettings } from "./workflow-settings.js";
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
export declare function deliverText(run: ManagedRun, opts?: {
    resultPath?: string;
    maxChars?: number;
}): string;
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
/**
 * Stop live sends on this manager. In-flight completions only enqueue until
 * {@link resumeResultDelivery} runs (from session_start, after Pi has bound
 * the extension runtime) or the process exits (quit — results stay on disk).
 *
 * Call from session_shutdown BEFORE handoff or discard so a completion that
 * races the teardown cannot deliver into the outgoing session.
 */
export declare function suspendResultDelivery(manager: WorkflowManager): void;
/**
 * Unsuspend and flush any queued deliveries. Must run only after Pi has
 * finished constructing the AgentSession and bound sendMessage (i.e. from
 * session_start) — calling it from the extension factory hits the
 * "runtime not initialized" stub and re-queues forever.
 */
export declare function resumeResultDelivery(manager: WorkflowManager): void;
export declare function installResultDelivery(pi: ExtensionAPI, manager: WorkflowManager, opts?: {
    loadSettings?: () => WorkflowSettings;
    installContextBridge?: boolean;
    /** Route terminal results through an extension-owned batching/dedup bridge. */
    sendResult?: (payload: WorkflowDeliveryPayload) => void;
}): () => void;
export declare function renderPanel(manager: WorkflowManager, theme: Theme, width?: number): string[];
/** Record a token-total sample for `runId` at time `now` (ms). */
export declare function sampleTokens(runId: string, total: number, now: number): void;
/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export declare function tokensPerSecond(runId: string): number;
/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export declare function clearTokenSamples(runId: string): void;
/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export declare function clampMaxAgents(value: number | undefined): number;
/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export declare function renderPanelDetailed(manager: WorkflowManager, theme: Theme, width: number | undefined, maxAgents: number, now: number): string[];
/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export declare function installTaskPanel(_pi: ExtensionAPI, manager: WorkflowManager, ui: ExtensionUIContext, opts?: TaskPanelOptions): void;
