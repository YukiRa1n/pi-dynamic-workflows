/** Package-relative generated context-measurement artifact. */
export declare const WORKFLOW_CONTEXT_MEASUREMENT_PATH = "docs/workflow-context-surfaces.json";
/** Canonical task profiles used for stable byte-based on-demand context measurements. */
export declare const WORKFLOW_AUTHORING_PROFILES: readonly [{
    readonly name: "write";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/pattern-selection.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/fan-out-and-synthesize.js", "skills/workflow-authoring/examples/structured-output.js"];
}, {
    readonly name: "edit";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/lifecycle.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/phased-budgets.js", "skills/workflow-authoring/examples/saved-nested-workflows.js"];
}, {
    readonly name: "review";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/review.md", "skills/workflow-authoring/references/quality-helpers.md", "skills/workflow-authoring/examples/adversarial-verification.js"];
}, {
    readonly name: "debug";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/debugging.md", "skills/workflow-authoring/references/specialized-helpers.md", "skills/workflow-authoring/examples/validated-gate.js"];
}, {
    readonly name: "loop";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/pattern-selection.md", "skills/workflow-authoring/references/lifecycle.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/loop-until-done.js", "skills/workflow-authoring/examples/structured-output.js"];
}, {
    readonly name: "retry";
    readonly files: readonly ["skills/workflow-authoring/SKILL.md", "skills/workflow-authoring/references/runtime.md", "skills/workflow-authoring/references/retry-helper.md", "skills/workflow-authoring/references/focused-recipes.md", "skills/workflow-authoring/examples/bounded-semantic-retry.js", "skills/workflow-authoring/examples/structured-output.js"];
}];
interface ByteSurface {
    serialization: string;
    bytes: number;
}
/** One registered skill's always-on discovery-entry byte cost. */
export interface SkillDiscoverySurface extends ByteSurface {
    root: string;
}
export interface ToolDefinitionSurface extends ByteSurface {
    name: string;
}
/** Versioned byte measurements for always-on, discovery, corpus, and representative authoring surfaces. */
export interface WorkflowContextMeasurement {
    formatVersion: 7;
    encoding: "utf8";
    sources: ["src/workflow-tool.ts", "src/workflow-editor.ts", "skills/workflow-authoring", "package.json#pi.skills"];
    surfaces: {
        /** Stable Pi system-prompt contribution from the workflow tool. */
        permanentWorkflowPrompt: ByteSurface;
        /** Stable provider definition for the single start-only workflow tool. */
        providerVisibleWorkflowToolDefinition: ByteSurface;
        /** Workflow definitions present on every ordinary turn. */
        providerVisibleAlwaysOnToolDefinitions: ByteSurface & {
            tools: ToolDefinitionSurface[];
        };
        /** Package-owned suffix appended by heuristic workflow arming. */
        armedWorkflowPromptRewrite: ByteSurface;
        /** Package-owned suffix appended by the explicit /workflows run command. */
        forcedWorkflowPromptRewrite: ByteSurface;
        /** Stable system-prompt and provider-tool bytes owned by the package. */
        stableWorkflowOwnedContext: ByteSurface;
        /** Stable bytes plus the suffix for one explicit workflow request. */
        explicitWorkflowRequestOwnedContext: ByteSurface;
        /**
         * Every skill this package registers (package.json's `pi.skills` — read
         * from disk, not hardcoded here) contributes an always-on discovery entry
         * (name + description) the model sees regardless of whether the skill is
         * ever loaded. This sums all of them, not just workflow-authoring, so a
         * new skill's always-on cost can't silently go untracked.
         */
        registeredSkillsDiscovery: ByteSurface & {
            skills: SkillDiscoverySurface[];
        };
        ordinaryWorkflowOwnedAlwaysOn: ByteSurface;
        workflowAuthoringSkillCorpus: ByteSurface & {
            files: number;
        };
        representativeAuthoringProfiles: {
            serialization: "sum of UTF-8 bytes for each profile's declared package-relative files";
            medianBytes: number;
            profiles: Array<{
                name: string;
                files: string[];
                bytes: number;
            }>;
        };
    };
}
/** Measures permanent, discovery, corpus, and canonical on-demand workflow context surfaces. */
export declare function measureWorkflowContextSurfaces(root?: string): WorkflowContextMeasurement;
/** Render the current measurement as deterministic formatted JSON. */
export declare function renderWorkflowContextMeasurement(): string;
/** Write the generated measurement under root and return the measured values. */
export declare function writeWorkflowContextMeasurement(root: string): WorkflowContextMeasurement;
/** Report whether committed or supplied measurement JSON matches current package bytes. */
export declare function checkWorkflowContextMeasurement(root: string, actual?: string): boolean;
export {};
