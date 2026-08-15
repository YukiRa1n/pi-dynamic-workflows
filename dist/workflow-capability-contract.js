import packageJson from "../package.json" with { type: "json" };
import { CapabilityClassification, CapabilityOrigin, CapabilitySupport, DiagnosticSeverity, DiscoveryPlacement, } from "./enums.js";
import { WorkflowCapabilityContractError } from "./errors.js";
/** Re-exported capability domains used by contract consumers. */
export { CapabilityClassification, CapabilityOrigin, CapabilitySupport, DiagnosticSeverity, DiscoveryPlacement, } from "./enums.js";
/** Re-exported contract failure type retained for existing consumers. */
export { WorkflowCapabilityContractError } from "./errors.js";
const REFERENCE_PATH = "skills/workflow-authoring/references/capability-details.md";
const PRESENT_AT = { kind: "present-at", version: packageJson.version };
const noOptions = [];
const option = (name, type, optional, defaultValue = null, constraints = noOptions, dynamicReference = null) => ({ name, type, optional, default: defaultValue, constraints, dynamicReference });
const AGENT_OPTIONS = {
    id: "agent-options",
    options: [
        option("label", "string", true, "derived from phase and call count"),
        option("phase", "string", true, "current phase"),
        option("schema", "plain JSON Schema", true),
        option("model", "string", true, null, ["highest-priority exact model selector"]),
        option("tier", "string", true, null, ["configured route name"], "model-routes"),
        option("isolation", '"worktree"', true),
        option("agentType", "string", true, null, ["must come from provided context"], "agent-types"),
        option("timeoutMs", "number | null", true, "run timeout; null disables"),
        option("retries", "number", true, "run retry count", ["finite values are floored and clamped to 0..3"]),
    ],
};
const CHECKPOINT_OPTIONS = {
    id: "checkpoint-options",
    options: [
        option("default", "unknown", true, "true when no UI and omitted"),
        option("headless", '"default" | "abort"', true, '"default"'),
        option("kind", '"confirm" | "input" | "select"', true, '"confirm"'),
        option("choices", "string[]", true),
        option("timeoutMs", "number", true),
    ],
};
const PHASE_OPTIONS = {
    id: "phase-options",
    options: [option("budget", "number", true, null, ["positive soft pre-call token gate"])],
};
const VERIFY_OPTIONS = {
    id: "verify-options",
    options: [
        option("reviewers", "number", true, "2", ["authors should provide a finite integer; runtime clamps below 1"]),
        option("threshold", "number", true, "0.5"),
        option("lens", "string | string[]", true),
    ],
};
const JUDGE_PANEL_OPTIONS = {
    id: "judge-panel-options",
    options: [
        option("judges", "number", true, "3", ["authors should provide a finite integer; runtime clamps below 1"]),
        option("rubric", "string", true, '"overall quality and correctness"'),
    ],
};
const LOOP_UNTIL_DRY_OPTIONS = {
    id: "loop-until-dry-options",
    options: [
        option("round", "(roundIndex: number) => unknown[] | Promise<unknown[]>", false),
        option("key", "(item: unknown) => string", true, "JSON.stringify"),
        option("consecutiveEmpty", "number", true, "2", [
            "authors should provide a finite integer; runtime clamps below 1",
        ]),
        option("maxRounds", "number", true, "50", ["authors should provide a finite positive integer"]),
    ],
};
const RETRY_OPTIONS = {
    id: "retry-options",
    options: [
        option("attempts", "number", true, "3", [
            "authors must provide a finite integer; runtime clamps values below 1 to 1",
        ]),
        option("until", "(result: unknown) => boolean", true, "accept first result when omitted", [
            "must be synchronous; use gate for asynchronous validation",
        ]),
    ],
};
const GATE_OPTIONS = {
    id: "gate-options",
    options: [
        option("attempts", "number", true, "3", [
            "authors must provide a finite integer; runtime clamps values below 1 to 1",
        ]),
    ],
};
const runtimeGlobal = (name, options = {}) => ({
    id: `workflow.runtime.${name}`,
    label: name,
    classification: CapabilityClassification.RUNTIME_GLOBAL,
    support: options.support ?? CapabilitySupport.SUPPORTED,
    discovery: options.discovery ?? DiscoveryPlacement.COMPACT_GUIDANCE,
    origin: CapabilityOrigin.PROJECT,
    lifecycle: PRESENT_AT,
    signature: options.signature ?? name,
    optionShape: options.optionShape ?? null,
    constraints: options.constraints ?? noOptions,
    enforcementOwner: "runWorkflow context assembly",
    runtimeBinding: {
        global: name,
        implementation: name,
        ...(options.allowsUndefined ? { allowsUndefined: true } : {}),
    },
    behaviorEvidence: options.evidence ?? ["tests/workflow-runtime.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: name.toLowerCase() },
    dynamicReference: null,
});
const toolInput = (name, signature, constraints = noOptions) => ({
    id: `workflow.tool-input.${name}`,
    label: name,
    classification: CapabilityClassification.WORKFLOW_TOOL_INPUT,
    support: CapabilitySupport.SUPPORTED,
    discovery: DiscoveryPlacement.COMPACT_GUIDANCE,
    origin: CapabilityOrigin.TOOL_ADAPTER,
    lifecycle: PRESENT_AT,
    signature,
    optionShape: null,
    constraints,
    enforcementOwner: "workflowToolSchema and createWorkflowTool",
    runtimeBinding: null,
    behaviorEvidence: ["tests/workflow-tool.test.ts"],
    staticReference: { path: REFERENCE_PATH, anchor: `tool-input-${name.toLowerCase()}` },
    dynamicReference: null,
});
const capabilities = [
    runtimeGlobal("agent", {
        signature: "agent(prompt, options?) => Promise<string | structured value | null>",
        optionShape: "agent-options",
        constraints: [
            "recoverable failures return null after retries; nonrecoverable failures throw",
            "schema noncompliance after bounded structured-output repair is nonrecoverable and bypasses agent retries",
            "per-agent retries override invocation retries; retries are floored and clamped to 0..3",
            "resume replays only the longest unchanged prefix; the first miss and every later call execute live",
            "selector priority is explicit model > agentType model > tier > phase model > metadata model > implicit medium > session default",
            "an explicit model, agentType model, tier, or phase model that resolves to an unavailable model throws MODEL_NOT_FOUND naming the source (e.g. the tier and what it resolved to) instead of falling back",
            "only the implicit default medium tier (no explicit model, tier, agentType, or phase model requested) degrades to the session default when unavailable, logging a one-time run-visible warning instead of throwing",
            "worktree isolation is best-effort; failure logs that isolation was ignored and continues without an isolated working directory",
        ],
        evidence: ["tests/workflow-runtime.test.ts", "tests/agent-registry.test.ts", "tests/structured-output.test.ts"],
    }),
    runtimeGlobal("parallel", {
        signature: "parallel(thunks) => Promise<Array<unknown | null>>",
        constraints: [
            "requires functions rather than promises",
            "result order matches input order",
            "recoverable thunk failures become null; nonrecoverable failures throw",
        ],
    }),
    runtimeGlobal("pipeline", {
        signature: "pipeline(items, ...stages) => Promise<Array<unknown | null>>",
        constraints: [
            "items run concurrently while stages per item run sequentially",
            "each stage receives previousValue, originalItem, and zero-based index",
            "a null stage result is passed to the next stage; authors must guard missing coverage explicitly",
            "recoverable stage failures become null; nonrecoverable failures throw",
        ],
    }),
    runtimeGlobal("createTeam", {
        signature: "createTeam(name, options?) => AgentTeam",
        constraints: [
            "workflow-scoped peer messaging and shared task board",
            "team.spawn(specs) reuses the workflow agent scheduler and concurrency budget",
            "team calls rerun live on resume because mailbox/task side effects are not journaled",
        ],
        evidence: ["src/agent-team.ts", "tests/workflow-runtime.test.ts"],
    }),
    runtimeGlobal("workflow", {
        signature: "workflow(savedName, childArgs?) => Promise<unknown>",
        constraints: [
            "one nested level",
            "shares limiter, counters, token accounting, and store",
            "nested workflows do not reuse the parent resume journal",
        ],
        evidence: ["tests/workflow-saved.test.ts", "tests/shared-store.test.ts"],
    }),
    runtimeGlobal("verify", {
        signature: "verify(item: unknown, options?: { reviewers?: number; threshold?: number; lens?: string | string[] }) => Promise<{ real: boolean; realCount: number; total: number; votes: Array<{ real: boolean; reason?: string }> }>",
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        optionShape: "verify-options",
        constraints: [
            "reviewer failures are omitted; successful votes form the denominator in realCount / total",
            "threshold comparison is inclusive and real is false when no reviewer succeeds",
            "multiple lenses cycle across reviewers",
        ],
        evidence: ["tests/quality-stdlib.test.ts"],
    }),
    runtimeGlobal("judgePanel", {
        signature: "judgePanel(attempts: unknown[], options?: { judges?: number; rubric?: string }) => Promise<{ index: number; attempt: unknown; score: number; judgments: Array<{ score: number; reason?: string }> } | undefined>",
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        optionShape: "judge-panel-options",
        constraints: [
            "failed judgments are omitted and each candidate score averages successful judgments only",
            "a candidate with no successful judgments scores 0",
            "highest mean score wins with stable input index as the tie-break; empty input returns undefined",
        ],
        evidence: ["tests/quality-stdlib.test.ts"],
    }),
    runtimeGlobal("loopUntilDry", {
        signature: "loopUntilDry(options: { round: (roundIndex: number) => unknown[] | Promise<unknown[]>; key?: (item: unknown) => string; consecutiveEmpty?: number; maxRounds?: number }) => Promise<unknown[]>",
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        optionShape: "loop-until-dry-options",
        constraints: [
            "roundIndex is zero-based; null, non-array, or duplicate-only round results count as empty",
            "token-budget or agent-limit capacity exhaustion returns the accumulated partial array instead of throwing",
            "the returned array does not report whether termination came from dryness, maxRounds, or capacity exhaustion",
            "authors must retain failed-round identity and truthful termination state outside the helper",
        ],
        evidence: ["tests/quality-stdlib.test.ts"],
    }),
    runtimeGlobal("completenessCheck", {
        signature: "completenessCheck(taskArgs: unknown, results: unknown) => Promise<{ complete: boolean; missing?: string[] } | null>",
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        constraints: [
            "only the first 4,000 characters of serialized result evidence are sent to the critic",
            "missing is optional and recoverable critic failure returns null",
            "large evidence sets must be chunked or summarized before relying on the advisory verdict",
        ],
        evidence: ["tests/quality-stdlib.test.ts"],
    }),
    runtimeGlobal("retry", {
        signature: "retry(thunk: (attempt: number) => unknown | Promise<unknown>, options?: { attempts?: number; until?: (result: unknown) => boolean }) => Promise<unknown>",
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        optionShape: "retry-options",
        constraints: [
            "attempt is zero-based and attempts counts total thunk calls",
            "until is synchronous; returning a Promise is truthy and accepts the first result",
            "omitting until accepts the first result regardless of attempts",
            "stops when until(result) is true; exhaustion returns only the last result without attempt metadata",
            "authors must supply a finite attempts bound when overriding the default",
        ],
        evidence: ["tests/quality-stdlib.test.ts"],
    }),
    runtimeGlobal("gate", {
        signature: "gate(thunk: (feedback: string | undefined, attempt: number) => unknown | Promise<unknown>, validator: (value: unknown) => { ok: boolean; feedback?: string } | Promise<{ ok: boolean; feedback?: string }>, options?: { attempts?: number }) => Promise<{ ok: boolean; value: unknown; attempts: number }>",
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        optionShape: "gate-options",
        constraints: [
            "feedback is undefined on the first thunk call and then receives the previous validator feedback string",
            "attempt is zero-based for the thunk while the returned attempts count is one-based",
            "a value is accepted when the validator returns an object with a truthy ok property; a bare boolean is not accepted",
            "exhaustion returns ok false with the last value and the bounded attempts count",
            "authors must supply a finite attempts bound when overriding the default",
        ],
        evidence: ["tests/quality-stdlib.test.ts"],
    }),
    runtimeGlobal("checkpoint", {
        signature: "checkpoint(prompt, options?) => Promise<unknown>",
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        optionShape: "checkpoint-options",
        constraints: [
            "foreground confirm and headless behavior are implemented; input/select/timeout are declared-only",
            "consumes one agent slot and no tokens",
            "journaled answers replay only within an unchanged resume prefix",
        ],
        evidence: ["tests/checkpoint.test.ts"],
    }),
    runtimeGlobal("log", { signature: "log(message) => void" }),
    runtimeGlobal("deliver", {
        signature: "deliver(message) => Promise<void>",
        constraints: [
            "delivers a message into the host conversation when the host wired onDeliver; no-op otherwise",
        ],
    }),
    runtimeGlobal("phase", {
        signature: "phase(title, options?) => void",
        optionShape: "phase-options",
        constraints: ["phase budgets are soft pre-call gates"],
    }),
    runtimeGlobal("args", { signature: "args: unknown", allowsUndefined: true }),
    runtimeGlobal("cwd", { signature: "cwd: string" }),
    runtimeGlobal("process", { signature: "process: { cwd(): string }" }),
    runtimeGlobal("budget", {
        signature: "budget: { total, spent(), remaining() }",
        constraints: [
            "frozen view over shared soft token accounting",
            "spend accrues after agents finish, so in-flight work can overshoot",
            "nested workflows share the same accounting",
        ],
    }),
    runtimeGlobal("console", {
        signature: "console: { log, info, warn, error }",
        support: CapabilitySupport.COMPATIBILITY,
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        constraints: ["new workflows should use log()"],
    }),
    toolInput("script", "script?: string", ["required raw JavaScript workflow source unless `name` is given"]),
    toolInput("name", "name?: string", [
        "resolves a project/user saved workflow first, then one of the 5 built-in patterns",
        "mutually exclusive with resumeFromRunId",
    ]),
    toolInput("args", "args?: Record<string, unknown>", ["top-level JSON object; built-in workflows consume named fields"]),
    toolInput("background", "background?: boolean = true", [
        "background workflows are headless; use background false when checkpoint must show foreground confirmation",
    ]),
    toolInput("maxAgents", "maxAgents?: number = 1000", ["default, not a hard product maximum"]),
    toolInput("concurrency", "concurrency?: number", ["runtime clamps to 1..16"]),
    toolInput("agentRetries", "agentRetries?: number = configured value or 0", ["floored and clamped to 0..3"]),
    toolInput("agentTimeoutMs", "agentTimeoutMs?: number = configured default or unbounded"),
    toolInput("tokenBudget", "tokenBudget?: number = configured default or unlimited", [
        "soft pre-call gate; in-flight work can overshoot",
    ]),
    toolInput("resumeFromRunId", "resumeFromRunId?: string", [
        "resumes a prior incomplete run with an edited script",
        "unchanged positional agent calls replay from cache until the first changed or inserted call",
        "always runs in the background",
    ]),
    {
        id: "workflow.script.metadata",
        label: "export const meta",
        classification: CapabilityClassification.SCRIPT_CONTRACT,
        support: CapabilitySupport.SUPPORTED,
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        origin: CapabilityOrigin.PROJECT,
        lifecycle: PRESENT_AT,
        signature: "export const meta = { name: string, description: string, phases?: Array<{ title: string; detail?: string; model?: string }>, model?: string }",
        optionShape: null,
        constraints: [
            "must be the first statement",
            "name and description must be nonblank strings",
            "metadata must use literal values; expressions such as string concatenation and template interpolation are rejected",
            "the meta declaration is the only legal export because the remaining body executes inside an async function",
        ],
        enforcementOwner: "parseWorkflowScript",
        runtimeBinding: null,
        behaviorEvidence: ["tests/workflow-parser.test.ts"],
        staticReference: { path: REFERENCE_PATH, anchor: "metadata" },
        dynamicReference: null,
    },
    {
        id: "workflow.script.return-value",
        label: "workflow return value",
        classification: CapabilityClassification.SCRIPT_CONTRACT,
        support: CapabilitySupport.SUPPORTED,
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        origin: CapabilityOrigin.PROJECT,
        lifecycle: PRESENT_AT,
        signature: "return JSON-serializable data",
        optionShape: null,
        constraints: ["do not return functions, promises, cyclic objects, BigInt, or runtime handles"],
        enforcementOwner: "workflow tool result boundary",
        runtimeBinding: null,
        behaviorEvidence: ["tests/workflow-authoring-skill.test.ts", "tests/workflow-tool.test.ts"],
        staticReference: { path: REFERENCE_PATH, anchor: "return-value" },
        dynamicReference: null,
    },
    {
        id: "workflow.script.determinism",
        label: "deterministic script execution",
        classification: CapabilityClassification.SCRIPT_CONTRACT,
        support: CapabilitySupport.SUPPORTED,
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        origin: CapabilityOrigin.PROJECT,
        lifecycle: PRESENT_AT,
        signature: null,
        optionShape: null,
        constraints: [
            "Date.now(), Math.random(), and no-argument new Date() are unavailable",
            "pass timestamps and randomness through args",
        ],
        enforcementOwner: "parseWorkflowScript and VM determinism prelude",
        runtimeBinding: null,
        behaviorEvidence: ["tests/workflow-parser.test.ts", "tests/workflow-runtime.test.ts"],
        staticReference: { path: REFERENCE_PATH, anchor: "determinism" },
        dynamicReference: null,
    },
    {
        id: "workflow.compat.markdown-fences",
        label: "whole-script Markdown fence stripping",
        classification: CapabilityClassification.COMPATIBILITY_BEHAVIOR,
        support: CapabilitySupport.COMPATIBILITY,
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        origin: CapabilityOrigin.TOOL_ADAPTER,
        lifecycle: PRESENT_AT,
        signature: null,
        optionShape: null,
        constraints: ["accepted for compatibility but not recommended"],
        enforcementOwner: "normalizeWorkflowScript",
        runtimeBinding: null,
        behaviorEvidence: ["tests/workflow-tool.test.ts"],
        staticReference: { path: REFERENCE_PATH, anchor: "compatibility" },
        dynamicReference: null,
    },
    {
        id: "workflow.vm.realm-substrate",
        label: "VM realm JavaScript substrate",
        classification: CapabilityClassification.INTERNAL_SUBSTRATE,
        support: CapabilitySupport.INTERNAL,
        discovery: DiscoveryPlacement.NONE,
        origin: CapabilityOrigin.VM_REALM,
        lifecycle: PRESENT_AT,
        signature: null,
        optionShape: null,
        constraints: ["Node-version-dependent globals are not project-owned workflow API", "VM is not a security sandbox"],
        enforcementOwner: "node:vm",
        runtimeBinding: null,
        behaviorEvidence: ["tests/workflow-runtime.test.ts"],
        staticReference: null,
        dynamicReference: null,
    },
    {
        id: "workflow.dynamic.model-routes",
        label: "model routes",
        classification: CapabilityClassification.DYNAMIC_REFERENCE,
        support: CapabilitySupport.SUPPORTED,
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        origin: CapabilityOrigin.LIVE_CONFIGURATION,
        lifecycle: PRESENT_AT,
        signature: null,
        optionShape: null,
        constraints: ["live values must not be copied into static contract data"],
        enforcementOwner: "model-tier-config",
        runtimeBinding: null,
        behaviorEvidence: ["tests/workflows-models-command.test.ts"],
        staticReference: { path: REFERENCE_PATH, anchor: "model-routes" },
        dynamicReference: "model-routes",
    },
    {
        id: "workflow.dynamic.agent-types",
        label: "agent types",
        classification: CapabilityClassification.DYNAMIC_REFERENCE,
        support: CapabilitySupport.SUPPORTED,
        discovery: DiscoveryPlacement.WORKFLOW_AUTHORING_SKILL,
        origin: CapabilityOrigin.LIVE_CONFIGURATION,
        lifecycle: PRESENT_AT,
        signature: null,
        optionShape: null,
        constraints: ["live values must not be copied into static contract data"],
        enforcementOwner: "agent-registry",
        runtimeBinding: null,
        behaviorEvidence: ["tests/agent-registry.test.ts"],
        staticReference: { path: REFERENCE_PATH, anchor: "agent-types" },
        dynamicReference: "agent-types",
    },
];
/** Authoritative versioned inventory used by runtime assembly and every static projection. */
export const WORKFLOW_CAPABILITY_DEFINITION = {
    versions: {
        extension: packageJson.version,
        format: { kind: "present-at", version: "1.0.0" },
        content: PRESENT_AT,
    },
    optionShapes: [
        AGENT_OPTIONS,
        CHECKPOINT_OPTIONS,
        PHASE_OPTIONS,
        VERIFY_OPTIONS,
        JUDGE_PANEL_OPTIONS,
        LOOP_UNTIL_DRY_OPTIONS,
        RETRY_OPTIONS,
        GATE_OPTIONS,
    ],
    capabilities,
    dynamicReferences: [
        {
            id: "model-routes",
            owner: "model-tier-config",
            itemShape: "{ name: string; description?: string }",
            connection: "loadModelTierConfig",
        },
        {
            id: "agent-types",
            owner: "agent-registry",
            itemShape: "{ name: string; description?: string }",
            connection: "loadAgentRegistry",
        },
    ],
};
/** Validate and freeze a definition, throwing with diagnostics when its identities or references conflict. */
export function defineWorkflowCapabilityContract(definition) {
    deepFreeze(definition);
    const definitionDiagnostics = validateDefinition(definition);
    if (definitionDiagnostics.length > 0) {
        throw new WorkflowCapabilityContractError("invalid workflow capability definition", definitionDiagnostics);
    }
    const optionShapes = new Map(definition.optionShapes.map((shape) => [shape.id, shape]));
    const dynamicReferences = new Map(definition.dynamicReferences.map((reference) => [reference.id, reference]));
    const bindings = definition.capabilities.flatMap((capability) => capability.runtimeBinding ? [{ ...capability.runtimeBinding }] : []);
    const implementations = new Set(bindings.map((binding) => binding.implementation));
    const globals = new Set(bindings.map((binding) => binding.global));
    const diagnoseAlignment = (evidence) => {
        const diagnostics = [];
        if (evidence.suppliedImplementations) {
            for (const binding of bindings) {
                if (!Object.hasOwn(evidence.suppliedImplementations, binding.implementation) ||
                    (evidence.suppliedImplementations[binding.implementation] === undefined && !binding.allowsUndefined)) {
                    diagnostics.push({
                        code: "MISSING_RUNTIME_IMPLEMENTATION",
                        severity: DiagnosticSeverity.ERROR,
                        subject: binding.implementation,
                        message: `Declared workflow global "${binding.global}" has no supplied implementation "${binding.implementation}".`,
                    });
                }
            }
            for (const name of Object.keys(evidence.suppliedImplementations)) {
                if (!implementations.has(name)) {
                    diagnostics.push({
                        code: "UNDECLARED_RUNTIME_IMPLEMENTATION",
                        severity: DiagnosticSeverity.WARNING,
                        subject: name,
                        message: `Supplied runtime implementation "${name}" is undeclared and was ignored.`,
                    });
                }
            }
        }
        if (evidence.observedProjectGlobals) {
            const observed = new Set(evidence.observedProjectGlobals);
            for (const name of globals) {
                if (!observed.has(name)) {
                    diagnostics.push({
                        code: "DECLARED_GLOBAL_UNOBSERVED",
                        severity: DiagnosticSeverity.ERROR,
                        subject: name,
                        message: `Declared workflow global "${name}" was not observed in the assembled context.`,
                    });
                }
            }
            for (const name of observed) {
                if (!globals.has(name)) {
                    diagnostics.push({
                        code: "OBSERVED_GLOBAL_UNDECLARED",
                        severity: DiagnosticSeverity.ERROR,
                        subject: name,
                        message: `Observed project-owned workflow global "${name}" is undeclared.`,
                    });
                }
            }
        }
        return diagnostics;
    };
    return {
        definition,
        assembleRuntimeBindings(supplied) {
            const diagnostics = diagnoseAlignment({ suppliedImplementations: supplied });
            const missing = diagnostics.filter((diagnostic) => diagnostic.code === "MISSING_RUNTIME_IMPLEMENTATION");
            if (missing.length > 0) {
                throw new WorkflowCapabilityContractError(`missing declared runtime implementation: ${missing.map((diagnostic) => diagnostic.subject).join(", ")}`, diagnostics);
            }
            const assembled = {};
            for (const binding of bindings)
                assembled[binding.global] = supplied[binding.implementation];
            return { globals: assembled, diagnostics };
        },
        projectStaticReferenceFacts() {
            return definition.capabilities
                .filter((capability) => capability.staticReference !== null)
                .map((capability) => ({
                id: capability.id,
                label: capability.label,
                classification: capability.classification,
                support: capability.support,
                signature: capability.signature,
                options: capability.optionShape ? (optionShapes.get(capability.optionShape) ?? null) : null,
                constraints: capability.constraints,
                reference: capability.staticReference
                    ? `${capability.staticReference.path}#${capability.staticReference.anchor}`
                    : null,
                dynamicReference: capability.dynamicReference
                    ? (dynamicReferences.get(capability.dynamicReference) ?? null)
                    : null,
            }));
        },
        diagnoseAlignment,
    };
}
function validateDefinition(definition) {
    const diagnostics = [];
    const ids = new Set();
    const globals = new Set();
    const runtimeImplementations = new Set();
    const optionShapes = new Set();
    const dynamicReferences = new Set();
    const invalid = (subject, message) => diagnostics.push({ code: "INVALID_CAPABILITY_DEFINITION", severity: DiagnosticSeverity.ERROR, subject, message });
    for (const shape of definition.optionShapes) {
        if (optionShapes.has(shape.id))
            invalid(shape.id, `Duplicate option shape "${shape.id}".`);
        optionShapes.add(shape.id);
    }
    for (const reference of definition.dynamicReferences) {
        if (dynamicReferences.has(reference.id))
            invalid(reference.id, `Duplicate dynamic reference "${reference.id}".`);
        dynamicReferences.add(reference.id);
    }
    for (const capability of definition.capabilities) {
        if (ids.has(capability.id))
            invalid(capability.id, `Duplicate capability id "${capability.id}".`);
        ids.add(capability.id);
        if (capability.classification === CapabilityClassification.RUNTIME_GLOBAL && !capability.runtimeBinding) {
            invalid(capability.id, "Runtime-global capabilities require a runtime binding.");
        }
        if (capability.runtimeBinding) {
            if (globals.has(capability.runtimeBinding.global)) {
                invalid(capability.runtimeBinding.global, `Duplicate runtime global "${capability.runtimeBinding.global}".`);
            }
            globals.add(capability.runtimeBinding.global);
            if (runtimeImplementations.has(capability.runtimeBinding.implementation)) {
                invalid(capability.runtimeBinding.implementation, `Duplicate runtime implementation identity "${capability.runtimeBinding.implementation}".`);
            }
            runtimeImplementations.add(capability.runtimeBinding.implementation);
            if (capability.classification !== CapabilityClassification.RUNTIME_GLOBAL ||
                capability.origin !== CapabilityOrigin.PROJECT) {
                invalid(capability.id, "Runtime bindings require runtime-global classification and project origin.");
            }
        }
        if (capability.optionShape && !optionShapes.has(capability.optionShape)) {
            invalid(capability.id, `Unknown option shape "${capability.optionShape}".`);
        }
        if (capability.dynamicReference && !dynamicReferences.has(capability.dynamicReference)) {
            invalid(capability.id, `Unknown dynamic reference "${capability.dynamicReference}".`);
        }
    }
    return diagnostics;
}
function deepFreeze(value) {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        for (const nested of Object.values(value))
            deepFreeze(nested);
        Object.freeze(value);
    }
    return value;
}
/** Installed validated workflow capability contract. */
export const WORKFLOW_CAPABILITY_CONTRACT = defineWorkflowCapabilityContract(WORKFLOW_CAPABILITY_DEFINITION);
