import { defineTool } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { aggregateAgentUsage, tokenFigures } from "./display.js";
import { assertSafeRunId } from "./run-persistence.js";
// A tool's top-level parameter schema must be a JSON Schema object (`type:
// "object"`). A discriminated Type.Union of two objects serializes to a
// top-level `anyOf` with no `type`, which strict providers (e.g. DeepSeek)
// reject with "schema must be type object, got type: null". So the schema is a
// single strict object. Detailed inspection is intentionally absent: status
// polling caused self-sustaining provider loops instead of waiting for
// workflow-result. The separate model-facing list exposes cancellation handles
// only; it does not expose progress or historical inspection.
const workflowControlSchema = Type.Object({
    action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("stop")], {
        description: "Lifecycle action.",
    }),
    runId: Type.String({ minLength: 1, description: "Workflow run ID." }),
}, { additionalProperties: false });
const stopWorkflowSchema = Type.Object({
    runId: Type.String({
        minLength: 1,
        description: "Exact run ID returned by start_workflow.",
    }),
}, { additionalProperties: false });
const listActiveWorkflowsSchema = Type.Object({}, { additionalProperties: false });
const MAX_MODEL_VISIBLE_ACTIVE_RUNS = 64;
/** Exact cancellation handles for active runs owned by the bound Pi session. */
export function createListActiveWorkflowsTool(options) {
    const getManager = () => {
        const manager = options.getManager?.() ?? options.manager;
        if (!manager)
            throw new Error("list_active_workflows: no WorkflowManager configured");
        return manager;
    };
    return defineTool({
        name: "list_active_workflows",
        label: "List active workflows",
        description: "List active workflows owned by this Pi session, returning exact run IDs for cancellation.",
        parameters: listActiveWorkflowsSchema,
        prepareArguments: normalizeListActiveWorkflowsInput,
        async execute() {
            try {
                const manager = getManager();
                const sessionId = currentSessionId(manager, options);
                if (!sessionId)
                    return listActiveWorkflowResult([], false, "current session ownership is unavailable");
                const active = manager
                    .listRuns()
                    .filter((run) => isPersistedRunState(run) &&
                    run.sessionId === sessionId &&
                    (run.status === "running" || run.status === "paused"))
                    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
                const runs = active.slice(0, MAX_MODEL_VISIBLE_ACTIVE_RUNS).map(({ runId, workflowName, status }) => ({
                    runId,
                    name: compactWorkflowName(workflowName),
                    status,
                }));
                return listActiveWorkflowResult(runs, active.length > runs.length);
            }
            catch (error) {
                return listActiveWorkflowResult([], false, errorText(error));
            }
        },
        renderCall(_args, theme) {
            return new Text(theme.fg("toolTitle", theme.bold("list active workflows")), 0, 0);
        },
        renderResult(toolResult, _options, theme) {
            const details = toolResult.details;
            const text = details.error
                ? `Unavailable: ${details.error}`
                : `${details.runs.length} active workflow${details.runs.length === 1 ? "" : "s"}`;
            return new Text(theme.fg(details.error ? "warning" : "success", text), 0, 0);
        },
    });
}
/**
 * Provider-facing cancellation handle. It deliberately exposes no discovery,
 * status, pause, resume, or steering surface: the caller must use the exact ID
 * returned by start_workflow, and the manager must be bound to the owning Pi
 * session before any mutation is allowed.
 */
