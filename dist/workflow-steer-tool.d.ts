import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { WorkflowManager } from "./workflow-manager.js";
declare const workflowSteerSchema: Type.TObject<{
    runId: Type.TString;
    message: Type.TString;
    kind: Type.TUnion<[Type.TLiteral<"same_task_correction">, Type.TLiteral<"blocker_answer">, Type.TLiteral<"changed_fact">]>;
    agentId: Type.TOptional<Type.TString>;
}>;
export type WorkflowSteerInput = Static<typeof workflowSteerSchema>;
export interface WorkflowSteerToolOptions {
    manager?: WorkflowManager;
    /** Live manager accessor; prefer it when a session reload can replace the manager. */
    getManager?: () => WorkflowManager;
}
export declare function createWorkflowSteerTool(options: WorkflowSteerToolOptions): ToolDefinition<typeof workflowSteerSchema, Record<string, unknown>>;
export {};
