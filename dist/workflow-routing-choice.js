import { BUILTIN_WORKFLOW_NAMES } from "./builtin-workflows.js";
import { parseWorkflowScript } from "./workflow.js";
export const WORKFLOW_ROUTING_CHOICE_SCENARIOS = [
    {
        id: "new-request-stays-direct",
        prompt: "Workflow run-old-a is still auditing authentication. The user's new, unrelated request is: explain in one sentence what a mutex is.",
        expectedTool: null,
    },
    {
        id: "explicit-new-workflow-starts-fresh",
        prompt: "Workflow run-old-a is still auditing authentication. The user now explicitly asks: run a new workflow to review the storage layer from three independent angles.",
        expectedTool: "start_workflow",
    },
    {
        id: "same-task-update-stays-out-of-model-tools",
        prompt: "The user provides a correction for the same authentication audit: workflow run-old-a should inspect config/auth-v2.json instead of config/auth.json. Apply this correction to that run.",
        expectedTool: null,
    },
    {
        id: "ambiguous-runs-never-guessed",
        prompt: "Two unrelated workflows, run-old-a and run-old-b, are active. The user's new request is: rename a local variable in the current file. No run is identified as the target.",
        expectedTool: null,
    },
];
export function evaluateWorkflowRoutingChoice(scenario, calls, session) {
    const expectedCalls = scenario.expectedTool === null ? 0 : 1;
    const onlyCall = calls.length === 1 ? calls[0] : undefined;
    const args = isRecord(onlyCall?.arguments) ? onlyCall.arguments : undefined;
    const scriptEvidence = scenario.expectedTool === "start_workflow" ? parseCapturedStart(args) : { passed: true, details: "not applicable" };
    const unsupportedStartFields = calls.flatMap(({ name, arguments: value }) => {
        if (name !== "start_workflow" || !isRecord(value))
            return [];
        return [
            "maxAgents",
            "concurrency",
            "agentRetries",
            "agentTimeoutMs",
            "workflowTimeoutMs",
            "tokenBudget",
            "resumeFromRunId",
            "timeoutMs",
        ].filter((key) => Object.hasOwn(value, key));
    });
    const assertions = [
        {
            name: "routing:call-count",
            passed: calls.length === expectedCalls,
            details: scenario.expectedTool === null
                ? "a new direct or ambiguous request must not enter any workflow run"
                : "the request should select exactly one workflow action",
        },
        {
            name: "routing:tool",
            passed: scenario.expectedTool === null ? calls.length === 0 : onlyCall?.name === scenario.expectedTool,
            details: `expected ${scenario.expectedTool ?? "no workflow tool"}`,
        },
        {
            name: "routing:no-existing-run-action",
            passed: calls.every(({ name }) => name === "start_workflow"),
            details: "model-facing routing must not steer or send to an existing run",
        },
        {
            name: "workflow:no-invented-limits",
            passed: unsupportedStartFields.length === 0,
            details: unsupportedStartFields.length === 0
                ? "start-only surface carries no per-call limits, replay, or control fields"
                : `model supplied unsupported start-tool field(s): ${unsupportedStartFields.join(", ")}`,
        },
    ];
    if (scenario.expectedTool === "start_workflow") {
        assertions.push({
            name: "workflow:fresh-run",
            passed: args !== undefined &&
                args.resumeFromRunId === undefined &&
                args.name === undefined &&
                ((typeof args.script === "string" && args.script.trim().length > 0 && args.preset === undefined) ||
                    (typeof args.preset === "string" &&
                        BUILTIN_WORKFLOW_NAMES.includes(args.preset) &&
                        args.script === undefined)),
            details: "an explicit workflow request must start from one script or curated preset and never target an old run",
        });
        assertions.push({
            name: "workflow:script-parses",
            passed: scriptEvidence.passed,
            details: scriptEvidence.details,
        });
    }
    if (session) {
        const sessionErrors = [
            session.promptError ? `session.prompt failed: ${session.promptError}` : undefined,
            session.assistantStopReason === "error"
                ? `assistant stopReason=error${session.assistantError ? `: ${session.assistantError}` : ""}`
                : undefined,
            session.assistantStopReason !== "error" && session.assistantError
                ? `assistant error: ${session.assistantError}`
                : undefined,
            session.assistantStopReason === "aborted" ? "assistant stopReason=aborted" : undefined,
        ].filter((value) => value !== undefined);
        const validAssistantResponse = session.assistantMessages > 0 &&
            session.assistantHasContent &&
            session.assistantStopReason !== undefined &&
            sessionErrors.length === 0;
        assertions.push({
            name: "session:valid-assistant-response",
            passed: validAssistantResponse,
            details: validAssistantResponse
                ? `assistant response received (stopReason=${session.assistantStopReason})`
                : sessionErrors.join("; ") ||
                    (session.assistantMessages === 0
                        ? "no assistant response was recorded"
                        : "assistant response was empty or had no terminal stop reason"),
        });
    }
    const failureReasons = assertions.filter(({ passed }) => !passed).map(({ name, details }) => `${name}: ${details}`);
    return { passed: failureReasons.length === 0, assertions, failureReasons };
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseCapturedStart(args) {
    if (typeof args?.preset === "string") {
        return BUILTIN_WORKFLOW_NAMES.includes(args.preset)
            ? { passed: true, details: `captured curated preset: ${args.preset}` }
            : { passed: false, details: `captured unknown preset: ${args.preset}` };
    }
    return parseCapturedScript(args?.script);
}
function parseCapturedScript(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return { passed: false, details: "captured workflow call has no non-empty `script`" };
    }
    const normalized = normalizeScriptForEvidence(value);
    // `parseWorkflowScript` validates JavaScript syntax and workflow metadata,
    // but it cannot know which globals a future VM will expose. Catch the
    // legacy/non-existent API that previously made this harness report a false
    // pass (the production runtime exposes `agent`, not `runAgent`).
    if (/\brunAgent\s*\(/.test(normalized)) {
        return { passed: false, details: "captured script calls non-existent workflow API `runAgent()`" };
    }
    try {
        const parsed = parseWorkflowScript(normalized);
        return { passed: true, details: `parsed workflow script meta.name=${JSON.stringify(parsed.meta.name)}` };
    }
    catch (error) {
        return {
            passed: false,
            details: `parseWorkflowScript rejected the captured script: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}
/**
 * The real tool's prepareArguments removes an optional markdown fence before
 * execute(). Keep the evidence evaluator tolerant of raw calls supplied by
 * unit tests while delegating all actual syntax/metadata checks to the real
 * parser above.
 */
function normalizeScriptForEvidence(script) {
    let text = script.trim();
    const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
    if (fence)
        text = fence[1].trim();
    return text;
}
