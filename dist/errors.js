/**
 * Workflow-specific error types.
 */
/** Stable runtime and persistence failure codes exposed to callers and UI surfaces. */
export var WorkflowErrorCode;
(function (WorkflowErrorCode) {
    /** Agent exceeded timeout. */
    WorkflowErrorCode["AGENT_TIMEOUT"] = "AGENT_TIMEOUT";
    /** Workflow was aborted by user. */
    WorkflowErrorCode["WORKFLOW_ABORTED"] = "WORKFLOW_ABORTED";
    /** The workflow frame exceeded its finite logical wall-clock deadline. */
    WorkflowErrorCode["WORKFLOW_TIMEOUT"] = "WORKFLOW_TIMEOUT";
    /** Agent limit exceeded. */
    WorkflowErrorCode["AGENT_LIMIT_EXCEEDED"] = "AGENT_LIMIT_EXCEEDED";
    /** A finite run-wide resource collection or fan-out limit was exceeded. */
    WorkflowErrorCode["RESOURCE_LIMIT_EXCEEDED"] = "RESOURCE_LIMIT_EXCEEDED";
    /** Token budget exhausted. */
    WorkflowErrorCode["TOKEN_BUDGET_EXHAUSTED"] = "TOKEN_BUDGET_EXHAUSTED";
    /** Explicit deliver() resource budget exhausted; terminal delivery is reserved. */
    WorkflowErrorCode["DELIVERY_BUDGET_EXCEEDED"] = "DELIVERY_BUDGET_EXCEEDED";
    /**
     * The provider's subscription/usage/quota/rate limit was hit. Distinct from the
     * user's self-imposed TOKEN_BUDGET_EXHAUSTED: a provider limit refills on its own,
     * so the run is checkpointed (paused) and replayed by resume() rather than failed.
     */
    WorkflowErrorCode["PROVIDER_USAGE_LIMIT"] = "PROVIDER_USAGE_LIMIT";
    /** Script validation failed. */
    WorkflowErrorCode["SCRIPT_VALIDATION_ERROR"] = "SCRIPT_VALIDATION_ERROR";
    /** A schema agent never produced valid structured_output (after repair + extraction). */
    WorkflowErrorCode["SCHEMA_NONCOMPLIANCE"] = "SCHEMA_NONCOMPLIANCE";
    /** A non-schema agent completed without any assistant text output. */
    WorkflowErrorCode["AGENT_EMPTY_OUTPUT"] = "AGENT_EMPTY_OUTPUT";
    /**
     * An agent()'s `model`/`tier` spec did not resolve to any known model. Never
     * silently substituted for the session default — resolution is deterministic,
     * so retrying the same spec would fail identically every time.
     */
    WorkflowErrorCode["MODEL_NOT_FOUND"] = "MODEL_NOT_FOUND";
    /** Agent execution failed. */
    WorkflowErrorCode["AGENT_EXECUTION_ERROR"] = "AGENT_EXECUTION_ERROR";
    /** Run state persistence failed. */
    WorkflowErrorCode["PERSISTENCE_ERROR"] = "PERSISTENCE_ERROR";
    /** Unknown error. */
    WorkflowErrorCode["UNKNOWN"] = "UNKNOWN";
})(WorkflowErrorCode || (WorkflowErrorCode = {}));
/** Classified workflow failure with recoverability and optional agent/provider context. */
export class WorkflowError extends Error {
    code;
    recoverable;
    agentLabel;
    details;
    /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
    resetHint;
    constructor(message, code, options = {}) {
        super(message);
        this.name = "WorkflowError";
        this.code = code;
        this.recoverable = options.recoverable ?? false;
        this.agentLabel = options.agentLabel;
        this.details = options.details;
        this.resetHint = options.resetHint;
    }
}
/** Contract failure that retains every definition or assembly diagnostic. */
export class WorkflowCapabilityContractError extends Error {
    diagnostics;
    constructor(message, diagnostics) {
        super(message);
        this.name = "WorkflowCapabilityContractError";
        this.diagnostics = diagnostics;
    }
}
/** Generation failure that retains loading and token evidence for diagnosis. */
export class ModelGenerationError extends Error {
    skillLoadingEvidence;
    tokenUsage;
    constructor(message, skillLoadingEvidence, tokenUsage) {
        super(message);
        this.name = "ModelGenerationError";
        this.skillLoadingEvidence = skillLoadingEvidence;
        this.tokenUsage = tokenUsage;
    }
}
/** Narrow an unknown failure to WorkflowError. */
export function isWorkflowError(error) {
    return error instanceof WorkflowError;
}
/** Report whether an unknown failure is a provider usage-limit checkpoint condition. */
export function isProviderUsageLimit(error) {
    return isWorkflowError(error) && error.code === WorkflowErrorCode.PROVIDER_USAGE_LIMIT;
}
/**
 * Detect a provider subscription/usage/quota/rate-limit exhaustion from free-form
 * error text, and extract the provider's human reset hint when present.
 *
 * The pi SDK does NOT throw these — it records them as an assistant message with
 * stopReason "error" and an errorMessage like "Codex usage limit reached (plus
 * plan). Resets in ~3h.". Callers reading message metadata MUST gate on
 * stopReason === "error" before trusting this, so a task whose own output merely
 * mentions "rate limit" is never misclassified. Patterns mirror the SDK's own
 * non-retryable-limit table. Deliberately excludes transient overloaded/5xx
 * errors, which stay recoverable and keep retrying.
 */
