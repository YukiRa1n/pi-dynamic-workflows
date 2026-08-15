/**
 * Interactive `/workflows` navigator, modeled on Claude Code's view:
 *
 *   runs ──enter──▶ phases ──enter──▶ agents ──enter──▶ agent detail
 *        ◀──esc───        ◀──esc────         ◀──esc────
 *        ◀── (saved items in runs view) ──enter──▶ saved detail
 *
 * Keys: ↑/↓ (or j/k) select · enter/→ drill in · esc/← back (esc at top closes)
 *       On runs: p pause · x stop · r restart · s save · q quit
 *       On saved: x delete · q quit
 *
 * The state machine and line rendering are pure and unit-tested; the pi-tui
 * Component shell (openWorkflowNavigator) wires them to live manager events.
 */
import { type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentUsage } from "./agent.js";
import type { ThemeLike, WorkflowAgentSnapshot } from "./display.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
export type ViewKind = "runs" | "phases" | "agents" | "detail" | "savedDetail";
export type ItemKind = "run" | "saved";
interface RunRow {
    runId: string;
    name: string;
    status: string;
    done: number;
    total: number;
    /** Fresh tokens for the whole run (see tokenFigures for the fallback rule). */
    fresh: number;
    /** Cache-read tokens for the whole run. */
    cacheRead: number;
    cost: number;
}
interface PhaseRow {
    title: string;
    done: number;
    total: number;
    /** Fresh tokens summed across the phase's agents. */
    fresh: number;
    /** Cache-read tokens summed across the phase's agents. */
    cacheRead: number;
}
interface AgentRow {
    id: number;
    label: string;
    status: string;
    phase?: string;
    tokens?: number;
    tokenUsage?: AgentUsage;
    model?: string;
}
export declare function shortModel(model: string | undefined): string | undefined;
/** Reads run/phase/agent data from the manager, preferring live snapshots. */
export declare class NavigatorModel {
    private readonly manager;
    private readonly storage?;
    private frameDepth;
    private frameRuns;
    private readonly frameSnapshots;
    constructor(manager: Pick<WorkflowManager, "listRuns" | "getRun">, storage?: {
        list(): SavedWorkflow[];
        delete(name: string, location?: string): boolean;
    });
    /** Share persisted data across all model lookups performed by one render. */
    withRenderFrame<T>(render: () => T): T;
    private persistedRuns;
    private snapshot;
    runs(): RunRow[];
    /** Return saved workflows sorted by name, or [] when no storage configured. */
    saved(): SavedWorkflow[];
    /** Delete a saved workflow by name. */
    deleteSaved(name: string): boolean;
    runName(runId: string): string;
    runStatus(runId: string): string;
    phases(runId: string): PhaseRow[];
    agents(runId: string, phase: string): AgentRow[];
    /**
     * All agents grouped by their (coerced) phase in a SINGLE pass — O(agents).
     * The navigator's phase pane needs each phase's agents (status colour + the
     * selected phase's rows); calling agents() once per phase row was O(phases ×
     * agents) per frame. Callers that render every phase use this instead.
     */
    agentsByPhase(runId: string): Map<string, AgentRow[]>;
    agentDetail(runId: string, agentId: number): WorkflowAgentSnapshot | undefined;
}
/** Navigation state machine: a stack of (view, cursor) frames plus detail scroll. */
export declare class NavigatorState {
    private stack;
    scroll: number;
    tailing: boolean;
    pagerOpen: boolean;
    private pageSize;
    private top;
    get kind(): ViewKind;
    get cursor(): number;
    set cursor(val: number);
    get runId(): string | undefined;
    get phase(): string | undefined;
    get agentId(): number | undefined;
    /** The saved workflow name at the cursor in savedDetail view */
    get savedName(): string | undefined;
    get depth(): number;
    /**
     * Determine what kind of item is at the given cursor position in the
     * runs view. Positions before runs.length are "run"; after are "saved".
     */
    itemKindAt(model: NavigatorModel, cursor: number): ItemKind;
    /** Clamp the cursor to [0, count). */
    clamp(count: number): void;
    move(delta: number, count: number): void;
    /** Update the amount moved by page keys to match the rendered viewport. */
    setPageSize(rows: number): void;
    /** Move by almost one viewport, retaining one line of reading context. */
    movePage(direction: -1 | 1, count: number): void;
    /** Jump to the beginning or end of the current list/detail. End also enables
     * follow mode for a live agent detail; start disables it. */
    jump(edge: "start" | "end", count: number): void;
    /** Open the full pager without closing an already-open pager. */
    openPager(): boolean;
    /** Toggle the full pager while retaining the compact agent summary view. */
    togglePager(): boolean;
    /** Toggle live follow mode in an agent detail pager. */
    toggleTail(): boolean;
    /** Drill into the selected item. Returns true if the view changed. */
    drill(model: NavigatorModel): boolean;
    /** Pop one level. Returns false when already at the top (caller should close). */
    back(): boolean;
    /** The runId at cursor, or undefined when on a saved item. */
    activeRunId(model: NavigatorModel): string | undefined;
}
/** Build the lines for the current view. Pure: depends only on state + model + theme. */
export declare function renderNavigator(state: NavigatorState, model: NavigatorModel, width: number, theme?: ThemeLike, viewportRows?: number, markdownTheme?: MarkdownTheme): string[];
/** What a key press should do. Pure mapping from a parsed key id to an action. */
export type NavAction = {
    type: "move";
    delta: number;
} | {
    type: "page";
    direction: -1 | 1;
} | {
    type: "jump";
    edge: "start" | "end";
} | {
    type: "toggleTail";
} | {
    type: "togglePager";
} | {
    type: "openPager";
} | {
    type: "drill";
} | {
    type: "back";
} | {
    type: "close";
} | {
    type: "pause";
} | {
    type: "stop";
} | {
    type: "restart";
} | {
    type: "save";
} | {
    type: "deleteSaved";
} | {
    type: "none";
};
export declare function keyToAction(keyId: string | undefined, kind: ViewKind, itemKind?: "run" | "saved"): NavAction;
import type { OverlayAnchor } from "@earendil-works/pi-tui";
export interface NavigatorOptions {
    storage?: WorkflowStorage;
    /** Live storage accessor when the extension may replace storage after session_start. */
    getStorage?: () => WorkflowStorage | undefined;
    cwd?: string;
    /** Live cwd accessor. */
    getCwd?: () => string;
    /**
     * Live manager accessor used when registering a saved `/name` command from the
     * navigator. Prefer this over the closed-over `manager` argument so saves run
     * through the current session's manager (background path), not a stale snapshot.
     */
    getManager?: () => WorkflowManager;
    /** Overlay anchor position: "center" (default) or "right-center" for sidebar. */
    anchor?: OverlayAnchor;
}
/**
 * Open the interactive `/workflows` navigator as a focused overlay. Resolves when
 * the user closes it (esc at the top level, or `q`).
 */
export declare function openWorkflowNavigator(pi: ExtensionAPI, manager: WorkflowManager, ui: ExtensionUIContext, opts?: NavigatorOptions): Promise<void>;
export {};
