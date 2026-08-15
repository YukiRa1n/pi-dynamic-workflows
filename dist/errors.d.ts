/**
 * Workflow-specific error types.
 */
/** Dependency-neutral diagnostic payload retained by capability contract failures. */
export interface CapabilityErrorDiagnostic {
    code: string;
    severity: "error" | "warning" | "information";
    subject: string;
    message: string;
}
/** Dependency-neutral skill-loading payload retained by generation failures. */
export interface ModelGenerationSkillLoadingEvidence {
    discovered: boolean;
    loaded: boolean;
    toolCalls: Array<{
        tool: string;
        path?: string;
    }>;
}
/** Dependency-neutral provider-usage payload retained by generation failures. */
export interface ModelGenerationTokenUsage {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
}
/** Stable runtime and persistence failure codes exposed to callers and UI surfaces. */
export declare enum WorkflowErrorCode {
    /** Agent exceeded timeout. */
    AGENT_TIMEOUT = "AGENT_TIMEOUT",
    /** Workflow was aborted by user. */
    WORKFLOW_ABORTED = "WORKFLOW_ABORTED",
    /** Agent limit exceeded. */
    AGENT_LIMIT_EXCEEDED = "AGENT_LIMIT_EXCEEDED",
    /** Token budget exhausted. */
    TOKEN_BUDGET_EXHAUSTED = "TOKEN_BUDGET_EXHAUSTED",
    /**
     * The provider's subscription/usage/quota/rate limit was hit. Distinct from the
     * user's self-imposed TOKEN_BUDGET_EXHAUSTED: a provider limit refills on its own,
     * so the run is checkpointed (paused) and replayed by resume() rather than failed.
     */
    PROVIDER_USAGE_LIMIT = "PROVIDER_USAGE_LIMIT",
    /** Script validation failed. */
    SCRIPT_VALIDATION_ERROR = "SCRIPT_VALIDATION_ERROR",
    /** A schema agent never produced valid structured_output (after repair + extraction). */
    SCHEMA_NONCOMPLIANCE = "SCHEMA_NONCOMPLIANCE",
    /** A non-schema agent completed without any assistant text output. */
    AGENT_EMPTY_OUTPUT = "AGENT_EMPTY_OUTPUT",
    /**
     * An agent()'s `model`/`tier` spec did not resolve to any known model. Never
     * silently substituted for the session default — resolution is deterministic,
     * so retrying the same spec would fail identically every time.
     */
    MODEL_NOT_FOUND = "MODEL_NOT_FOUND",
    /** Agent execution failed. */
    AGENT_EXECUTION_ERROR = "AGENT_EXECUTION_ERROR",
    /** Run state persistence failed. */
    PERSISTENCE_ERROR = "PERSISTENCE_ERROR",
    /** Unknown error. */
    UNKNOWN = "UNKNOWN"
}
/** Classified workflow failure with recoverability and optional agent/provider context. */
export declare class WorkflowError extends Error {
    readonly code: WorkflowErrorCode;
    readonly recoverable: boolean;
    readonly agentLabel?: string;
    readonly details?: unknown;
    /** For PROVIDER_USAGE_LIMIT: the provider's human reset hint, e.g. "Resets in ~3h" (verbatim). */
    readonly resetHint?: string;
    constructor(message: string, code: WorkflowErrorCode, options?: {
        recoverable?: boolean;
        agentLabel?: string;
        details?: unknown;
        resetHint?: string;
    });
}
/** Contract failure that retains every definition or assembly diagnostic. */
export declare class WorkflowCapabilityContractError extends Error {
    readonly diagnostics: readonly CapabilityErrorDiagnostic[];
    constructor(message: string, diagnostics: readonly CapabilityErrorDiagnostic[]);
}
/** Generation failure that retains loading and token evidence for diagnosis. */
export declare class ModelGenerationError extends Error {
    readonly skillLoadingEvidence: ModelGenerationSkillLoadingEvidence;
    readonly tokenUsage: ModelGenerationTokenUsage;
    constructor(message: string, skillLoadingEvidence: ModelGenerationSkillLoadingEvidence, tokenUsage: ModelGenerationTokenUsage);
}
/** Narrow an unknown failure to WorkflowError. */
export declare function isWorkflowError(error: unknown): error is WorkflowError;
/** Report whether an unknown failure is a provider usage-limit checkpoint condition. */
export declare function isProviderUsageLimit(error: unknown): error is WorkflowError;
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
export declare function classifyProviderLimit(text: string | undefined): {
    matched: boolean;
    resetHint?: string;
};
/** Recognize abort-like Error messages without assuming a provider-specific class. */
export declare function isAbortError(error: unknown): boolean;
/** Recognize timeout-like errors by name or message. */
export declare function isTimeoutError(error: unknown): boolean;
/**
 * Wrap an unknown error into a WorkflowError with appropriate classification.
 */
export declare function wrapError(error: unknown, context?: {
    agentLabel?: string;
}): WorkflowError;
