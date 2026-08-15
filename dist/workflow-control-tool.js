import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { aggregateAgentUsage, tokenFigures } from "./display.js";
import { assertSafeRunId } from "./run-persistence.js";
// A tool's top-level parameter schema must be a JSON Schema object (`type:
// "object"`). A discriminated Type.Union of two objects serializes to a
// top-level `anyOf` with no `type`, which strict providers (e.g. DeepSeek)
// reject with "schema must be type object, got type: null". So the schema is a
// single object: `action` is the full set of verbs and `runId` is optional at
// the schema level. The per-action requirement (runId is mandatory for every
// action except `list`, and `list` ignores any compatibility runId) is
// enforced at runtime in normalizeInput() and guarded again in execute().
const workflowControlSchema = Type.Object({
    action: Type.Union([
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("stop"),
    ], { description: "list = all runs (runId is ignored for wrapper compatibility); status/pause/resume/stop act on one run and require runId." }),
    runId: Type.Optional(Type.String({
        description: "Canonical workflow run ID. Required for status, pause, resume, and stop; omit (or use empty) for list.",
    })),
}, { additionalProperties: false });
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
        description: "List and inspect workflow runs, or pause, resume, and stop them without asking the user to run slash commands.",
        promptSnippet: "Inspect and manage workflow runs directly by canonical run ID.",
        promptGuidelines: [
            "Use workflow_control for workflow lifecycle management; do not ask the user to type /workflows when this tool can perform the action.",
            "Use stop to terminate or quit a run. Closing the navigator does not stop a run.",
        ],
        parameters: workflowControlSchema,
        prepareArguments: normalizeInput,
        async execute(_toolCallId, params) {
            let manager;
            try {
                manager = getManager();
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                return controlError(params.action, params.runId ?? "", message, ["list"]);
            }
            try {
                const runs = manager.listRuns();
                // Persistence is deliberately a soft boundary here: old/corrupt files
                // may still be visible to a manager implementation.  Do not let one
                // malformed record crash the control tool or make it reach summarizeRun.
                const validRuns = Array.isArray(runs) ? runs.filter(isPersistedRunState) : [];
                if (params.action === "list") {
                    const summaries = validRuns.map((run) => summarizeRun(run, safeSnapshot(manager, run.runId)));
                    return result(summaries.length
                        ? `action=list result=ok runs=${summaries.length}\n${summaries.map(formatRun).join("\n")}`
                        : "action=list result=ok runs=0", { action: "list", result: "ok", runs: summaries });
                }
                // runId is optional in the schema (see workflowControlSchema) but
                // required for every non-list action.
                if (!params.runId)
                    return controlError(params.action, "", "runId is required for this action", ["list"]);
                const run = validRuns.find((candidate) => candidate.runId === params.runId);
                if (!run)
                    return controlError(params.action, params.runId, "run not found", ["list"]);
                switch (params.action) {
                    case "status": {
                        const summary = summarizeRun(run, safeSnapshot(manager, run.runId));
                        return result(`action=status result=ok ${formatRun(summary)}`, {
                            action: "status",
                            result: "ok",
                            run: summary,
                        });
                    }
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
                return controlError(params.action, params.runId ?? "", message, ["list"]);
            }
        },
    });
}
function normalizeInput(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("workflow_control requires an object argument");
    }
    const input = value;
    const actions = new Set(["list", "status", "pause", "resume", "stop"]);
    if (typeof input.action !== "string" || !actions.has(input.action)) {
        throw new Error("workflow_control requires action: list|status|pause|resume|stop");
    }
    // Some generic tool dispatchers emit a uniform runId field even for list.
    // Listing is independent of a run, so accept and ignore that compatibility
    // field instead of failing before the useful operation can execute.
    const allowedKeys = new Set(["action", "runId"]);
    const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
    if (extraKey)
        throw new Error(`workflow_control action "${input.action}" does not accept ${extraKey}`);
    if (input.action === "list") {
        if (input.runId !== undefined && typeof input.runId !== "string") {
            throw new Error('workflow_control action "list" accepts only a string runId compatibility field');
        }
        return input;
    }
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
    return summarizeRun(current, safeSnapshot(manager, current.runId));
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
    return value === "pending" || value === "running" || value === "paused" || value === "completed" || value === "failed" || value === "aborted";
}
function isAgentLike(value) {
    return isRecord(value) && typeof value.status === "string" && ["queued", "running", "done", "error", "skipped"].includes(value.status);
}
function isWorkflowSnapshot(value) {
    return isRecord(value) && typeof value.name === "string" && Array.isArray(value.agents) && value.agents.every(isAgentLike);
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
            return ["status", "pause", "stop"];
        case "paused":
            return ["status", "resume", "stop"];
        case "failed":
        case "pending":
            return ["status", "resume"];
        case "completed":
        case "aborted":
            return ["status"];
    }
}
function summarizeRun(run, live) {
    const agents = live?.agents ?? run.agents;
    const counts = countAgents(agents);
    const liveUsage = tokenFigures(live?.tokenUsage);
    const persistedUsage = tokenFigures(run.tokenUsage);
    const agentUsage = aggregateAgentUsage(agents);
    return {
        runId: run.runId,
        workflowName: live?.name ?? run.workflowName,
        status: run.status,
        phase: live?.currentPhase ?? run.currentPhase ?? null,
        counts,
        activeLabels: agents.filter((agent) => agent.status === "running").map((agent) => agent.label),
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
    return `runId=${run.runId} name=${quote(run.workflowName)} status=${run.status} phase=${quote(run.phase ?? "-")} total=${run.counts.total} done=${run.counts.done} running=${run.counts.running} queued=${run.counts.queued} error=${run.counts.error} skipped=${run.counts.skipped} active=${quote(active)} tokens=${run.tokenTotal}`;
}
function quote(value) {
    return JSON.stringify(value);
}
