import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { type RunStatus } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";
declare const workflowControlSchema: Type.TObject<{
    action: Type.TUnion<[Type.TLiteral<"pause">, Type.TLiteral<"resume">, Type.TLiteral<"stop">]>;
    runId: Type.TString;
}>;
export type WorkflowControlInput = Static<typeof workflowControlSchema>;
export interface WorkflowControlToolOptions {
    manager?: WorkflowManager;
    /** Live manager accessor; prefer over a closed-over manager when the extension may replace it. */
    getManager?: () => WorkflowManager;
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
export declare function createWorkflowControlTool(options: WorkflowControlToolOptions): ToolDefinition<typeof workflowControlSchema, Record<string, unknown>>;
export {};
