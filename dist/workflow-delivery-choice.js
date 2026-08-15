/** Focused #89 scenarios for delivery timing and opt-in token budgets. */
export const WORKFLOW_DELIVERY_CHOICE_SCENARIOS = [
    {
        id: "background-delivery",
        prompt: "Run a workflow to audit the repository from several independent angles. I do not need the result in this turn; let it be delivered back later so I can keep working.",
        expectedBackground: true,
        expectedTokenBudget: null,
    },
    {
        id: "explicit-token-budget",
        prompt: "Run a workflow to audit the repository from several independent angles. Cap the run at exactly 200,000 tokens and let the result be delivered back later.",
        expectedBackground: true,
        expectedTokenBudget: 200_000,
    },
];
/** Score captured workflow arguments without executing the submitted workflow. */
export function evaluateWorkflowDeliveryChoice(scenario, value) {
    const input = isRecord(value) ? value : null;
    const hasScript = typeof input?.script === "string" && input.script.trim().length > 0;
    const hasName = typeof input?.name === "string" && input.name.trim().length > 0;
    const hasWorkflow = hasScript || hasName;
    // The public tool is background-only. Any legacy foreground/background toggle
    // is rejected so evaluations track the actual provider-visible schema.
    const validBackground = input !== null && input.background === undefined;
    const resolvedBackground = validBackground ? true : null;
    const validTokenBudget = input !== null &&
        (input.tokenBudget === undefined ||
            (typeof input.tokenBudget === "number" && Number.isFinite(input.tokenBudget) && input.tokenBudget > 0));
    const resolvedTokenBudget = validTokenBudget && typeof input.tokenBudget === "number" ? input.tokenBudget : null;
    const timingMatches = resolvedBackground === scenario.expectedBackground;
    const tokenBudgetMatches = validTokenBudget && resolvedTokenBudget === scenario.expectedTokenBudget;
    const assertions = [
        {
            name: "workflow:called-with-script-or-name",
            passed: hasWorkflow,
            details: "the model must invoke the workflow tool with a nonblank script or saved/built-in name",
        },
        {
            name: "background:valid-type",
            passed: validBackground,
            details: "background is fixed true by the tool and must not be supplied",
        },
        {
            name: "background:matches-user-timing",
            passed: timingMatches,
            details: "workflow invocations always detach and deliver their result later",
        },
        {
            name: "tokenBudget:valid-positive-number",
            passed: validTokenBudget,
            details: "tokenBudget must be omitted or supplied as a positive finite number",
        },
        {
            name: "tokenBudget:matches-user-intent",
            passed: tokenBudgetMatches,
            details: scenario.expectedTokenBudget === null
                ? "ordinary workflow requests should omit tokenBudget"
                : `the user-supplied cap must be preserved exactly (${scenario.expectedTokenBudget})`,
        },
    ];
    return {
        passed: assertions.every(({ passed }) => passed),
        resolvedBackground,
        resolvedTokenBudget,
        assertions,
    };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
