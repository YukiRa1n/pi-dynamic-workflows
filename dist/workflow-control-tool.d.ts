import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type RunStatus } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";
declare const workflowControlSchema: Type.TObject<{
    action: Type.TUnion<[Type.TLiteral<"pause">, Type.TLiteral<"resume">, Type.TLiteral<"stop">]>;
    runId: Type.TString;
}>;
declare const stopWorkflowSchema: Type.TObject<{
    runId: Type.TString;
}>;
declare const listActiveWorkflowsSchema: Type.TObject<{}>;
declare const getWorkflowOutputSchema: Type.TObject<{
    runId: Type.TString;
    block: Type.TOptional<Type.TBoolean>;
    timeoutMs: Type.TOptional<Type.TInteger>;
}>;
export type WorkflowControlInput = Static<typeof workflowControlSchema>;
export type StopWorkflowInput = Static<typeof stopWorkflowSchema>;
export type ListActiveWorkflowsInput = Static<typeof listActiveWorkflowsSchema>;
export type GetWorkflowOutputInput = Static<typeof getWorkflowOutputSchema>;
export interface WorkflowControlToolOptions {
    manager?: WorkflowManager;
    /** Live manager accessor; prefer over a closed-over manager when the extension may replace it. */
    getManager?: () => WorkflowManager;
    /** Current host-session accessor; keeps ownership checks independent of retained manager prototypes. */
    getSessionId?: () => string | undefined;
    /** Live result-projection limit; defaults to the same bound as automatic terminal delivery. */
    getResultMaxChars?: () => number | undefined;
}
export interface WorkflowControlRunDetails {
    runId: string;
    workflowName: string;
    status: RunStatus;
    phase: string | null;
    counts: {
        total: number;
        done: number;
        running: number;
        queued: number;
        error: number;
        skipped: number;
    };
    activeLabels: string[];
    /** True while a paused/aborted/failed managed execution is unwinding. */
    settling: boolean;
    /** Snapshot entries still reported as running during an unsettled cancellation/failure generation. */
    inFlight: number;
    /** Labels for the snapshot entries counted by inFlight. */
    inFlightLabels: string[];
    tokenTotal: number;
}
export interface StopWorkflowResultDetails {
    runId: string;
    stopped: boolean;
    status?: RunStatus;
    error?: string;
}
export interface ActiveWorkflowHandle {
    runId: string;
    name: string;
    status: "running" | "paused";
}
export interface ListActiveWorkflowsResultDetails {
    runs: ActiveWorkflowHandle[];
    truncated: boolean;
    error?: string;
}
export interface GetWorkflowOutputResultDetails extends Record<string, unknown> {
    runId: string;
    status?: RunStatus;
    completed: boolean;
    blocked: boolean;
    timedOut?: boolean;
    interrupted?: boolean;
    resultPath?: string;
    error?: string;
    errorCode?: string;
    recoverable?: boolean;
}
/** Exact cancellation handles for active runs owned by the bound Pi session. */
export declare function createListActiveWorkflowsTool(options: WorkflowControlToolOptions): ToolDefinition<typeof listActiveWorkflowsSchema, ListActiveWorkflowsResultDetails>;
/** One-shot, session-owned output retrieval with an interruptible event wait. */
export declare function createGetWorkflowOutputTool(options: WorkflowControlToolOptions): ToolDefinition<typeof getWorkflowOutputSchema, GetWorkflowOutputResultDetails>;
/**
 * Provider-facing cancellation handle. It deliberately exposes no discovery,
 * status, pause, resume, or steering surface: the caller must use the exact ID
 * returned by start_workflow, and the manager must be bound to the owning Pi
 * session before any mutation is allowed.
 */
export declare function createStopWorkflowTool(options: WorkflowControlToolOptions): ToolDefinition<typeof stopWorkflowSchema, StopWorkflowResultDetails>;
export declare function createWorkflowControlTool(options: WorkflowControlToolOptions): ToolDefinition<typeof workflowControlSchema, Record<string, unknown>>;
export {};
