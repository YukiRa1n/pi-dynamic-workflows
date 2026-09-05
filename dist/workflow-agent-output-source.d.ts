import type { PersistedRunState } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";
/** The identity fields shared by get_workflow_output and live notifications. */
export interface WorkflowAgentOutputIdentity {
    id: number;
    callId?: string;
    label: string;
    phase?: string;
    status: "done" | "error";
}
export interface WorkflowAgentOutputCandidate extends WorkflowAgentOutputIdentity {
    value: unknown;
    fingerprint: string;
    previewOnly?: boolean;
}
/** Stable identity used by every consumer of a completed agent result. */
export declare function workflowAgentOutputFingerprint(identity: WorkflowAgentOutputIdentity, value: unknown): string;
/** Shared session-scoped cursor; the durable run remains the source of truth. */
export declare function workflowAgentOutputCursor(manager: WorkflowManager, runId: string): Set<string>;
/** Claim one result for either the live notification or the output tool. */
export declare function claimWorkflowAgentOutput(manager: WorkflowManager, runId: string, identity: WorkflowAgentOutputIdentity, value: unknown): boolean;
export declare function isWorkflowAgentOutputConsumed(manager: WorkflowManager, runId: string, identity: WorkflowAgentOutputIdentity, value: unknown): boolean;
/** Build the tool's candidates from the same live/persisted agent snapshots. */
export declare function workflowAgentOutputCandidates(manager: WorkflowManager, run: PersistedRunState): WorkflowAgentOutputCandidate[];
