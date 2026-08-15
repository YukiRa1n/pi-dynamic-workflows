import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BUILTIN_WORKFLOW_NAMES, resolveWorkflowInvocation } from "./builtin-workflows.js";
import { renderWorkflowText } from "./display.js";
import { parseWorkflowScript } from "./workflow.js";
import { WorkflowManager } from "./workflow-manager.js";
import { createWorkflowStorage } from "./workflow-saved.js";
import { loadWorkflowSettings } from "./workflow-settings.js";
/** The single always-on gate that authorizes workflow use without forcing it. */
export const WORKFLOW_GATE_GUIDELINE = "The `workflow` tool runs multi-agent orchestration — it fans decomposable work out across subagents, and fits tasks shaped like: repo-wide inspection, independent parallel research/checks, multi-perspective review, or fan-out/fan-in synthesis. ONLY call it when the user explicitly opts in — via the workflow trigger word, `/workflows run`, or their own words (e.g. 'run a workflow', 'fan this out', '并行审一遍'). For any other task — even one that would clearly benefit — do not call it; you may briefly offer it (with a rough cost) as an option instead.";
const workflowToolSchema = Type.Object({
    script: Type.Optional(Type.String({
        description: [
            "Raw JavaScript workflow script; no Markdown fences. Required unless `name` is given. First statement: export const meta = { name: 'short_snake_case', description: 'non-empty description' }. Add phases: [{ title: 'Phase' }] only when the workflow has named phases, and declare only phases it will use. For multiple phases, call phase('Exact Title') before work or set `phase` in agent options.",
            "Use await workflow(savedName, childArgs) to run a saved workflow inline; nesting is limited to one level and shares the parent run's concurrency, agent, and token limits. Optional quality helpers include verify(), judgePanel(), loopUntilDry(), and completenessCheck(). Optional control helpers include retry() and gate(); budget exposes total, spent(), and remaining(); phase('Name', { budget: N }) sets a phase token limit.",
            "The optional `agentType` option selects a named user or project definition to bind tools, a model, and role instructions; use only when its name and purpose are provided in context. Its bound model overrides `tier`; explicit `model` overrides both.",
            "Plain JavaScript only: imports, require(), filesystem modules, Date.now(), Math.random(), and new Date() are unavailable.",
            "Available: phase('Name'), agent(prompt, opts), parallel(arrayOfFunctions), pipeline(items, ...stages), createTeam(name), deliver(message), args, cwd, process.cwd(), and budget. createTeam gives workflow-scoped peer messaging/task board; team.spawn() reuses scheduler/concurrency budget. deliver(message) sends to host conversation when wired; otherwise no-op. Must call agent() at least once.",
            "parallel() requires functions, not promises; results in input order.",
            "pipeline(items, ...stages): stages sequentially per item; items proceed concurrently; each stage receives (previousValue, originalItem, index).",
        ].join(" "),
    })),
    name: Type.Optional(Type.String({
        description: "Run a saved or built-in workflow by name, not `script`; pass args in `args`. " +
            `Built-ins: ${BUILTIN_WORKFLOW_NAMES.join(", ")} — see the workflow-patterns skill for args. ` +
            "Same-named saved wins; not combinable with resumeFromRunId.",
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
        description: "Optional JSON object exposed as global `args`.",
    })),
    maxAgents: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 1000,
        description: "Maximum agents. Default: 1000; this is a safety ceiling, not a target. Use a lower limit for dynamic or exploratory fan-out; reserve large fan-outs for explicit user intent.",
    })),
    concurrency: Type.Optional(Type.Integer({
        minimum: 1,
        maximum: 16,
        description: "Maximum concurrent agents; clamped to runtime maximum. Use for provider/transport stability.",
    })),
    agentRetries: Type.Optional(Type.Integer({
        minimum: 0,
        maximum: 3,
        description: "Retry attempts for recoverable agent failures (timeout, connection, empty output). Default 0 unless configured.",
    })),
    agentTimeoutMs: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Timeout per agent (ms). Omit to use configured `defaultAgentTimeoutMs`; without one, no hard timeout. Set only when the user asks to bound time.",
    })),
    tokenBudget: Type.Optional(Type.Integer({
        minimum: 1,
        description: "Optional user-requested soft spend gate, not a planning target. Do not set `tokenBudget` unless the user explicitly supplies a cap or asks you to choose one; never infer or invent one from task size. If omitted, the configured `defaultTokenBudget` applies; without one, the run is unlimited. Reaching the gate blocks later `agent()` calls; concurrent in-flight work can overshoot.",
    })),
    resumeFromRunId: Type.Optional(Type.String({
        description: "Resume a prior run (this ID) with an edited `script`. Unchanged agent() calls replay from cache; the first changed/new call onward re-runs. Calls match by position; keep earlier calls identical/in order. Always background.",
    })),
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
    return defineTool({
        name: "workflow",
        label: "Workflow",
        description: "Run a JavaScript workflow that delegates work to subagents with agent(), optionally composing calls with parallel(), pipeline(), and workflow-scoped Agent Teams via createTeam().",
        promptSnippet: "Delegate substantive independent or staged work to subagents with a JavaScript workflow, optionally composing agent calls with parallel(), pipeline(), or peer coordination via createTeam()",
        get promptGuidelines() {
            return [WORKFLOW_GATE_GUIDELINE];
        },
        parameters: workflowToolSchema,
        prepareArguments(args) {
            return normalizeWorkflowToolArgs(args);
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
            if (params.name) {
                if (params.resumeFromRunId) {
                    throw new Error("workflow: `name` cannot be combined with `resumeFromRunId` — resume with an edited `script` instead.");
                }
                const resolved = resolveWorkflowInvocation(params.name, params.args, { storage, cwd });
                if (!resolved) {
                    throw new Error(`workflow: no saved or built-in workflow named "${params.name}". Built-in names: ${BUILTIN_WORKFLOW_NAMES.join(", ")}.`);
                }
                script = normalizeWorkflowScript(resolved.script);
                invocationTools = resolved.tools;
                invocationToolset = resolved.toolset;
            }
            else {
                if (!params.script)
                    throw new Error("workflow requires either `script` or `name`");
                script = normalizeWorkflowScript(params.script);
            }
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
                tokenBudget: params.tokenBudget,
                tools: invocationTools,
                toolset: invocationToolset,
            });
            return {
                content: [{ type: "text", text: backgroundStartedText(parsed.meta.name, runId) }],
                details: { runId, background: true },
            };
        },
        renderCall(_args, theme) {
            return new Text(theme.fg("toolTitle", theme.bold("workflow")), 0, 0);
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
/**
 * The tool result returned when a workflow starts in the background. It both
 * informs the model and tells it to reassure the user: the run continues on its
 * own and the conversation will resume automatically when it finishes, so the
 * user can just wait here (or go do something else).
 */
export function backgroundStartedText(name, runId) {
    return [
        `Workflow "${name}" started in the background.`,
        `Run ID: ${runId}`,
        "It keeps running on its own. When it finishes, the result is delivered back",
        "here and the conversation continues automatically — the user does not need to",
        "do anything. Tell the user they can simply wait here for it to finish (it will",
        "resume the conversation by itself), or keep chatting / working on other things",
        "in the meantime; either way the result will come back to this conversation.",
        `They can also track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
        reviseHint(runId),
    ].join("\n");
}
/**
 * One-line hint telling the model it can iterate on a finished/running run by
 * resuming it with an edited script instead of re-running the whole workflow.
 * Unchanged agent() calls replay from the journal (cache); only edited/new ones
 * re-run. Omitted when there is no runId to reference.
 */
export function reviseHint(runId) {
    if (!runId)
        return "";
    return `To revise without re-running everything: re-call workflow with resumeFromRunId="${runId}" and an edited script — unchanged agent() calls replay from cache, only edited/new ones re-run.`;
}
/**
 * The tool result returned when the model resumes a run with an edited script.
 * The resumed run is always background, so its result is delivered back later.
 */
export function resumedText(name, runId) {
    return [
        `Workflow "${name}" resumed from run ${runId} with your edited script.`,
        "Unchanged agent() calls replay from that run's journal (cache); the first",
        "edited or newly inserted agent() call — and everything after it — re-runs live.",
        "It runs in the background; the result is delivered back here when it finishes,",
        "and the conversation continues automatically. The user can wait or keep working.",
        `Track or cancel it with /workflows status ${runId} or /workflows stop ${runId}.`,
    ].join("\n");
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
function normalizeWorkflowToolArgs(args) {
    if (!args || typeof args !== "object")
        throw new Error("workflow requires an object argument with a `script` string or a `name`");
    const value = args;
    if (Object.hasOwn(value, "background")) {
        throw new Error("workflow is background-only; omit the unsupported `background` argument");
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
    const normalized = {
        ...value,
        maxAgents: validateInteger(value.maxAgents, "maxAgents", 1, 1000),
        concurrency: validateInteger(value.concurrency, "concurrency", 1, 16),
        agentRetries: validateInteger(value.agentRetries, "agentRetries", 0, 3),
        agentTimeoutMs: validateInteger(value.agentTimeoutMs, "agentTimeoutMs", 1, Number.MAX_SAFE_INTEGER),
        tokenBudget: validateInteger(value.tokenBudget, "tokenBudget", 1, Number.MAX_SAFE_INTEGER),
    };
    // `name` resolves a saved/built-in workflow at execute() time, so `script` is
    // optional here — but if `script` is present at all it must still be a
    // string (same requirement as the script-only path below), so a caller
    // passing a malformed `script` alongside `name` gets a clear error instead
    // of it being silently dropped.
    if (typeof value.name === "string" && value.name.trim()) {
        if (value.script !== undefined && typeof value.script !== "string") {
            throw new Error("workflow's `script` must be a string when provided alongside `name`");
        }
        return {
            ...normalized,
            name: value.name.trim(),
            script: typeof value.script === "string" ? normalizeWorkflowScript(value.script) : undefined,
        };
    }
    if (typeof value.script !== "string")
        throw new Error("workflow requires either `script` or `name` to be a string");
    return { ...normalized, script: normalizeWorkflowScript(value.script) };
}
function normalizeWorkflowScript(script) {
    let text = script.trim();
    const fence = text.match(/^```(?:js|javascript)?\s*\n([\s\S]*?)\n```$/i);
    if (fence)
        text = fence[1].trim();
    return text;
}
