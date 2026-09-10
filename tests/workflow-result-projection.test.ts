import assert from "node:assert/strict";
import test from "node:test";
import { summarizeWorkflowResult } from "../src/workflow-result-projection.js";

test("long Chinese results retain the real final caveat within the byte budget", () => {
  const ending = "最终结论：暂不发布，仍需验证。✅";
  const output = summarizeWorkflowResult("背景说明。".repeat(1000) + ending, 800);
  assert.ok(output.endsWith(ending));
  assert.ok(Buffer.byteLength(output, "utf8") <= 800);
  assert.ok(!output.includes("\ufffd"));
});

test("mixed emoji and ASCII tails never split a code point", () => {
  for (const limit of [128, 200, 500, 1000]) {
    const output = summarizeWorkflowResult(`${"details ".repeat(1000)}${"🚀".repeat(100)}END`, limit);
    assert.ok(output.endsWith("END"));
    assert.equal(Buffer.from(output).toString("utf8"), output);
    assert.ok(Buffer.byteLength(output) <= limit);
  }
});
