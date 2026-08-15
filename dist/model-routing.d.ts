/**
 * Per-stage model routing for workflows.
 * Allows different phases to use different models.
 */
export interface ModelRoute {
    /** Phase name pattern (regex or exact match). */
    phasePattern: string;
    /** Model to use for this phase. */
    model: string;
    /** Whether to use regex matching. */
    useRegex?: boolean;
}
export interface ModelRoutingConfig {
    /** Default model for all phases. */
    defaultModel?: string;
    /** Per-phase model overrides. */
    routes: ModelRoute[];
}
/**
 * Resolve which model to use for a given phase.
 */
export declare function resolveModelForPhase(phase: string | undefined, config: ModelRoutingConfig): string | undefined;
/**
 * Parse model routing from workflow meta: per-phase models from meta.phases[].model
 * and a top-level default from meta.model (used when no phase route matches).
 */
export declare function parseModelRoutingFromMeta(phases?: Array<{
    title: string;
    model?: string;
}>, defaultModel?: string): ModelRoutingConfig;
