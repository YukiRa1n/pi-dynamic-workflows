import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { WorkflowManager } from "./workflow-manager.js";
import { type WorkflowStorage } from "./workflow-saved.js";
/** The single always-on gate that authorizes workflow use without forcing it. */
export declare const WORKFLOW_GATE_GUIDELINE = "The `workflow` tool runs multi-agent orchestration \u2014 it fans decomposable work out across subagents, and fits tasks shaped like: repo-wide inspection, independent parallel research/checks, multi-perspective review, or fan-out/fan-in synthesis. ONLY call it when the user explicitly opts in \u2014 via the workflow trigger word, `/workflows run`, or their own words (e.g. 'run a workflow', 'fan this out', '\u5E76\u884C\u5BA1\u4E00\u904D'). For any other task \u2014 even one that would clearly benefit \u2014 do not call it; you may briefly offer it (with a rough cost) as an option instead.";
declare const workflowToolSchema: any;
export type WorkflowToolInput = {
    script?: string;
    name?: string;
    args?: Record<string, unknown>;
    background?: boolean;
    maxAgents?: number;
    concurrency?: number;
    agentRetries?: number;
    agentTimeoutMs?: number;
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
}
export declare function createWorkflowTool(options?: WorkflowToolOptions): ToolDefinition<typeof workflowToolSchema, any>;
/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export declare function backgroundStartedText(name: string, runId: string): string;
/**
 * One-line hint telling the model it can iterate on a finished/running run by
 * resuming it with an edited script instead of re-running the whole workflow.
 * Unchanged agent() calls replay from the journal (cache); only edited/new ones
 * re-run. Omitted when there is no runId to reference.
 */
export declare function reviseHint(runId: string | undefined): string;
/**
 * The tool result returned when the model resumes a run with an edited script.
 * The resumed run is always background, so its result is delivered back later.
 */
export declare function resumedText(name: string, runId: string): string;
/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export declare function resumeFailureText(manager: WorkflowManager, runId: string): string;
export {};
