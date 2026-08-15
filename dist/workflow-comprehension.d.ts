import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { ComprehensionSuite, ComprehensionTaskKind } from "./enums.js";
import { type WorkflowRuntimeEvent } from "./workflow.js";
/** Re-exported scenario groups and authoring operations used by the optional comprehension CLI. */
export { ComprehensionSuite, ComprehensionTaskKind } from "./enums.js";
/** Prompt and expected authoring branch for one optional model scenario. */
export interface ComprehensionScenario {
    id: string;
    suite: ComprehensionSuite;
    kind: ComprehensionTaskKind;
    prompt: string;
}
/** Stable quick, core, and coverage scenarios available to provider and replay runs. */
export declare const COMPREHENSION_SCENARIOS: readonly ComprehensionScenario[];
/** Skill discovery and read calls observed while the parent model authored a workflow. */
export interface SkillLoadingEvidence {
    discovered: boolean;
    loaded: boolean;
    toolCalls: Array<{
        tool: string;
        path?: string;
    }>;
}
/** Provider-reported usage attached to one generated workflow. */
export interface ComprehensionTokenUsage {
    input: number;
    output: number;
    total: number;
    cost: number;
    cacheRead: number;
    cacheWrite: number;
}
/** Workflow source and generation evidence supplied to the deterministic replay seam. */
export interface ModelGeneration {
    workflow: string;
    skillLoadingEvidence: SkillLoadingEvidence;
    tokenUsage: ComprehensionTokenUsage;
}
/** Re-exported generation failure that retains loading and usage evidence. */
export { ModelGenerationError } from "./errors.js";
interface RuntimeCall {
    index: number;
    completedIndex: number | null;
    label: string;
    prompt: string;
    phase: string | null;
    structured: boolean;
    scenarioRole: "generator" | "filter" | null;
    status: "returned" | "null";
    result: unknown;
}
type RuntimeEvent = WorkflowRuntimeEvent & {
    index: number;
};
/** Exact requested and resolved model settings recorded for reproducible comparison. */
export interface ComprehensionModelSelection {
    requested: string;
    resolved: string;
    thinkingLevel: ModelThinkingLevel | null;
}
type ComprehensionFailureStage = "generation" | "parse" | "runtime" | "assertion";
/** Versioned evidence from one generated workflow executed against its scenario contract. */
export interface ComprehensionEvidence {
    formatVersion: 2;
    provider: string;
    modelSelection: ComprehensionModelSelection;
    extensionVersion: string;
    contractVersions: {
        format: string;
        content: string;
    };
    skillVersion: string;
    task: {
        id: string;
        suite: ComprehensionSuite;
        kind: ComprehensionTaskKind;
        prompt: string;
    };
    generatedWorkflow: string | null;
    skillLoadingEvidence: SkillLoadingEvidence;
    tokenUsage: ComprehensionTokenUsage | null;
    runtime: {
        calls: RuntimeCall[];
        events: RuntimeEvent[];
        topology: {
            maxConcurrent: number;
            phases: string[];
        };
        failures: Array<{
            callIndex: number;
            label: string;
            message: string;
            errorCode: string | null;
            recoverable: boolean | null;
        }>;
        result: unknown;
        assertions: Array<{
            name: string;
            passed: boolean;
            details: string;
        }>;
    };
    passed: boolean;
    failure: {
        stage: ComprehensionFailureStage;
        message: string;
        stack?: string;
    } | null;
}
interface RunComprehensionScenarioBaseOptions {
    scenario: ComprehensionScenario;
    provider: string;
    extensionVersion: string;
    contractVersions: {
        format: string;
        content: string;
    };
    skillVersion: string;
    generate: (scenario: ComprehensionScenario) => Promise<ModelGeneration>;
}
/** Dependencies and version facts needed to generate and execute one comprehension scenario. */
export type RunComprehensionScenarioOptions = RunComprehensionScenarioBaseOptions & ({
    modelSelection: ComprehensionModelSelection;
    model?: never;
} | {
    /** @deprecated Use modelSelection. Retained for provider-free callers created before evidence format 2. */
    model: string;
    modelSelection?: never;
});
/** Select scenarios in stable declaration order for one suite. */
export declare function selectComprehensionScenarios(suite: ComprehensionSuite | `${ComprehensionSuite}`): readonly ComprehensionScenario[];
/** Generate, parse, execute, and behaviorally score one scenario without making scoring-stage provider calls. */
export declare function runComprehensionScenario(options: RunComprehensionScenarioOptions): Promise<ComprehensionEvidence>;
