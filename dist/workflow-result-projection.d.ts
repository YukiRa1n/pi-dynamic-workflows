/** Default provider-visible projection size for a workflow's semantic result. */
export declare const DEFAULT_WORKFLOW_RESULT_CHARS = 12000;
/**
 * Build a bounded provider-visible projection of a workflow's semantic return
 * value. The complete value remains in the persisted run record. Strings are
 * the common final-report shape; structured returns are serialized
 * deterministically. Both the head and tail survive truncation so conclusions
 * and caveats at the end are not silently discarded.
 */
export declare function summarizeWorkflowResult(result: unknown, maxChars?: number): string;
