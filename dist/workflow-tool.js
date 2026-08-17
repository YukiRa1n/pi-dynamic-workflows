import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BUILTIN_WORKFLOW_NAMES, findBuiltinWorkflow, resolveWorkflowInvocation } from "./builtin-workflows.js";
import { MAX_WORKFLOW_TIMEOUT_MS } from "./config.js";
import { renderWorkflowText } from "./display.js";
import { WorkflowError, WorkflowErrorCode } from "./errors.js";
import { parseWorkflowScript } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";
// Matches the runtime/persistence ceiling in workflow.ts and run-persistence.ts
// (10_000_000), so the tool does not accept a script the runner will then reject.
const MAX_WORKFLOW_SCRIPT_BYTES = 10_000_000;
const workflowToolSchema = Type.Object({
    script: Type.Optional(Type.String({
        description: "JavaScript workflow; omitted metadata is filled in. Use await agent('task', { label: 'id' }); call agent() at least once.",
    })),
    name: Type.Optional(Type.String({
        description: "Saved or built-in workflow name; this is not an existing run ID.",
    })),
    args: Type.Optional(
    // Must be an explicitly typed object schema, not Type.Any(). Type.Any()
    // compiles to a schema with no "type" keyword at all (just
    // `{ description }`), and at least one MCP/tool-calling bridge observed
    // in the wild does not treat a typeless property as "accept any JSON
    // value" — it coerces/flattens it before the handler ever sees it, so
    // `args.scope` (etc.) arrives as `undefined` and every built-in pattern
    // that requires an args field fails validation regardless of what the
    // caller actually sent. Every built-in pattern's `args` is a JSON object
    // at the top level, so declaring `type: "object"` is lossless and fixes
    // the coercion. Type.Unsafe keeps the emitted schema minimal (no
    // `properties`/`additionalProperties` boilerplate — JSON Schema already
    // allows additional properties by default) to stay inside the
    // provider-visible tool definition's byte budget.
    Type.Unsafe({
        type: "object",
        description: "Arguments for a named workflow.",
    })),
    maxAgents: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 1000,
        description: "Maximum agent() calls.",
    })),
    concurrency: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 16,
        description: "Maximum concurrent calls.",
    })),
    agentRetries: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 3,
        description: "Retries per agent() call.",
    })),
    agentTimeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Per-call timeout (ms).",
    })),
    workflowTimeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: MAX_WORKFLOW_TIMEOUT_MS,
        description: "Workflow timeout (ms).",
    })),
    tokenBudget: Type.Optional(Type.Integer({
        minimum: 1,
        description: "User-requested soft cap; omit otherwise.",
    })),
    resumeFromRunId: Type.Optional(Type.String({
        description: "Resume a run with an edited script; cached prefix calls replay.",
    })),
}, { additionalProperties: false });
/**
 * The model-facing Pi contract is intentionally smaller than the library
 * execution API. Limits and replay are useful to embedders that already own
 * policy, but exposing them to a general model turns optional implementation
 * knobs into invented plans. Keep this schema beside the full schema so the
 * public extension surface can opt into the small contract without losing
 * backwards compatibility for programmatic callers.
 */