export function classifyProviderLimit(text) {
    if (!text)
        return { matched: false };
    const matched = /usage limit|limit reached|insufficient[_\s]?quota|quota exceeded|exceeded your current quota|out of budget|available balance|\bquota\b|rate.?limit|too many requests|\b429\b|GoUsageLimitError|FreeUsageLimitError|\bbilling\b/i.test(text);
    if (!matched)
        return { matched: false };
    const reset = text.match(/resets?\s+(?:in|at)\s+[^.\n]+/i);
    return { matched: true, resetHint: reset?.[0]?.trim() };
}
/** Recognize abort-like Error messages without assuming a provider-specific class. */
export function isAbortError(error) {
    if (!(error instanceof Error))
        return false;
    return /\babort(?:ed)?\b/i.test(error.message);
}
/** Recognize timeout-like errors by name or message. */
export function isTimeoutError(error) {
    if (!(error instanceof Error))
        return false;
    return /\btimeout\b/i.test(error.message) || error.name === "TimeoutError";
}
/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export function wrapError(error, context) {
    if (isWorkflowError(error))
        return error;
    if (isAbortError(error)) {
        return new WorkflowError(error instanceof Error ? error.message : "Workflow was aborted", WorkflowErrorCode.WORKFLOW_ABORTED, { recoverable: true });
    }
    if (isTimeoutError(error)) {
        return new WorkflowError(error instanceof Error ? error.message : "Agent timed out", WorkflowErrorCode.AGENT_TIMEOUT, { recoverable: true, agentLabel: context?.agentLabel });
    }
    // Defense-in-depth: today the SDK buries provider usage/quota limits in an
    // assistant message (detected in agent.ts), but a future SDK might throw them.
    // Classify a thrown limit here too — recoverable:false so the run checkpoints
    // (paused) instead of being retried into the same wall or silently nulled.
    if (error instanceof Error) {
        const limit = classifyProviderLimit(error.message);
        if (limit.matched) {
            return new WorkflowError(error.message, WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
                recoverable: false,
                agentLabel: context?.agentLabel,
                resetHint: limit.resetHint,
            });
        }
    }
    return new WorkflowError(error instanceof Error ? error.message : String(error), WorkflowErrorCode.AGENT_EXECUTION_ERROR, { recoverable: true, agentLabel: context?.agentLabel, details: error });
}
