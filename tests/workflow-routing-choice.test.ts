import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import packageJson from "../package.json" with { type: "json" };
import {
  evaluateWorkflowRoutingChoice,
  WORKFLOW_ROUTING_CHOICE_SCENARIOS,
  type WorkflowRoutingSessionEvidence,
} from "../src/workflow-routing-choice.js";

const ROOT = resolve(import.meta.dirname, "..");

test("routing-choice covers direct, fresh-run, same-task, and ambiguous-run behavior", () => {
  assert.deepEqual(
    WORKFLOW_ROUTING_CHOICE_SCENARIOS.map(({ id }) => id),
    [
      "new-request-stays-direct",
      "explicit-new-workflow-starts-fresh",
      "same-task-update-stays-out-of-model-tools",
      "ambiguous-runs-never-guessed",
    ],
  );
});

test("routing-choice rejects sending a new request to an old run", () => {
  const direct = WORKFLOW_ROUTING_CHOICE_SCENARIOS[0];
  assert.equal(evaluateWorkflowRoutingChoice(direct, []).passed, true);
  assert.equal(
    evaluateWorkflowRoutingChoice(direct, [
      { name: "workflow_steer", arguments: { runId: "run-old-a", message: "new request" } },
    ]).passed,
    false,
  );
});

test("routing-choice requires a fresh, parseable workflow script", () => {
  const fresh = WORKFLOW_ROUTING_CHOICE_SCENARIOS[1];
  assert.equal(
    evaluateWorkflowRoutingChoice(fresh, [
      {
        name: "start_workflow",
        arguments: { script: "export const meta = { name: 'storage-review', description: 'review' }\nreturn true" },
      },
    ]).passed,
    true,
  );
  assert.equal(
    evaluateWorkflowRoutingChoice(fresh, [{ name: "start_workflow", arguments: { script: "return {}" } }]).passed,
    false,
  );
  assert.match(
    evaluateWorkflowRoutingChoice(fresh, [{ name: "start_workflow", arguments: { script: "return {}" } }])
      .failureReasons[0],
    /script/i,
  );
  assert.equal(
    evaluateWorkflowRoutingChoice(fresh, [
      {
        name: "start_workflow",
        arguments: {
          script: "export const meta = { name: 'storage-review', description: 'review' }\nreturn runAgent('x')",
        },
      },
    ]).passed,
    false,
  );
  assert.match(
    evaluateWorkflowRoutingChoice(fresh, [
      {
        name: "start_workflow",
        arguments: {
          script: "export const meta = { name: 'storage-review', description: 'review' }\nreturn true",
          maxAgents: 3,
          concurrency: 3,
          agentRetries: 1,
        },
      },
    ]).failureReasons.join("\n"),
    /unsupported start-tool field|unrequested limit/i,
  );
  assert.match(
    evaluateWorkflowRoutingChoice(fresh, [
      {
        name: "start_workflow",
        arguments: {
          script: "export const meta = { name: 'storage-review', description: 'review' }\nreturn runAgent('x')",
        },
      },
    ]).failureReasons.join("\n"),
    /runAgent/i,
  );
  assert.equal(
    evaluateWorkflowRoutingChoice(fresh, [
      {
        name: "start_workflow",
        arguments: {
          script: "export const meta = { name: 'storage-review', description: 'review' }\nreturn true",
          resumeFromRunId: "run-old-a",
        },
      },
    ]).passed,
    false,
  );
  assert.equal(
    evaluateWorkflowRoutingChoice(fresh, [
      {
        name: "start_workflow",
        arguments: {
          script: "export const meta = { name: 'storage-review', description: 'review' }\nreturn true",
          tokenBudget: 12000,
        },
      },
    ]).passed,
    false,
  );
  assert.match(
    evaluateWorkflowRoutingChoice(fresh, [
      {
        name: "start_workflow",
        arguments: {
          script: "export const meta = { name: 'storage-review', description: 'review' }\nreturn true",
          workflowTimeoutMs: 30_000,
        },
      },
    ]).failureReasons.join("\n"),
    /unsupported start-tool field|unrequested limit/i,
  );
});

test("routing-choice accepts a curated preset as a fresh start", () => {
  const scenario = WORKFLOW_ROUTING_CHOICE_SCENARIOS.find(({ id }) => id === "explicit-new-workflow-starts-fresh");
  assert.ok(scenario);
  const result = evaluateWorkflowRoutingChoice(scenario, [
    { name: "start_workflow", arguments: { preset: "multi-perspective", args: { task: "review storage" } } },
  ]);
  assert.equal(result.passed, true);
});

test("same-task corrections and legacy steering calls stay out of model-facing routing", () => {
  const sameTask = WORKFLOW_ROUTING_CHOICE_SCENARIOS[2];
  assert.equal(evaluateWorkflowRoutingChoice(sameTask, []).passed, true);
  assert.equal(
    evaluateWorkflowRoutingChoice(sameTask, [
      { name: "workflow_steer", arguments: { runId: "run-old-a", message: "use auth-v2" } },
    ]).passed,
    false,
  );
});

test("routing-choice does not treat a provider error with zero calls as a pass", () => {
  const direct = WORKFLOW_ROUTING_CHOICE_SCENARIOS[0];
  const session: WorkflowRoutingSessionEvidence = {
    assistantMessages: 1,
    assistantStopReason: "error",
    assistantError: "Connection error",
    assistantHasContent: false,
  };
  const evaluation = evaluateWorkflowRoutingChoice(direct, [], session);
  assert.equal(evaluation.passed, false);
  assert.match(evaluation.failureReasons.join("\n"), /stopReason=error|Connection error/i);
});

test("routing-choice requires a real assistant response even when no tool is expected", () => {
  const direct = WORKFLOW_ROUTING_CHOICE_SCENARIOS[0];
  const evaluation = evaluateWorkflowRoutingChoice(direct, [], {
    assistantMessages: 0,
    assistantHasContent: false,
  });
  assert.equal(evaluation.passed, false);
  assert.match(evaluation.failureReasons.join("\n"), /no assistant response/i);
});

test("routing-choice still accepts a completed direct response with no tool call", () => {
  const direct = WORKFLOW_ROUTING_CHOICE_SCENARIOS[0];
  const evaluation = evaluateWorkflowRoutingChoice(direct, [], {
    assistantMessages: 1,
    assistantStopReason: "stop",
    assistantHasContent: true,
  });
  assert.equal(evaluation.passed, true);
});

test("routing-choice CLI is package-wired and optional", () => {
  assert.equal(packageJson.scripts["routing-choice"], "tsx scripts/run-workflow-routing-choice.ts");
  assert.doesNotMatch(packageJson.scripts.test, /routing-choice/i);
  const help = execFileSync(process.execPath, ["--import", "tsx", "scripts/run-workflow-routing-choice.ts", "--help"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.match(help, /--model <provider\/model>/i);
  assert.match(help, /four.*scenarios/i);
});
