/**
 * Multi-angle parallel code review workflow.
 * 7 specialized finder agents → verify pass → ranked report.
 */
/**
 * Hard cap on diff characters fed into the review. This bounds worst-case
 * prompt size across 7 parallel finders + a per-candidate verify pass, even
 * when the diff-source exec step (see builtin-commands.ts) already raised its
 * own maxBuffer and successfully read a very large diff. Oversized diffs are
 * truncated rather than rejected — findings in the untruncated prefix still
 * have value — and the truncation is surfaced to the user, not silent.
 */
export declare const MAX_DIFF_CHARS = 200000;
/**
 * Generate a code-review workflow script.
 *
 * The workflow expects `args` to be passed with shape:
 *   { diff: string, diffSource: string }
 *
 * Model tier routing follows the spec:
 *   Finders A/B/C → medium (correctness)
 *   Finders D/E/F → small  (cleanup)
 *   Finder  G     → big    (altitude / abstraction)
 *   Synthesis     → big
 */
export declare function generateCodeReviewWorkflow(): string;
