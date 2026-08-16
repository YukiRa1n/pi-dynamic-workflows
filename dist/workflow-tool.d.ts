import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WorkflowManager } from "./workflow-manager.js";
import { type WorkflowStorage } from "./workflow-saved.js";
declare const workflowToolSchema: Type.TObject<{
    script: Type.TOptional<Type.TString>;
    name: Type.TOptional<Type.TString>;
    args: Type.TOptional<Type.TUnsafe<Record<string, unknown>>>;
    maxAgents: Type.TOptional<Type.TInteger>;
    concurrency: Type.TOptional<Type.TInteger>;
    agentRetries: Type.TOptional<Type.TInteger>;
    agentTimeoutMs: Type.TOptional<Type.TInteger>;
    workflowTimeoutMs: Type.TOptional<Type.TInteger>;
    tokenBudget: Type.TOptional<Type.TInteger>;
    resumeFromRunId: Type.TOptional<Type.TString>;
}>;
export type WorkflowToolInput = {
    script?: string;
    preset?: string;
    name?: string;
    args?: Record<string, unknown>;
    maxAgents?: number;
    concurrency?: number;
    agentRetries?: number;
    agentTimeoutMs?: number;
    workflowTimeoutMs?: number;
    tokenBudget?: number;
    resumeFromRunId?: string;
};
export interface WorkflowToolOptions {
    cwd?: string;
    concurrency?: number;
    /** Shared manager so background runs are reachable from the `/workflows` command. */
    manager?: WorkflowManager;
    /**
     * Live manager accessor. Prefer this over a closed-over `manager` when the
     * extension may replace the manager after session_start (cross-project resume).
     * Falls back to `manager` / a freshly constructed default.
     */
    getManager?: () => WorkflowManager;
    /** Shared saved-workflow storage. */
    storage?: WorkflowStorage;
    /** Live storage accessor; same rationale as getManager. */
    getStorage?: () => WorkflowStorage;
    /** Live project cwd for name-resolution / settings. */
    getCwd?: () => string;
    /** Default per-agent timeout for runs created by this tool. null means no hard timeout. */
    defaultAgentTimeoutMs?: number | null;
    /** Default max concurrent agents when no tool-level concurrency is passed. */
    defaultConcurrency?: number;
    /** Default retry attempts after recoverable agent failures. */
    defaultAgentRetries?: number;
    /**
     * Expose edited-script resume to embedders that explicitly opt in. The Pi
     * extension disables it so the model-facing tool can only start a fresh run.
     */
    allowResume?: boolean;
    /**
     * Expose library-level resource controls. The Pi extension leaves this off;
     * embedders that need per-invocation policy can opt in explicitly.
     */
    exposeAdvancedParameters?: boolean;
    /**
     * Use the provider-facing start-only contract: `start_workflow` with a
     * custom script or one of the curated built-in presets. Saved run names and
     * lifecycle controls remain library/command APIs.
     */
    modelFacing?: boolean;
}
export declare function createWorkflowTool(options?: WorkflowToolOptions): ToolDefinition<typeof workflowToolSchema, any>;
/** Compact acknowledgement for a detached workflow start. */
export declare function backgroundStartedText(name: string, runId: string): string;
/**
 * One-line hint for iterating on a run with cached-prefix replay.
 */
export declare function reviseHint(runId: string | undefined): string;
/**
 * Compact acknowledgement for resuming a run with an edited script.
 */
export declare function resumedText(name: string, runId: string): string;
/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export declare function resumeFailureText(manager: WorkflowManager, runId: string): string;
export {};
