import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
export declare const THINKING_LEVELS: readonly ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export type ModelThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface ResolvedModelSpec {
    requestedSpec: string;
    model?: Model<Api>;
    thinkingLevel?: ModelThinkingLevel;
    resolvedSpec?: string;
    warning?: string;
    error?: string;
}
export declare function isThinkingLevel(value: string): value is ModelThinkingLevel;
export declare function formatModelSpecWithThinking(modelSpec: string, thinkingLevel: ModelThinkingLevel | undefined): string;
export declare function canonicalModelSpec(model: Model<Api>): string;
/**
 * Split a stored tier spec for display/editing. Exact known model specs win, so
 * model ids that legitimately contain colons are not mistaken for thinking.
 */
export declare function splitModelSpecThinking(spec: string | undefined, knownModelSpecs?: readonly string[]): {
    modelSpec: string;
    thinkingLevel?: ModelThinkingLevel;
};
/**
 * Resolve a workflow model-tier/agent model string with the same user-facing
 * grammar as Pi CLI `--model`: `provider/modelId[:thinking]`, bare model ids,
 * fuzzy patterns, and exact colon-containing model ids. This is a manual port of
 * pi-coding-agent's `resolveCliModel` (core/model-resolver.ts) — kept in sync by
 * the cross-check property test in tests/model-spec.test.ts, which runs both
 * implementations against the same fuzzed inputs and fails loudly the moment they
 * diverge (see that file for why we don't call pi's export directly: it requires
 * a real `ModelRuntime`, which has a private constructor pi doesn't expose a
 * lightweight adapter for).
 */
export declare function resolveModelSpecWithThinking(spec: string, modelRegistry: Pick<ModelRegistry, "getAll"> & Partial<Pick<ModelRegistry, "hasConfiguredAuth">>): ResolvedModelSpec;