const modelFacingWorkflowToolSchema = Type.Object({
    script: Type.Optional(Type.String({
        description: "JavaScript using agent(); omit when using preset.",
    })),
    preset: Type.Optional(Type.Unsafe({
        type: "string",
        enum: [...BUILTIN_WORKFLOW_NAMES],
        description: "Built-in workflow preset; use script for a custom workflow.",
    })),
    args: Type.Optional(Type.Unsafe({
        type: "object",
        description: "Arguments for the selected preset.",
    })),
}, {
    additionalProperties: false,
});
/** Compact library schema: retain saved-name lookup, without policy knobs. */
const workflowCompactToolSchema = Type.Unsafe({
    ...Type.Omit(workflowToolSchema, [
        "maxAgents",
        "concurrency",
        "agentRetries",
        "agentTimeoutMs",
        "workflowTimeoutMs",
        "tokenBudget",
        "resumeFromRunId",
    ]),
    additionalProperties: false,
});
export function createWorkflowTool(options = {}) {
    const fallbackCwd = options.cwd ?? process.cwd();
    const fallbackStorage = options.storage ?? createWorkflowStorage(fallbackCwd);
    const defaults = resolveWorkflowToolDefaults(options, fallbackCwd);
    const fallbackManager = options.manager ??
        new WorkflowManager({
            cwd: options.cwd,
            concurrency: defaults.concurrency,
            loadSavedWorkflow: (name) => fallbackStorage.load(name)?.script,
            defaultAgentTimeoutMs: defaults.agentTimeoutMs,
            defaultAgentRetries: defaults.agentRetries,
        });
    const getManager = () => options.getManager?.() ?? fallbackManager;
    const getStorage = () => options.getStorage?.() ?? fallbackStorage;
    const getCwd = () => options.getCwd?.() ?? fallbackCwd;
    const allowResume = options.allowResume ?? false;
    const exposeAdvancedParameters = options.exposeAdvancedParameters ?? true;
    const modelFacing = options.modelFacing ?? false;
    const parameters = (modelFacing
        ? modelFacingWorkflowToolSchema
        : exposeAdvancedParameters
            ? allowResume
                ? workflowToolSchema
                : Type.Omit(workflowToolSchema, ["resumeFromRunId"])
            : workflowCompactToolSchema);
    return defineTool({
        name: modelFacing ? "start_workflow" : "workflow",
        label: modelFacing ? "Start workflow" : "Workflow",
        description: modelFacing
            ? "Start a new background workflow only when the user requests multi-agent work. Use a script or preset; existing runs use /workflows."
            : allowResume
                ? "Run a saved/built-in or JavaScript workflow in the background; results return automatically. Use resumeFromRunId only to revise the same paused run."
                : "Start a new background workflow for an explicitly requested multi-agent task. Provide a saved name or JavaScript using agent(), parallel(), and pipeline(); results return automatically. Existing runs use /workflows.",
        parameters,
        prepareArguments(args) {
            return normalizeWorkflowToolArgs(args, allowResume, exposeAdvancedParameters, modelFacing);
        },
        async execute(_toolCallId, params) {
            const manager = getManager();
            const storage = getStorage();
            const cwd = getCwd();
            // `name` resolves through the same registry the built-in slash commands
            // and saved-workflow commands use (see builtin-workflows.ts /
            // workflow-saved.ts): a project/user saved workflow of that name wins on
            // a collision, else one of the 5 curated built-in patterns. This lets the
            // model reach a curated pattern by name instead of having to author an
            // equivalent script from scratch (and, for patterns that need it, the
            // right exec context — e.g. deep-research's web tools — travels with it).
            let invocationTools;
            let invocationToolset;
            let script;
            const invocationName = modelFacing ? params.preset : params.name;
            if (invocationName && params.script !== undefined) {
                if (typeof params.script !== "string") {
                    throw new Error(`workflow's \`script\` must be a string when provided alongside \`${modelFacing ? "preset" : "name"}\``);
                }
                throw new Error(`workflow accepts either \`${modelFacing ? "preset" : "name"}\` or \`script\`, not both`);
            }
            if (invocationName) {
                if (params.resumeFromRunId) {
                    throw new Error("workflow: `name` cannot be combined with `resumeFromRunId` — resume with an edited `script` instead.");
                }
                const resolved = modelFacing
                    ? findBuiltinWorkflow(invocationName)?.resolve(cwd, params.args)
                    : resolveWorkflowInvocation(invocationName, params.args, { storage, cwd });
                if (!resolved) {
                    throw new Error(`workflow: no saved or built-in workflow named "${invocationName}". Built-in names: ${BUILTIN_WORKFLOW_NAMES.join(", ")}.`);
                }
                script = normalizeWorkflowScript(resolved.script);
                invocationTools = resolved.tools;
                invocationToolset = resolved.toolset;
            }
            else {
                if (!params.script)
                    throw new Error(`workflow requires either \`script\` or \`${modelFacing ? "preset" : "name"}\``);
                script = normalizeWorkflowScript(params.script, modelFacing);
            }
            assertWorkflowScriptSize(script);
            const parsed = parseWorkflowScript(script);
            // Iteration / cached-prefix reuse: resume a prior run with THIS (edited)
            // script instead of creating a brand-new run. Unchanged agent() calls
            // replay from the prior run's journal; the first edited/new call and
            // everything after it re-run live. Always background (the resumed run is
            // detached and its result is delivered back into the conversation).
            if (params.resumeFromRunId) {
                const runId = params.resumeFromRunId;
                const resumed = await manager.resume(runId, { script, args: params.args });
                if (!resumed) {
                    throw new Error(resumeFailureText(manager, runId));
                }
                return {
                    content: [{ type: "text", text: resumedText(parsed.meta.name, runId) }],
                    details: { runId, background: true, resumedFrom: runId },
                    // Starting or resuming a detached run is the terminal action for this
                    // agent turn.  Do not rely on the model obeying prose such as "end
                    // this turn": without the runtime flag it can enter another provider
                    // cycle and immediately stop or replace the run it just created.
                    terminate: true,
                };
            }
            // Public tool invocations are always detached. This keeps one lifecycle,
            // delivery, acknowledgement, and context-projection path: the tool returns
            // a run ID immediately and the bounded terminal result is delivered later.
            const { runId } = manager.startInBackground(script, params.args, {
                maxAgents: params.maxAgents,
                concurrency: params.concurrency,
                agentRetries: params.agentRetries,
                agentTimeoutMs: params.agentTimeoutMs,
                workflowTimeoutMs: params.workflowTimeoutMs,
                tokenBudget: params.tokenBudget,
                tools: invocationTools,
                toolset: invocationToolset,
            });
            return {
                content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
                details: { runId, background: true },
                // The extension's start-only tool must let Pi consume the tool result
                // and produce a normal acknowledgement. It cannot mutate an existing
                // run, so the legacy library guard against a follow-up control action
                // is unnecessary here. Keep that guard for embedders using the broader
                // `workflow` tool to preserve their turn contract.
                ...(modelFacing ? {} : { terminate: true }),
            };
        },
        renderCall(_args, theme) {
            return new Text(theme.fg("toolTitle", theme.bold(modelFacing ? "start_workflow" : "workflow")), 0, 0);
        },
        renderResult(result, { isPartial }, theme) {
            const snapshot = result.details;
            if (snapshot?.name) {
                return new Text(renderWorkflowText(snapshot, !isPartial), 0, 0);
            }
            // Fallback: strip markdown syntax so the TUI doesn't display raw asterisks/hashes.
            // The `content` field is for the LLM (where markdown is preserved), but the TUI
            // renderer (Text component) shows text literally — so we strip markdown here.
            const text = result.content?.[0];
            const raw = text?.type === "text" ? text.text : theme.fg("muted", "workflow");
            const clean = raw
                .replace(/\*\*/g, "")
                .replace(/```[a-z]*\n/g, "")
                .replace(/```/g, "")
                .replace(/^##+\s*/gm, "")
                .trim();
            return new Text(clean || theme.fg("muted", "workflow"), 0, 0);
        },
    });
}
function resolveWorkflowToolDefaults(options, cwd) {
    const settings = loadWorkflowSettings({ cwd });
    return {
        agentTimeoutMs: options.defaultAgentTimeoutMs !== undefined
            ? options.defaultAgentTimeoutMs
            : (settings.defaultAgentTimeoutMs ?? null),
        concurrency: options.defaultConcurrency ?? options.concurrency ?? settings.defaultConcurrency,
        agentRetries: options.defaultAgentRetries ?? settings.defaultAgentRetries ?? 0,
    };
}
/** Compact acknowledgement for a detached workflow start. */
export function backgroundStartedText(name, runId) {
    return `Workflow "${name}" started in background (run ${runId}). Result returns automatically.`;
}
/**
 * One-line hint for iterating on a run with cached-prefix replay.
 */
export function reviseHint(runId) {
    if (!runId)
        return "";
    return `Revise run ${runId} with resumeFromRunId and an edited script; cached calls replay.`;
}
/**
 * Compact acknowledgement for resuming a run with an edited script.
 */
export function resumedText(name, runId) {
    return `Workflow "${name}" resumed (run ${runId}); cached prefix calls replay, later calls run live. Result returns automatically.`;
}
/**
 * Explain why a resumeFromRunId could not be resumed, so the model gets a clear
 * tool error instead of a silent failure. Inspects live + persisted state to
 * name the concrete reason (not found / running / completed / stopped).
 */
export function resumeFailureText(manager, runId) {
    const active = manager.getRun(runId);
    if (active?.status === "running") {
        return `Cannot resume workflow run "${runId}": it is still running. Wait for it to finish (or /workflows stop ${runId}) before resuming with an edited script.`;
    }
    const persisted = manager.getPersistence().load(runId);
    if (!persisted) {
        return `Cannot resume workflow run "${runId}": no run with that ID was found. Use the runId from a prior workflow result, or omit resumeFromRunId to start a new run.`;
    }
    if (persisted.status === "completed") {
        return `Cannot resume workflow run "${runId}": it already completed. Start a new run instead (omit resumeFromRunId).`;
    }
    if (persisted.status === "aborted" || active?.status === "aborted") {
        return `Cannot resume workflow run "${runId}": it was stopped/aborted and is not resumable. Start a new run instead (omit resumeFromRunId).`;
    }
    if (!persisted.script) {
        return `Cannot resume workflow run "${runId}": it has no persisted script to resume. Start a new run instead (omit resumeFromRunId).`;
    }
    return `Cannot resume workflow run "${runId}": it is not currently resumable (it may be busy under another process). Try again shortly, or start a new run.`;
}
const WORKFLOW_TOOL_KEYS = [
    "script",
    "name",
    "args",
    "maxAgents",
    "concurrency",
    "agentRetries",
    "agentTimeoutMs",
    "workflowTimeoutMs",
    "tokenBudget",
    "resumeFromRunId",
];
function normalizeWorkflowToolArgs(args, allowResume = true, exposeAdvancedParameters = true, modelFacing = false) {
    if (!args || typeof args !== "object")
        throw new Error(`workflow requires an object argument with a \`script\` string or a \`${modelFacing ? "preset" : "name"}\``);
    const value = args;
    if (!allowResume && Object.hasOwn(value, "resumeFromRunId")) {
        throw new Error("workflow starts a new run; use /workflows to control or resume an existing run");
    }
    if (Object.hasOwn(value, "background")) {
        throw new Error("workflow is background-only; omit the unsupported `background` argument");
    }
    const allowedKeys = new Set(modelFacing ? ["script", "preset", "args"] : ["script", "name", "args"]);
    if (exposeAdvancedParameters && !modelFacing) {
        for (const key of WORKFLOW_TOOL_KEYS)
            allowedKeys.add(key);
    }
    if (allowResume && exposeAdvancedParameters)
        allowedKeys.add("resumeFromRunId");
    const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(`workflow received unsupported field(s): ${unknownKeys.join(", ")}`);
    }
    // Finite, bounded domain checks (tool-api-types-006 / LIMIT-001): the schema
    // constrains these, but a defense-in-depth pass here rejects NaN/Infinity/
    // fractional/out-of-range values even if a caller bypasses validation.
    const validateInteger = (v, name, min, max) => {
        if (v === undefined || v === null)
            return undefined;
        if (typeof v !== "number" || !Number.isFinite(v) || !Number.isInteger(v)) {
            throw new Error(`workflow's \`${name}\` must be a finite integer`);
        }
        if (v < min || v > max) {
            throw new Error(`workflow's \`${name}\` must be between ${min} and ${max}`);
        }
        return v;
    };
    const normalized = { ...value };
    if (exposeAdvancedParameters && !modelFacing) {
        Object.assign(normalized, {
            maxAgents: validateInteger(value.maxAgents, "maxAgents", 1, 1000),
            concurrency: validateInteger(value.concurrency, "concurrency", 1, 16),
            agentRetries: validateInteger(value.agentRetries, "agentRetries", 0, 3),
            agentTimeoutMs: validateInteger(value.agentTimeoutMs, "agentTimeoutMs", 1, MAX_WORKFLOW_TIMEOUT_MS),
            workflowTimeoutMs: validateInteger(value.workflowTimeoutMs, "workflowTimeoutMs", 1, MAX_WORKFLOW_TIMEOUT_MS),
            tokenBudget: validateInteger(value.tokenBudget, "tokenBudget", 1, Number.MAX_SAFE_INTEGER),
        });
    }
    // `name` resolves a saved/built-in workflow at execute() time, so `script` is
    // optional here — but if `script` is present at all it must still be a
    // string (same requirement as the script-only path below), so a caller
    // passing a malformed `script` alongside `name` gets a clear error instead
    // of it being silently dropped.
    if (modelFacing) {
        const hasScript = typeof value.script === "string" && value.script.trim().length > 0;
        const hasPreset = typeof value.preset === "string" && value.preset.trim().length > 0;
        if (hasScript && hasPreset) {
            throw new Error("workflow accepts exactly one of `script` or `preset`");
        }
        if (value.preset !== undefined && (typeof value.preset !== "string" || !value.preset.trim())) {
            throw new Error("workflow's `preset` must be a non-empty built-in workflow name");
        }
        if (value.script !== undefined && typeof value.script !== "string") {
            throw new Error("workflow's `script` must be a string when provided alongside `preset`");
        }
        if (typeof value.preset === "string" &&
            value.preset.trim() &&
            !BUILTIN_WORKFLOW_NAMES.includes(value.preset.trim())) {
            throw new Error(`workflow's \`preset\` must be one of: ${BUILTIN_WORKFLOW_NAMES.join(", ")}`);
        }
        if (Object.hasOwn(value, "args") && !hasPreset) {
            throw new Error("workflow's `args` requires a `preset`");
        }
        if (hasScript || hasPreset) {
            return {
                ...normalized,
                ...(hasPreset ? { preset: value.preset.trim() } : {}),
                ...(hasScript ? { script: normalizeWorkflowScript(value.script, true) } : {}),
                // An empty/whitespace `script` is treated as "not provided" (hasScript=false);
                // drop it so a preset-only invocation does not trip the execute-time
                // "either preset or script" conflict on a leftover empty string.
                ...(!hasScript ? { script: undefined } : {}),
            };
        }
        throw new Error("workflow requires either `script` or `preset` to be a string");
    }
    if (typeof value.name === "string" && value.name.trim()) {
        if (value.script !== undefined && typeof value.script !== "string") {
            throw new Error("workflow's `script` must be a string when provided alongside `name`");
        }
        if (value.script !== undefined) {
            throw new Error("workflow accepts either `name` or `script`, not both");
        }
        return {
            ...normalized,
            name: value.name.trim(),
            script: undefined,
        };
    }
    if (typeof value.script !== "string")
        throw new Error("workflow requires either `script` or `name` to be a string");
    return {
        ...normalized,
        script: normalizeWorkflowScript(value.script, modelFacing),
    };
}
function normalizeWorkflowScript(script, fillMetadata = false) {
    let text = script.trim();
    const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
    if (fence)
        text = fence[1].trim();
    if (fillMetadata && !/^export\s+const\s+meta\s*=/.test(text) && !/\bexport\s+const\s+meta\s*=/.test(text)) {
        text = `export const meta = { name: "model_workflow", description: "Model-authored workflow" }\n${text}`;
    }
    assertWorkflowScriptSize(text);
    return text;
}
function assertWorkflowScriptSize(script) {
    const bytes = Buffer.byteLength(script, "utf8");
    if (bytes > MAX_WORKFLOW_SCRIPT_BYTES) {
        throw new WorkflowError(`Workflow script exceeds the ${MAX_WORKFLOW_SCRIPT_BYTES}-byte resource limit`, WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED, { recoverable: false });
    }
}
