/**
 * Model-facing routing actions. Existing runs are deliberately absent: the
 * model may start a new run through `start_workflow`, while steering/control
 * remains an explicit user/extension action.
 */
export type WorkflowRoutingToolName = "start_workflow";
export interface WorkflowRoutingChoiceScenario {
    id: string;
    prompt: string;
    expectedTool: WorkflowRoutingToolName | null;
}
export interface CapturedWorkflowRoutingCall {
    name: string;
    arguments: unknown;
}
/** Provider/session evidence captured after a real model attempt. */
export interface WorkflowRoutingSessionEvidence {
    promptError?: string;
    assistantMessages: number;
    assistantStopReason?: string;
    assistantError?: string;
    assistantHasContent: boolean;
}
export interface WorkflowRoutingChoiceEvaluation {
    passed: boolean;
    assertions: Array<{
        name: string;
        passed: boolean;
        details: string;
    }>;
    /** A compact, machine-readable explanation for every failed assertion. */
    failureReasons: string[];
}
export declare const WORKFLOW_ROUTING_CHOICE_SCENARIOS: readonly WorkflowRoutingChoiceScenario[];
export declare function evaluateWorkflowRoutingChoice(scenario: WorkflowRoutingChoiceScenario, calls: readonly CapturedWorkflowRoutingCall[], session?: WorkflowRoutingSessionEvidence): WorkflowRoutingChoiceEvaluation;
