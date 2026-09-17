import assert from "node:assert/strict";
import test from "node:test";
import { needsAgentReportReview, recordWorkflowReportReviews, workflowReportReviewId } from "../extensions/workflow.js";

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

test("new-protocol reports require their own explicit review receipt", () => {
  const report = {
    role: "custom",
    customType: "workflow-agent-completed",
    content: "finding",
    timestamp: 20,
    details: { deliveryId: "delivery-1", reviewProtocolVersion: 1 },
  };
  const reviewId = workflowReportReviewId(report);
  assert.ok(reviewId);
  const unrelated = {
    role: "assistant",
    timestamp: 30,
    stopReason: "stop",
    content: [{ type: "text", text: "answered a user question" }],
  };
  assert.equal(needsAgentReportReview([report, unrelated], 0), true);
  const reviewed = { ...unrelated, workflowReportsReviewed: [reviewId] };
  assert.equal(needsAgentReportReview([report, reviewed], 0), false);
});

test("review markers are request-scoped, final-only, and stripped from visible text", () => {
  const report = {
    role: "custom",
    customType: "workflow-deliver",
    content: "blocker",
    details: { deliveryId: "delivery-2", reviewProtocolVersion: 1 },
  };
  const reviewId = workflowReportReviewId(report);
  assert.ok(reviewId);
  const marker = `<!-- pi-workflow-report-reviewed:${reviewId} -->`;
  const progress = recordWorkflowReportReviews(
    { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: `working\n${marker}` }] },
    new Set([reviewId]),
  );
  assert.deepEqual(progress?.reviewed, []);
  assert.doesNotMatch(JSON.stringify(progress?.message.content), /pi-workflow-report-reviewed/);

  const completed = recordWorkflowReportReviews(
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: `done\n${marker}` }] },
    new Set([reviewId]),
  );
  assert.deepEqual(completed?.reviewed, [reviewId]);
  assert.deepEqual(completed?.message.workflowReportsReviewed, [reviewId]);
  assert.doesNotMatch(JSON.stringify(completed?.message.content), /pi-workflow-report-reviewed/);

  const unassociated = recordWorkflowReportReviews(
    { role: "assistant", stopReason: "stop", content: [{ type: "text", text: marker }] },
    new Set(),
  );
  assert.deepEqual(unassociated?.reviewed, []);
  assert.equal(unassociated?.message.workflowReportsReviewed, undefined);
});
