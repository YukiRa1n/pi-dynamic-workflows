import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { aggregateAgentUsage, tokenFigures, type WorkflowAgentSnapshot, type WorkflowSnapshot } from "./display.js";
import { assertSafeRunId, type PersistedRunState, type RunStatus } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

// A tool's top-level parameter schema must be a JSON Schema object (`type:
// "object"`). A discriminated Type.Union of two objects serializes to a
// top-level `anyOf` with no `type`, which strict providers (e.g. DeepSeek)
// reject with "schema must be type object, got type: null". So the schema is a
// single object: `action` is the full set of verbs and `runId` is optional at
// the schema level. The per-action requirement (runId is mandatory for every
// action except `list`) is enforced at runtime in normalizeInput() and guarded
// again in execute().
const workflowControlSchema = Type.Object(
  {
    action: Type.Union(
      [
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("stop"),
      ],
      {
        description:
          "list = all runs; status = one diagnostic snapshot, not a wait/result operation; pause/resume/stop change one run. Never poll. Stop only to cancel.",
      },
    ),
    runId: Type.Optional(
      Type.String({
        description: "Canonical workflow run ID. Required for status, pause, resume, and stop; omit for list.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type WorkflowControlInput = Static<typeof workflowControlSchema>;

export interface WorkflowControlToolOptions {
  manager?: WorkflowManager;
  /** Live manager accessor; prefer over a closed-over manager when the extension may replace it. */
  getManager?: () => WorkflowManager;
}

export interface WorkflowControlRunDetails {
  runId: string;
  workflowName: string;
  status: RunStatus;
  phase: string | null;
  counts: {
    total: number;
    done: number;
    running: number;
    queued: number;
    error: number;
    skipped: number;
  };
  activeLabels: string[];
  tokenTotal: number;
}

type ControlResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
};

export function createWorkflowControlTool(
  options: WorkflowControlToolOptions,
): ToolDefinition<typeof workflowControlSchema, Record<string, unknown>> {
  const getManager = (): WorkflowManager => {
    const m = options.getManager?.() ?? options.manager;
    if (!m) throw new Error("workflow_control: no WorkflowManager configured");
    return m;
  };
  return defineTool({
    name: "workflow_control",
    label: "Workflow Control",
    description:
      "Inspect or control workflow runs. status is a one-time diagnostic snapshot, not a way to wait for or obtain the final result. Never poll list/status; the final result arrives automatically as workflow-result. Stop only to cancel on explicit user request or a confirmed safety/resource conflict, never for cleanup or finalization.",
    promptSnippet: "status does not wait or return the final result; never poll; stop only to cancel.",
    promptGuidelines: [
      "After starting or resuming a workflow, end the turn and wait for workflow-result.",
      "workflow-message is intermediate. Do not query status to check whether it finished.",
      "Stop only to cancel, never as cleanup or finalization.",
    ],
    parameters: workflowControlSchema,
    prepareArguments: normalizeInput,
    async execute(_toolCallId, params) {
      let manager: WorkflowManager;
      try {
        manager = getManager();
      } catch (err) {
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
          return result(
            summaries.length
              ? `action=list result=ok runs=${summaries.length}\n${summaries.map(formatRun).join("\n")}`
              : "action=list result=ok runs=0",
            { action: "list", result: "ok", runs: summaries },
          );
        }

        // runId is optional in the schema (see workflowControlSchema) but
        // required for every non-list action.
        if (!params.runId) return controlError(params.action, "", "runId is required for this action", ["list"]);
        const run = validRuns.find((candidate) => candidate.runId === params.runId);
        if (!run) return controlError(params.action, params.runId, "run not found", ["list"]);

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
            if (!manager.pause(run.runId)) return invalidTransition("pause", run);
            return actionSuccess("pause", "paused", currentSummary(manager, run));
          case "resume":
            if (!(await manager.resume(run.runId))) return invalidTransition("resume", run);
            return actionSuccess("resume", "resumed", currentSummary(manager, run));
          case "stop":
            if (!manager.stop(run.runId)) return invalidTransition("stop", run);
            return actionSuccess("stop", "stopped", currentSummary(manager, run));
        }
      } catch (err) {
        // Persistence and manager failures are tool errors, not model-visible
        // exceptions.  Keep the same structured shape for every action.
        const message = err instanceof Error ? err.message : String(err);
        return controlError(params.action, params.runId ?? "", message, ["list"]);
      }
    },
  });
}

function normalizeInput(value: unknown): WorkflowControlInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_control requires an object argument");
  }
  const input = value as Record<string, unknown>;
  const actions = new Set(["list", "status", "pause", "resume", "stop"]);
  if (typeof input.action !== "string" || !actions.has(input.action)) {
    throw new Error("workflow_control requires action: list|status|pause|resume|stop");
  }

  const allowedKeys = new Set(["action", "runId"]);
  const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extraKey) throw new Error(`workflow_control action "${input.action}" does not accept ${extraKey}`);

  if (input.action === "list") {
    if (input.runId !== undefined) {
      throw new Error('workflow_control action "list" does not accept runId');
    }
    return input as WorkflowControlInput;
  }
  if (typeof input.runId !== "string" || !input.runId.trim()) {
    throw new Error(`workflow_control action "${input.action}" requires runId`);
  }
  try {
    assertSafeRunId(input.runId);
  } catch {
    throw new Error(`workflow_control action "${input.action}" requires a canonical runId`);
  }
  return input as WorkflowControlInput;
}

