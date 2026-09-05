import assert from "node:assert/strict";
import test from "node:test";
import { buildLiveWorkflowDemoPrompt, LIVE_WORKFLOW_DEMO_SCRIPT, renderWorkflowDemo } from "../src/workflow-demo.js";
import { auditWorkflowScript } from "../src/workflow-script-gate.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

test("live demo script passes the production gate and limits work to two fixed agents", () => {
  assert.deepEqual(auditWorkflowScript(LIVE_WORKFLOW_DEMO_SCRIPT), []);
  assert.equal(LIVE_WORKFLOW_DEMO_SCRIPT.match(/=> agent\(/g)?.length, 2);
  const prompt = buildLiveWorkflowDemoPrompt();
  assert.match(prompt, /workflow-demo-sample.txt/);
  assert.match(prompt, /退出码1是预期/);
  assert.match(prompt, /不要伪造用户消息/);
});

test("workflow demo renders compact and detailed states without navigation hints", () => {
  const lines = renderWorkflowDemo(theme as never, 120, 2_000, 1_000);
  const text = lines.join("\n");

  assert.match(text, /Compact live panel/);
  assert.match(text, /codebase_audit {2}0\/5 agents · 5 running/);
  assert.doesNotMatch(lines.find((line) => line.includes("codebase_audit")) ?? "", /Checks|check-1/);
  assert.match(text, /Detailed state showcase/);
  assert.match(text, /completed_check/);
  assert.match(text, /running_check/);
  assert.match(text, /queued_check/);
  assert.match(text, /failed_check/);
  assert.match(text, /skipped_check/);
  assert.doesNotMatch(text, /open · ↑\/↓ select|\/workflows fallback/);
});
