/**
 * Deep research workflow.
 * Built-in workflow for comprehensive research across multiple sources.
 */
export interface DeepResearchConfig {
    /** Number of distinct search angles/queries to explore. */
    angles: number;
    /** Minimum distinct sources required for a claim to survive cross-checking. */
    minSupport: number;
}
/**
 * Generate a deep-research workflow that uses the real web_search/web_fetch tools.
 *
 * The script is static and reads its inputs from `args` (question/angles/minSupport),
 * so the question is never string-interpolated into source — no escaping hazards.
 * Inject the web tools at run time via the agent's `tools` option.
 */
export declare function generateDeepResearchWorkflow(): string;
/**
 * Generate a codebase audit workflow.
 *
 * `scope` and each `checks` entry are user-supplied strings that get baked
 * directly into the generated script's source (unlike the runtime-args-driven
 * generators above), so every one is embedded via JSON.stringify — a proper JS
 * string literal that can't be broken out of by a quote, backslash, or
 * backtick in the value. Only the human-readable `meta.description` is
 * truncated for display; the operative `scope` used by the agents is always
 * the full, untruncated value.
 */
export declare function generateCodebaseAuditWorkflow(scope: string, checks: string[]): string;