function result(text: string, details: Record<string, unknown>): ControlResult {
  return { content: [{ type: "text", text }], details };
}

function findRun(manager: WorkflowManager, runId: string): PersistedRunState | undefined {
  try {
    return manager.listRuns().find((candidate) => isPersistedRunState(candidate) && candidate.runId === runId);
  } catch {
    return undefined;
  }
}

function currentSummary(manager: WorkflowManager, fallback: PersistedRunState): WorkflowControlRunDetails {
  const current = findRun(manager, fallback.runId) ?? fallback;
  return summarizeRun(current, safeSnapshot(manager, current.runId));
}

function safeSnapshot(manager: WorkflowManager, runId: string): WorkflowSnapshot | null {
  try {
    const snapshot = manager.getSnapshot(runId);
    return isWorkflowSnapshot(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

function isPersistedRunState(value: unknown): value is PersistedRunState {
  if (!isRecord(value) || typeof value.runId !== "string" || typeof value.workflowName !== "string") return false;
  try {
    assertSafeRunId(value.runId);
  } catch {
    return false;
  }
  if (!isRunStatus(value.status) || !Array.isArray(value.agents)) return false;
  return value.agents.every(isAgentLike);
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "pending" ||
    value === "running" ||
    value === "paused" ||
    value === "completed" ||
    value === "failed" ||
    value === "aborted"
  );
}

function isAgentLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.status === "string" &&
    ["queued", "running", "done", "error", "skipped"].includes(value.status)
  );
}

function isWorkflowSnapshot(value: unknown): value is WorkflowSnapshot {
  return (
    isRecord(value) && typeof value.name === "string" && Array.isArray(value.agents) && value.agents.every(isAgentLike)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionSuccess(action: string, actionResult: string, run: WorkflowControlRunDetails): ControlResult {
  return result(`action=${action} result=${actionResult} ${formatRun(run)}`, {
    action,
    result: actionResult,
    run,
  });
}

function invalidTransition(action: string, run: PersistedRunState): ControlResult {
  return controlError(action, run.runId, `cannot ${action} run with status ${run.status}`, allowedActions(run.status));
}

function controlError(action: string, runId: string, message: string, allowed: string[]): ControlResult {
  return result(
    `action=${action} result=error runId=${runId} error=${message} allowed=${allowed.join(",") || "none"}`,
    { action, result: "error", runId, error: message, allowedActions: allowed },
  );
}

function allowedActions(status: RunStatus): string[] {
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

function summarizeRun(run: PersistedRunState, live?: WorkflowSnapshot | null): WorkflowControlRunDetails {
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
    tokenTotal: Math.max(
      liveUsage.fresh + liveUsage.cacheRead,
      persistedUsage.fresh + persistedUsage.cacheRead,
      agentUsage.fresh + agentUsage.cacheRead,
    ),
  };
}

function countAgents(agents: Array<Pick<WorkflowAgentSnapshot, "status">>): WorkflowControlRunDetails["counts"] {
  return {
    total: agents.length,
    done: agents.filter((agent) => agent.status === "done").length,
    running: agents.filter((agent) => agent.status === "running").length,
    queued: agents.filter((agent) => agent.status === "queued").length,
    error: agents.filter((agent) => agent.status === "error").length,
    skipped: agents.filter((agent) => agent.status === "skipped").length,
  };
}

function formatRun(run: WorkflowControlRunDetails): string {
  const active = run.activeLabels.join(",") || "-";
  return `runId=${run.runId} name=${quote(run.workflowName)} status=${run.status} phase=${quote(run.phase ?? "-")} total=${run.counts.total} done=${run.counts.done} running=${run.counts.running} queued=${run.counts.queued} error=${run.counts.error} skipped=${run.counts.skipped} active=${quote(active)} tokens=${run.tokenTotal}`;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
