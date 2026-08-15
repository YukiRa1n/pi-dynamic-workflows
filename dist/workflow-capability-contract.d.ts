import { CapabilityClassification, CapabilityOrigin, CapabilitySupport, DiagnosticSeverity, DiscoveryPlacement } from "./enums.js";
/** Re-exported capability domains used by contract consumers. */
export { CapabilityClassification, CapabilityOrigin, CapabilitySupport, DiagnosticSeverity, DiscoveryPlacement, } from "./enums.js";
/** Version marker for behavior present at or after a release. */
export interface PresentAtVersion {
    kind: "present-at";
    version: string;
}
/** One named option and the facts safe to publish about it. */
export interface OptionDescriptor {
    name: string;
    type: string;
    optional: boolean;
    default: string | null;
    constraints: readonly string[];
    dynamicReference: "model-routes" | "agent-types" | null;
}
/** Reusable option group referenced by capability descriptors. */
export interface OptionShape {
    id: "agent-options" | "checkpoint-options" | "phase-options" | "verify-options" | "judge-panel-options" | "loop-until-dry-options" | "retry-options" | "gate-options";
    options: readonly OptionDescriptor[];
}
/** Authoritative declaration of one workflow capability and its evidence. */
export interface CapabilityDescriptor {
    id: `workflow.${string}`;
    label: string;
    classification: CapabilityClassification;
    support: CapabilitySupport;
    discovery: DiscoveryPlacement;
    origin: CapabilityOrigin;
    lifecycle: PresentAtVersion;
    signature: string | null;
    optionShape: OptionShape["id"] | null;
    constraints: readonly string[];
    enforcementOwner: string;
    runtimeBinding: {
        global: string;
        implementation: string;
        allowsUndefined?: true;
    } | null;
    behaviorEvidence: readonly string[];
    staticReference: {
        path: string;
        anchor: string;
    } | null;
    dynamicReference: "model-routes" | "agent-types" | null;
}
/** Ownership and item shape for a live catalogue that static docs must not embed. */
export interface DynamicReferenceDescriptor {
    id: "model-routes" | "agent-types";
    owner: "model-tier-config" | "agent-registry";
    itemShape: string;
    connection: string;
    items?: never;
}
/** Versioned plain-data source for runtime assembly and generated documentation. */
export interface WorkflowCapabilityDefinition {
    versions: {
        extension: string;
        format: PresentAtVersion;
        content: PresentAtVersion;
    };
    optionShapes: readonly OptionShape[];
    capabilities: readonly CapabilityDescriptor[];
    dynamicReferences: readonly DynamicReferenceDescriptor[];
}
/** Machine-readable disagreement between the contract and an observed surface. */
export interface CapabilityDiagnostic {
    code: "MISSING_RUNTIME_IMPLEMENTATION" | "UNDECLARED_RUNTIME_IMPLEMENTATION" | "DECLARED_GLOBAL_UNOBSERVED" | "OBSERVED_GLOBAL_UNDECLARED" | "INVALID_CAPABILITY_DEFINITION";
    severity: DiagnosticSeverity;
    subject: string;
    message: string;
}
/** Re-exported contract failure type retained for existing consumers. */
export { WorkflowCapabilityContractError } from "./errors.js";
/** Runtime globals assembled from declared implementations plus non-fatal diagnostics. */
export interface RuntimeBindingAssembly {
    globals: Readonly<Record<string, unknown>>;
    diagnostics: readonly CapabilityDiagnostic[];
}
/** Project-owned implementations required to assemble the workflow VM context. */
export interface WorkflowRuntimeImplementations {
    agent: unknown;
    parallel: unknown;
    pipeline: unknown;
    createTeam: unknown;
    workflow: unknown;
    verify: unknown;
    judgePanel: unknown;
    loopUntilDry: unknown;
    completenessCheck: unknown;
    retry: unknown;
    gate: unknown;
    checkpoint: unknown;
    deliver: unknown;
    log: unknown;
    phase: unknown;
    args: unknown;
    cwd: unknown;
    process: unknown;
    budget: unknown;
    console: unknown;
}
/** Exact static projection of one capability for generated references. */
export interface StaticCapabilityFact {
    id: string;
    label: string;
    classification: CapabilityClassification;
    support: CapabilitySupport;
    signature: string | null;
    options: OptionShape | null;
    constraints: readonly string[];
    reference: string | null;
    dynamicReference: DynamicReferenceDescriptor | null;
}
/** Runtime implementations or observed globals used for drift diagnostics. */
export interface AlignmentEvidence {
    suppliedImplementations?: Readonly<Record<string, unknown>>;
    observedProjectGlobals?: readonly string[];
}
/** Validated capability contract with runtime, publication, and alignment projections. */
export interface WorkflowCapabilityContract {
    readonly definition: WorkflowCapabilityDefinition;
    assembleRuntimeBindings(implementations: Readonly<Record<string, unknown>>): RuntimeBindingAssembly;
    projectStaticReferenceFacts(): readonly StaticCapabilityFact[];
    diagnoseAlignment(evidence: AlignmentEvidence): readonly CapabilityDiagnostic[];
}
/** Authoritative versioned inventory used by runtime assembly and every static projection. */
export declare const WORKFLOW_CAPABILITY_DEFINITION: WorkflowCapabilityDefinition;
/** Validate and freeze a definition, throwing with diagnostics when its identities or references conflict. */
export declare function defineWorkflowCapabilityContract(definition: WorkflowCapabilityDefinition): WorkflowCapabilityContract;
/** Installed validated workflow capability contract. */
export declare const WORKFLOW_CAPABILITY_CONTRACT: WorkflowCapabilityContract;
