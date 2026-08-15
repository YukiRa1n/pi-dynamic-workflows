/** A reviewed frozen-guidance hash transition recorded in the coverage manifest. */
export interface WorkflowGuidanceAcceptance {
    path: string;
    previousSha256: string;
    sha256: string;
    changed: boolean;
}
/**
 * Accepts reviewed changes to explicitly named frozen workflow-authoring files.
 *
 * Throws before writing when no path is supplied, a path is not frozen, a file
 * is missing, or the coverage manifest no longer contains the expected entry.
 */
export declare function acceptWorkflowGuidance(root: string, requestedPaths: readonly string[]): WorkflowGuidanceAcceptance[];
