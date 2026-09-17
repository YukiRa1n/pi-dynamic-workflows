import assert from "node:assert/strict";
import test from "node:test";
import { needsAgentReportReview } from "../extensions/workflow.js";

test("new reports request review but historical reports do not regain priority", () => {
  const report = { role: "custom", customType: "workflow-agent-completed", timestamp: 20 };
  const response = {
    role: "assistant",
    timestamp: 30,
    stopReason: "toolUse",
    content: [{ type: "toolCall", name: "read" }],
  };
  assert.equal(needsAgentReportReview([report], 0), true);
  assert.equal(needsAgentReportReview([report, { role: "user", content: "new direction" }], 0), true);
  assert.equal(needsAgentReportReview([report, { ...response, timestamp: 10 }], 0), true);
  assert.equal(needsAgentReportReview([report, { ...response, stopReason: "error" }], 0), true);
  for (const name of ["get_workflow_output", "list_active_workflows"]) {
    assert.equal(
      needsAgentReportReview([report, { ...response, content: [{ type: "toolCall", name }] }], 0),
      true,
      "waiting is not evidence of reviewing a report",
    );
  }
  assert.equal(needsAgentReportReview([report, response], 0), false);
  assert.equal(needsAgentReportReview([report, response, { role: "user", content: "continue" }], 0), false);
});
