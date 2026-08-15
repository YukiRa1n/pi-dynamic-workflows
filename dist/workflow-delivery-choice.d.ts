/** One model-facing timing and token-budget decision for invoking the workflow tool. */
export interface WorkflowDeliveryChoiceScenario {
    id: string;
    prompt: string;
    expectedBackground: boolean;
    expectedTokenBudget: number | null;
}
/** Pure scoring result for one captured workflow tool invocation. */
export interface WorkflowDeliveryChoiceEvaluation {
    passed: boolean;
    resolvedBackground: boolean | null;
    resolvedTokenBudget: number | null;
    assertions: Array<{
        name: string;
        passed: boolean;
        details: string;
    }>;
}
/** Focused #89 scenarios for delivery timing and opt-in token budgets. */
export declare const WORKFLOW_DELIVERY_CHOICE_SCENARIOS: readonly WorkflowDeliveryChoiceScenario[];
/** Score captured workflow arguments without executing the submitted workflow. */
export declare function evaluateWorkflowDeliveryChoice(scenario: WorkflowDeliveryChoiceScenario, value: unknown): WorkflowDeliveryChoiceEvaluation;