export function createStopWorkflowTool(options) {
    const getManager = () => {
        const manager = options.getManager?.() ?? options.manager;
        if (!manager)
            throw new Error("stop_workflow: no WorkflowManager configured");
        return manager;
    };
    return defineTool({
        name: "stop_workflow",
        label: "Stop workflow",
        description: "Stop one workflow started in this Pi session when cancellation is requested or the preceding start was mistaken. Exact runId required.",
        parameters: stopWorkflowSchema,
        prepareArguments: normalizeStopWorkflowInput,
        async execute(_toolCallId, params) {
            let manager;
            try {
                manager = getManager();
            }
            catch (error) {
                return stopWorkflowResult(params.runId, false, undefined, errorText(error));
            }
            try {
                const sessionId = currentSessionId(manager, options);
                if (!sessionId) {
                    return stopWorkflowResult(params.runId, false, undefined, "current session ownership is unavailable");
                }
                const run = manager
                    .listRuns()
                    .find((candidate) => isPersistedRunState(candidate) && candidate.runId === params.runId);
                if (!run || run.sessionId !== sessionId) {
                    return stopWorkflowResult(params.runId, false, undefined, "run not found in current session");
                }
                if (run.status !== "running" && run.status !== "paused") {
                    return stopWorkflowResult(params.runId, false, run.status, `cannot stop run with status ${run.status}`);
                }
                if (!manager.stop(run.runId)) {
                    return stopWorkflowResult(params.runId, false, run.status, "stop was not accepted");
                }
                return stopWorkflowResult(run.runId, true, "aborted");
            }
            catch (error) {
                return stopWorkflowResult(params.runId, false, undefined, errorText(error));
            }
        },
        renderCall(args, theme) {
            const runId = typeof args?.runId === "string" ? shortRunId(args.runId) : "";
            const suffix = runId ? theme.fg("dim", ` · ${runId}`) : "";
            return new Text(`${theme.fg("toolTitle", theme.bold("stop workflow"))}${suffix}`, 0, 0);
        },
        renderResult(toolResult, _options, theme) {
            const details = toolResult.details;
            const label = details.stopped ? `Stopped ${details.runId}` : `Not stopped: ${details.error ?? details.runId}`;
            return new Text(theme.fg(details.stopped ? "success" : "warning", label), 0, 0);
        },
    });
}
export function createWorkflowControlTool(options) {
    const getManager = () => {
        const m = options.getManager?.() ?? options.manager;
        if (!m)
            throw new Error("workflow_control: no WorkflowManager configured");
        return m;
    };
    return defineTool({
        name: "workflow_control",
        label: "Workflow Control",
        description: "Pause, resume, or stop one workflow by runId.",
        parameters: workflowControlSchema,
        prepareArguments: normalizeInput,
        async execute(_toolCallId, params) {
            let manager;
            try {
                manager = getManager();
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return controlError(params.action, params.runId, message, []);
            }
            try {
                const runs = manager.listRuns();
                // Persistence is deliberately a soft boundary here: old/corrupt files
                // may still be visible to a manager implementation.  Do not let one
                // malformed record crash the control tool or make it reach summarizeRun.
                const validRuns = Array.isArray(runs) ? runs.filter(isPersistedRunState) : [];
                const run = validRuns.find((candidate) => candidate.runId === params.runId);
                if (!run)
                    return controlError(params.action, params.runId, "run not found", []);
                switch (params.action) {
                    case "pause":
                        if (!manager.pause(run.runId))
                            return invalidTransition("pause", run);
                        return actionSuccess("pause", "paused", currentSummary(manager, run));
                    case "resume":
                        if (!(await manager.resume(run.runId)))
                            return invalidTransition("resume", run);
                        return actionSuccess("resume", "resumed", currentSummary(manager, run));
                    case "stop":
                        if (!manager.stop(run.runId))
                            return invalidTransition("stop", run);
                        return actionSuccess("stop", "stopped", currentSummary(manager, run));
                }
            }
            catch (err) {
                // Persistence and manager failures are tool errors, not model-visible
                // exceptions.  Keep the same structured shape for every action.
                const message = err instanceof Error ? err.message : String(err);
                return controlError(params.action, params.runId, message, []);
            }
        },
        renderCall(args, theme) {
            const action = typeof args?.action === "string" ? args.action : "control";
            const runId = typeof args?.runId === "string" ? shortRunId(args.runId) : "";
            const suffix = runId ? theme.fg("dim", ` · ${runId}`) : "";
            return new Text(`${theme.fg("toolTitle", theme.bold("workflow"))} ${theme.fg("muted", action)}${suffix}`, 0, 0);
        },
        renderResult(toolResult, _options, theme) {
            return new Text(renderControlResult(toolResult.details, theme), 0, 0);
        },
    });
}
function normalizeInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("workflow_control requires an object argument");
    }
    const input = value;
    const actions = new Set(["pause", "resume", "stop"]);
    if (typeof input.action !== "string" || !actions.has(input.action)) {
        throw new Error("workflow_control requires action: pause|resume|stop");
    }
    const allowedKeys = new Set(["action", "runId"]);
    const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
    if (extraKey)
        throw new Error(`workflow_control action "${input.action}" does not accept ${extraKey}`);
    if (typeof input.runId !== "string" || !input.runId.trim()) {
        throw new Error(`workflow_control action "${input.action}" requires runId`);
    }
    try {
        assertSafeRunId(input.runId);
    }
    catch {
        throw new Error(`workflow_control action "${input.action}" requires a canonical runId`);
    }
    return input;
}
function normalizeStopWorkflowInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("stop_workflow requires an object argument");
    }
    const input = value;
    const extraKey = Object.keys(input).find((key) => key !== "runId");
    if (extraKey)
        throw new Error(`stop_workflow does not accept ${extraKey}`);
    if (typeof input.runId !== "string" || !input.runId.trim()) {
        throw new Error("stop_workflow requires runId");
    }
    try {
        assertSafeRunId(input.runId);
    }
    catch {
        throw new Error("stop_workflow requires a canonical runId");
    }
    return input;
}
function normalizeListActiveWorkflowsInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("list_active_workflows requires an object argument");
    }
    const extraKey = Object.keys(value).find(() => true);
    if (extraKey)
        throw new Error(`list_active_workflows does not accept ${extraKey}`);
    return value;
}
function listActiveWorkflowResult(runs, truncated, error) {
    const content = error
        ? `Active workflows unavailable: ${error}.`
        : runs.length === 0
            ? "No active workflows in this Pi session."
            : [
                "Active workflows in this Pi session:",
                ...runs.map((run) => `- ${run.runId} | ${run.name} | ${run.status}`),
                ...(truncated ? ["- More active workflows are available through /workflows list."] : []),
            ].join("\n");
    return {
        content: [{ type: "text", text: content }],
        details: { runs, truncated, ...(error ? { error } : {}) },
    };
}
function compactWorkflowName(name) {
    const compact = name.replace(/\s+/gu, " ").trim();
    return compact.length <= 96 ? compact : `${compact.slice(0, 95)}…`;
}
function stopWorkflowResult(runId, stopped, status, error) {
    const text = stopped
        ? `Workflow stopped (run ${runId}).`
        : `Workflow not stopped (run ${runId}): ${error ?? "unknown error"}.`;
    return {
        content: [{ type: "text", text }],
        details: { runId, stopped, ...(status ? { status } : {}), ...(error ? { error } : {}) },
    };
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
function currentSessionId(manager, options) {
    if (options.getSessionId)
        return options.getSessionId();
    return typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined;
}
function result(text, details) {
    return { content: [{ type: "text", text }], details };
}
function findRun(manager, runId) {
    try {
        return manager.listRuns().find((candidate) => isPersistedRunState(candidate) && candidate.runId === runId);
    }
    catch {
        return undefined;
    }
}
function currentSummary(manager, fallback) {
    const current = findRun(manager, fallback.runId) ?? fallback;
    return summarizeRun(current, safeSnapshot(manager, current.runId), safeGetRun(manager, current.runId));
}
function safeSnapshot(manager, runId) {
    try {
        const snapshot = manager.getSnapshot(runId);
        return isWorkflowSnapshot(snapshot) ? snapshot : null;
    }
    catch {
        return null;
    }
}
function safeGetRun(manager, runId) {
    try {
        return manager.getRun(runId) ?? null;
    }
    catch {
        return null;
    }
}
function isPersistedRunState(value) {
    if (!isRecord(value) || typeof value.runId !== "string" || typeof value.workflowName !== "string")
        return false;
    try {
        assertSafeRunId(value.runId);
    }
    catch {
        return false;
    }
    if (!isRunStatus(value.status) || !Array.isArray(value.agents))
        return false;
    return value.agents.every(isAgentLike);
}
function isRunStatus(value) {
    return (value === "pending" ||
        value === "running" ||
        value === "paused" ||
        value === "completed" ||
        value === "failed" ||
        value === "aborted");
}
function isAgentLike(value) {
    return (isRecord(value) &&
        typeof value.status === "string" &&
        ["queued", "running", "done", "error", "skipped"].includes(value.status));
}
function isWorkflowSnapshot(value) {
    return (isRecord(value) && typeof value.name === "string" && Array.isArray(value.agents) && value.agents.every(isAgentLike));
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function actionSuccess(action, actionResult, run) {
    return result(`action=${action} result=${actionResult} ${formatRun(run)}`, {
        action,
        result: actionResult,
        run,
    });
}
function invalidTransition(action, run) {
    return controlError(action, run.runId, `cannot ${action} run with status ${run.status}`, allowedActions(run.status));
}
function controlError(action, runId, message, allowed) {
    return result(`action=${action} result=error runId=${runId} error=${message} allowed=${allowed.join(",") || "none"}`, { action, result: "error", runId, error: message, allowedActions: allowed });
}
function allowedActions(status) {
    switch (status) {
        case "running":
            return ["pause", "stop"];
        case "paused":
            return ["resume", "stop"];
        case "failed":
        case "pending":
            return ["resume"];
        case "completed":
        case "aborted":
            return [];
    }
}
function summarizeRun(run, live, managed) {
    const agents = live?.agents ?? run.agents;
    const settling = (run.status === "paused" || run.status === "aborted" || run.status === "failed") &&
        managed?.executionSettled === false;
    const inFlightAgents = settling ? agents.filter((agent) => agent.status === "running") : [];
    const counts = countAgents(agents);
    // A cancelled or failed generation may leave its snapshot entries marked
    // running while its abort/unwind tail is still settling. Keep that tail
    // visible separately; `running` describes normal workflow work only.
    if (run.status !== "running")
        counts.running = 0;
    const liveUsage = tokenFigures(live?.tokenUsage);
    const persistedUsage = tokenFigures(run.tokenUsage);
    const agentUsage = aggregateAgentUsage(agents);
    return {
        runId: run.runId,
        workflowName: live?.name ?? run.workflowName,
        status: run.status,
        phase: live?.currentPhase ?? run.currentPhase ?? null,
        counts,
        activeLabels: run.status === "running" ? agents.filter((agent) => agent.status === "running").map((agent) => agent.label) : [],
        settling,
        inFlight: inFlightAgents.length,
        inFlightLabels: inFlightAgents.map((agent) => agent.label),
        tokenTotal: Math.max(liveUsage.fresh + liveUsage.cacheRead, persistedUsage.fresh + persistedUsage.cacheRead, agentUsage.fresh + agentUsage.cacheRead),
    };
}
function countAgents(agents) {
    return {
        total: agents.length,
        done: agents.filter((agent) => agent.status === "done").length,
        running: agents.filter((agent) => agent.status === "running").length,
        queued: agents.filter((agent) => agent.status === "queued").length,
        error: agents.filter((agent) => agent.status === "error").length,
        skipped: agents.filter((agent) => agent.status === "skipped").length,
    };
}
function formatRun(run) {
    const active = run.activeLabels.join(",") || "-";
    const inFlightLabels = run.inFlightLabels.join(",") || "-";
    return `runId=${run.runId} name=${quote(run.workflowName)} status=${run.status} phase=${quote(run.phase ?? "-")} total=${run.counts.total} done=${run.counts.done} running=${run.counts.running} queued=${run.counts.queued} error=${run.counts.error} skipped=${run.counts.skipped} active=${quote(active)} settling=${run.settling} inFlight=${run.inFlight} inFlightLabels=${quote(inFlightLabels)} tokens=${run.tokenTotal}`;
}
function renderControlResult(details, theme) {
    if (!isRecord(details))
        return theme.fg("muted", "Workflow control finished");
    const action = typeof details.action === "string" ? details.action : "control";
    const outcome = typeof details.result === "string" ? details.result : "ok";
    if (outcome === "error") {
        const runId = typeof details.runId === "string" && details.runId ? ` · ${shortRunId(details.runId)}` : "";
        const message = typeof details.error === "string" ? details.error : "Workflow control failed";
        return `${theme.fg("error", "✗")} ${theme.bold(titleCase(action))}${theme.fg("dim", runId)}\n  ${theme.fg("muted", message)}`;
    }
    const run = isControlRunDetails(details.run) ? details.run : undefined;
    const title = controlOutcomeTitle(outcome);
    const icon = outcome === "stopped" ? "■" : outcome === "paused" ? "⏸" : outcome === "resumed" ? "▶" : statusGlyph(run?.status);
    const color = outcome === "stopped" ? "warning" : statusColor(run?.status);
    if (!run)
        return `${theme.fg(color, icon)} ${theme.bold(title)}`;
    return `${theme.fg(color, icon)} ${theme.bold(title)}\n${renderRunSummary(run, theme, false)}`;
}
function renderRunSummary(run, theme, includeStatus) {
    const progress = `${run.counts.done}/${run.counts.total}`;
    const activity = renderRunActivity(run);
    const state = includeStatus ? `${run.status} · ` : "";
    const phase = run.phase ? ` · ${run.phase}` : "";
    const activitySuffix = activity ? ` · ${activity}` : "";
    return `  ${theme.fg(statusColor(run.status), statusGlyph(run.status))} ${theme.bold(run.workflowName)} ${theme.fg("muted", `· ${state}${progress} agents${activitySuffix}${phase}`)}\n    ${theme.fg("dim", shortRunId(run.runId))}`;
}
function renderRunActivity(run) {
    if (run.settling) {
        const requests = run.inFlight > 0 ? `${run.inFlight} request${run.inFlight === 1 ? "" : "s"}` : "";
        const verb = run.status === "paused" ? "pausing" : run.status === "aborted" ? "stopping" : "settling";
        return requests ? `${verb} ${requests}` : verb;
    }
    if (run.counts.running > 0)
        return `${run.counts.running} active`;
    if (run.counts.error > 0)
        return `${run.counts.error} failed`;
    return "";
}
function isControlRunDetails(value) {
    return (isRecord(value) &&
        typeof value.runId === "string" &&
        typeof value.workflowName === "string" &&
        isRunStatus(value.status) &&
        isRecord(value.counts) &&
        typeof value.counts.total === "number" &&
        typeof value.counts.done === "number" &&
        typeof value.counts.running === "number" &&
        typeof value.counts.error === "number");
}
function controlOutcomeTitle(outcome) {
    if (outcome === "paused")
        return "Workflow paused";
    if (outcome === "resumed")
        return "Workflow resumed";
    if (outcome === "stopped")
        return "Workflow stopped";
    return `Workflow ${outcome}`;
}
function statusGlyph(status) {
    switch (status) {
        case "running":
            return "◆";
        case "paused":
            return "⏸";
        case "completed":
            return "✓";
        case "failed":
            return "✗";
        case "aborted":
            return "■";
        default:
            return "○";
    }
}
function statusColor(status) {
    switch (status) {
        case "completed":
            return "success";
        case "failed":
            return "error";
        case "paused":
        case "aborted":
            return "warning";
        case "running":
            return "accent";
        default:
            return "muted";
    }
}
function shortRunId(runId) {
    return runId.length <= 34 ? runId : `${runId.slice(0, 18)}…${runId.slice(-10)}`;
}
function titleCase(value) {
    return value ? `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}` : "Workflow control";
}
function quote(value) {
    return JSON.stringify(value);
}
