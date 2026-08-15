import { WorkflowReleaseDiagnosticCode } from "./enums.js";
import { type WorkflowAuthoringCoverageEntry } from "./workflow-authoring-coverage.js";
import { type CAPABILITY_PUBLICATION_PATHS } from "./workflow-authoring-reference.js";
import { type WorkflowCapabilityDefinition } from "./workflow-capability-contract.js";
/** Re-exported stable diagnostic codes for release automation. */
export { WorkflowReleaseDiagnosticCode } from "./enums.js";
/** One actionable release alignment error or warning. */
export interface WorkflowReleaseDiagnostic {
    code: WorkflowReleaseDiagnosticCode;
    severity: "error" | "warning";
    subject: string;
    message: string;
}
type PublicationPath = (typeof CAPABILITY_PUBLICATION_PATHS)[number];
/** Inputs and test overrides for the model-free workflow release gate. */
export interface WorkflowReleaseCheckOptions {
    root: string;
    definition?: WorkflowCapabilityDefinition;
    extensionVersion?: string;
    skillVersion?: string;
    publishableFiles: readonly string[];
    publicationOverrides?: Readonly<Partial<Record<PublicationPath, string>>>;
    contextMeasurement?: string;
    guidanceBaseline?: string;
    authoringCoverage?: readonly WorkflowAuthoringCoverageEntry[];
    guidanceOverrides?: Readonly<Record<string, string>>;
    /** Changed package paths from the release diff; enables source/dist surface checks. */
    changedFiles?: readonly string[];
}
/** Package-relative generated hash baseline for compact and detailed guidance. */
export declare const WORKFLOW_GUIDANCE_BASELINE_PATH = "docs/workflow-guidance-baseline.json";
/** Skill files that must be present in the publishable npm package. */
export declare const REQUIRED_WORKFLOW_PACKAGE_RESOURCES: readonly ["skills/workflow-authoring/SKILL.md", ...any[]];
/** Render deterministic hashes for provider-visible and on-demand guidance surfaces. */
export declare function renderWorkflowGuidanceBaseline(root: string): string;
/** Refresh the committed guidance hash baseline under root. */
export declare function writeWorkflowGuidanceBaseline(root: string): void;
/** Parse publishable paths from `npm pack --dry-run --json` without trusting external JSON shapes. */
export declare function parseNpmPackFilePaths(output: string): string[];
/** Return every model-free contract, package, documentation, and guidance alignment diagnostic. */
export declare function checkWorkflowRelease(options: WorkflowReleaseCheckOptions): WorkflowReleaseDiagnostic[];
