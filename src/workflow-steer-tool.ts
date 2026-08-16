import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { assertSafeRunId } from "./run-persistence.js";
import type { WorkflowManager } from "./workflow-manager.js";

const workflowSteerSchema = Type.Object(
  {
    runId: Type.String({
      minLength: 1,
      description: "Workflow run ID.",
    }),
    message: Type.String({
      minLength: 1,
      maxLength: 8_000,
      description: "Update for this run.",
    }),
    kind: Type.Union(
      [Type.Literal("same_task_correction"), Type.Literal("blocker_answer"), Type.Literal("changed_fact")],
      {
        description: "Update type.",
      },
    ),
    agentId: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Optional live child ID.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type WorkflowSteerInput = Static<typeof workflowSteerSchema>;

export interface WorkflowSteerToolOptions {
  manager?: WorkflowManager;
  /** Live manager accessor; prefer it when a session reload can replace the manager. */
  getManager?: () => WorkflowManager;
}

export function createWorkflowSteerTool(
  options: WorkflowSteerToolOptions,
): ToolDefinition<typeof workflowSteerSchema, Record<string, unknown>> {
  const getManager = (): WorkflowManager => {
    const manager = options.getManager?.() ?? options.manager;
    if (!manager) throw new Error("workflow_steer: no WorkflowManager configured");
    return manager;
  };

  return defineTool({
    name: "workflow_steer",
    label: "Workflow Steer",
    description: "Send a same-task update to one identified workflow run.",
    parameters: workflowSteerSchema,
    prepareArguments: normalizeWorkflowSteerInput,
    async execute(_toolCallId, params) {
      const manager = getManager();
      if (params.agentId) {
        const targetRunId = await manager.sendToAgent(params.message, params.agentId, params.runId, params.kind);
        if (!targetRunId) {
          throw new Error(`Subagent ${params.agentId} is not running in workflow ${params.runId}`);
        }
        return {
          content: [{ type: "text", text: `Steered subagent ${params.agentId} in workflow ${targetRunId}.` }],
          details: {
            runId: targetRunId,
            agentId: params.agentId,
            message: params.message,
            kind: params.kind,
            mode: "immediate",
          },
        };
      }

      const queuedRunId = manager.enqueueUserMessage(params.message, params.runId, params.kind);
      if (!queuedRunId) throw new Error(`Workflow ${params.runId} is not running`);
      return {
        content: [{ type: "text", text: `Queued steering for workflow ${queuedRunId}'s next child call.` }],
        details: { runId: queuedRunId, agentId: "", message: params.message, kind: params.kind, mode: "next-agent" },
      };
    },
  });
}

function normalizeWorkflowSteerInput(value: unknown): WorkflowSteerInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("workflow_steer requires an object argument");
  }
  const input = value as Record<string, unknown>;
  const allowedKeys = new Set(["runId", "message", "kind", "agentId"]);
  const extraKey = Object.keys(input).find((key) => !allowedKeys.has(key));
  if (extraKey) throw new Error(`workflow_steer does not accept ${extraKey}`);

  if (typeof input.runId !== "string" || !input.runId.trim()) {
    throw new Error("workflow_steer requires a runId");
  }
  try {
    assertSafeRunId(input.runId);
  } catch {
    throw new Error("workflow_steer requires a canonical runId");
  }
  if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 8_000) {
    throw new Error("workflow_steer requires a non-empty message within 8000 characters");
  }
  const allowedKinds = new Set(["same_task_correction", "blocker_answer", "changed_fact"]);
  if (typeof input.kind !== "string" || !allowedKinds.has(input.kind)) {
    throw new Error("workflow_steer requires a same-task kind");
  }
  if (input.agentId !== undefined && (typeof input.agentId !== "string" || !input.agentId.trim())) {
    throw new Error("workflow_steer agentId must be a non-empty string when provided");
  }
  return {
    runId: input.runId,
    message: input.message.trim(),
    kind: input.kind as WorkflowSteerInput["kind"],
    ...(input.agentId === undefined ? {} : { agentId: input.agentId.trim() }),
  };
}
