/** Classifies a workflow capability by its runtime and documentation role. */
export var CapabilityClassification;
(function (CapabilityClassification) {
    CapabilityClassification["RUNTIME_GLOBAL"] = "runtime-global";
    CapabilityClassification["WORKFLOW_TOOL_INPUT"] = "workflow-tool-input";
    CapabilityClassification["SCRIPT_CONTRACT"] = "script-contract";
    CapabilityClassification["COMPATIBILITY_BEHAVIOR"] = "compatibility-behavior";
    CapabilityClassification["INTERNAL_SUBSTRATE"] = "internal-substrate";
    CapabilityClassification["DYNAMIC_REFERENCE"] = "dynamic-reference";
})(CapabilityClassification || (CapabilityClassification = {}));
/** Declares whether workflow authors should use a capability. */
export var CapabilitySupport;
(function (CapabilitySupport) {
    CapabilitySupport["SUPPORTED"] = "supported";
    CapabilitySupport["COMPATIBILITY"] = "compatibility";
    CapabilitySupport["INTERNAL"] = "internal";
})(CapabilitySupport || (CapabilitySupport = {}));
/** Identifies the model-visible surface responsible for discovery. */
export var DiscoveryPlacement;
(function (DiscoveryPlacement) {
    DiscoveryPlacement["COMPACT_GUIDANCE"] = "compact-guidance";
    DiscoveryPlacement["WORKFLOW_AUTHORING_SKILL"] = "workflow-authoring-skill";
    DiscoveryPlacement["NONE"] = "none";
})(DiscoveryPlacement || (DiscoveryPlacement = {}));
/** Names the subsystem that owns a capability's behavior. */
export var CapabilityOrigin;
(function (CapabilityOrigin) {
    CapabilityOrigin["PROJECT"] = "project";
    CapabilityOrigin["TOOL_ADAPTER"] = "tool-adapter";
    CapabilityOrigin["VM_REALM"] = "vm-realm";
    CapabilityOrigin["LIVE_CONFIGURATION"] = "live-configuration";
})(CapabilityOrigin || (CapabilityOrigin = {}));
/** Severity carried by capability-alignment diagnostics. */
export var DiagnosticSeverity;
(function (DiagnosticSeverity) {
    DiagnosticSeverity["ERROR"] = "error";
    DiagnosticSeverity["WARNING"] = "warning";
    DiagnosticSeverity["INFORMATION"] = "information";
})(DiagnosticSeverity || (DiagnosticSeverity = {}));
/** Optional model-comprehension scenario groups. */
export var ComprehensionSuite;
(function (ComprehensionSuite) {
    ComprehensionSuite["QUICK"] = "quick";
    ComprehensionSuite["FULL"] = "full";
    ComprehensionSuite["COVERAGE"] = "coverage";
})(ComprehensionSuite || (ComprehensionSuite = {}));
/** Authoring operation exercised by a comprehension scenario. */
export var ComprehensionTaskKind;
(function (ComprehensionTaskKind) {
    ComprehensionTaskKind["WRITE"] = "write";
    ComprehensionTaskKind["EDIT"] = "edit";
    ComprehensionTaskKind["REVIEW"] = "review";
    ComprehensionTaskKind["DEBUG"] = "debug";
})(ComprehensionTaskKind || (ComprehensionTaskKind = {}));
/** Whether authoring guidance may be optimized against behavioral evidence or must remain frozen. */
export var WorkflowAuthoringProtection;
(function (WorkflowAuthoringProtection) {
    WorkflowAuthoringProtection["BEHAVIORALLY_COVERED"] = "behaviorally-covered";
    WorkflowAuthoringProtection["GUIDANCE_FROZEN"] = "guidance-frozen";
})(WorkflowAuthoringProtection || (WorkflowAuthoringProtection = {}));
/** Machine-readable release-gate failure and warning domains. */
export var WorkflowReleaseDiagnosticCode;
(function (WorkflowReleaseDiagnosticCode) {
    WorkflowReleaseDiagnosticCode["INCOMPATIBLE_VERSION"] = "INCOMPATIBLE_VERSION";
    WorkflowReleaseDiagnosticCode["MISSING_BEHAVIOR_EVIDENCE"] = "MISSING_BEHAVIOR_EVIDENCE";
    WorkflowReleaseDiagnosticCode["UNRESOLVED_BEHAVIOR_EVIDENCE"] = "UNRESOLVED_BEHAVIOR_EVIDENCE";
    WorkflowReleaseDiagnosticCode["BROKEN_CONTRACT_REFERENCE"] = "BROKEN_CONTRACT_REFERENCE";
    WorkflowReleaseDiagnosticCode["MISSING_PACKAGE_RESOURCE"] = "MISSING_PACKAGE_RESOURCE";
    WorkflowReleaseDiagnosticCode["BROKEN_PACKAGE_LINK"] = "BROKEN_PACKAGE_LINK";
    WorkflowReleaseDiagnosticCode["STALE_GENERATED_SURFACE"] = "STALE_GENERATED_SURFACE";
    WorkflowReleaseDiagnosticCode["TOOL_INPUT_MISMATCH"] = "TOOL_INPUT_MISMATCH";
    WorkflowReleaseDiagnosticCode["RUNTIME_CONSTRAINT_DISAGREEMENT"] = "RUNTIME_CONSTRAINT_DISAGREEMENT";
    WorkflowReleaseDiagnosticCode["NON_CONTRACTUAL_PROSE_DRIFT"] = "NON_CONTRACTUAL_PROSE_DRIFT";
    WorkflowReleaseDiagnosticCode["MISSING_AUTHORING_COVERAGE"] = "MISSING_AUTHORING_COVERAGE";
    WorkflowReleaseDiagnosticCode["UNPROTECTED_AUTHORING_GUIDANCE"] = "UNPROTECTED_AUTHORING_GUIDANCE";
    WorkflowReleaseDiagnosticCode["PROTECTED_GUIDANCE_DRIFT"] = "PROTECTED_GUIDANCE_DRIFT";
    WorkflowReleaseDiagnosticCode["UNKNOWN_COMPREHENSION_SCENARIO"] = "UNKNOWN_COMPREHENSION_SCENARIO";
})(WorkflowReleaseDiagnosticCode || (WorkflowReleaseDiagnosticCode = {}));
