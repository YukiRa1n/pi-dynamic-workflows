import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { resolveModelForPhase } from "../src/model-routing.js";
import { resolveModelSpecWithThinking } from "../src/model-spec.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import { type SchedulableWorkflowManager, UsageLimitScheduler } from "../src/usage-limit-scheduler.js";
import { blockedAddress, createWebFetchTool, createWebSearchTool } from "../src/web-tools.js";
import { createGetWorkflowOutputTool, type GetWorkflowOutputResultDetails } from "../src/workflow-control-tool.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

function model(provider: string, id: string): Model<Api> {
  return { provider, id, name: id } as Model<Api>;
}

function registry(models: Model<Api>[]): Pick<ModelRegistry, "getAll"> {
  return { getAll: () => models };
}

function runState(runId: string): PersistedRunState {
  return {
    runId,
    workflowName: "boundary-test",
    script: "export const meta = { name: 'boundary-test', description: 'boundary test' }; return await agent('x')",
    status: "paused",
    phases: [],
    agents: [],
    logs: [],
    startedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

test("resuming an unknown persisted toolset fails closed", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-dw-unknown-toolset-"));
  let agentCalls = 0;
  try {
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run() {
          agentCalls++;
          return "should not run";
        },
      },
      toolsets: {},
    });
    manager.on("error", () => {});
    const persisted = { ...runState("unknown-toolset-1"), toolset: "missing-web-research" };
    manager.getPersistence().save(persisted);

    assert.equal(await manager.resume(persisted.runId), true);
    const execution = manager.getRun(persisted.runId)?.execution;
    assert.ok(execution);
    await assert.rejects(execution, (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.PERSISTENCE_ERROR);
      assert.match(error.message, /unknown persisted workflow toolset.*missing-web-research/i);
      assert.match(error.message, /cannot resume safely/i);
      return true;
    });
    assert.equal(agentCalls, 0);
    assert.equal(manager.getRun(persisted.runId)?.status, "failed");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid and ReDoS-shaped phase patterns are rejected", () => {
  assert.throws(
    () =>
      resolveModelForPhase("anything", {
        routes: [{ phasePattern: "[invalid", model: "bad", useRegex: true }],
      }),
    /Invalid phasePattern regex/,
  );
  assert.throws(
    () =>
      resolveModelForPhase("aaaa", {
        routes: [{ phasePattern: "(a+)+", model: "bad", useRegex: true }],
      }),
    /nested quantifiers/,
  );
  // Exponential-backtracking alternation shapes must also be rejected, not just
  // nested quantifiers: (a|aa)+$ and (a|a?)+$ backtrack catastrophically on long
  // non-matching input but slip past a nested-quantifier-only check.
  for (const pattern of ["(a|aa)+$", "(a|a?)+$", "(x|xy)*"]) {
    assert.throws(
      () =>
        resolveModelForPhase("aaaaaaaaaaaaaaaaaaaaaaab", {
          routes: [{ phasePattern: pattern, model: "bad", useRegex: true }],
        }),
      /quantified alternation/,
      `expected ${pattern} to be rejected`,
    );
  }
  // Nested groups hiding a quantifier must be caught at any depth: peeling the
  // inner groups exposes (X)+ over a quantified inner expression.
  for (const pattern of ["^((a+))+$", "(?:(a+))+$", "((a|aa)+)+"]) {
    assert.throws(
      () =>
        resolveModelForPhase("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab", {
          routes: [{ phasePattern: pattern, model: "bad", useRegex: true }],
        }),
      /not allowed/,
      `expected nested ${pattern} to be rejected`,
    );
  }
  assert.throws(
    () =>
      resolveModelForPhase("anything", {
        routes: [{ phasePattern: "a".repeat(201), model: "bad", useRegex: true }],
      }),
    /200-character limit/,
  );
});

test("provider slash with an empty model id is rejected", () => {
  const resolved = resolveModelSpecWithThinking("provider/", registry([model("provider", "top-alias")]));
  assert.equal(resolved.model, undefined);
  assert.match(resolved.error ?? "", /non-empty model id/i);

  const withThinking = resolveModelSpecWithThinking("provider/:high", registry([model("provider", "top-alias")]));
  assert.equal(withThinking.model, undefined);
  assert.match(withThinking.error ?? "", /non-empty model id/i);
});

test("workflow script size and name/script exclusivity are enforced", () => {
  const tool = createWorkflowTool({});
  const prepare = tool.prepareArguments as (value: unknown) => unknown;

  assert.throws(
    () => prepare({ script: "x".repeat(10 * 1024 * 1024 + 1) }),
    (error: unknown) => {
      assert.ok(error instanceof WorkflowError);
      assert.equal(error.code, WorkflowErrorCode.RESOURCE_LIMIT_EXCEEDED);
      return true;
    },
  );
  assert.throws(() => prepare({ name: "deep-research", script: "return 1" }), /either `name` or `script`/);
});

test("web search rejects non-finite and non-integer counts", async () => {
  const tool = createWebSearchTool();
  for (const count of [Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    await assert.rejects(
      () => (tool.execute as any)("count-boundary", { query: "ignored", count }),
      /count must be a finite integer/,
    );
  }
});

test("IANA AS112 and AMT ranges are blocked", () => {
  assert.equal(blockedAddress("192.31.196.1"), true);
  assert.equal(blockedAddress("192.52.193.1"), true);
});

test("web fetch errors redact URL userinfo", async () => {
  const tool = createWebFetchTool();
  const response = await (tool.execute as any)("fetch-boundary", {
    url: "https://alice:super-secret@example.com/",
  });
  const text = response.content[0].text as string;
  assert.match(text, /web_fetch failed/i);
  assert.doesNotMatch(text, /alice|super-secret/);
  assert.equal(response.details.url, "https://***@example.com/");
});

test("workflow output errors redact messages and paths while preserving code/recoverable", async () => {
  const failedRun = { ...runState("redaction-1"), status: "failed" as const, sessionId: "session-a" };
  const failure = new WorkflowError(
    "provider failed at C:\\Users\\alice\\secret\\run.json (https://alice:secret@example.com)",
    WorkflowErrorCode.AGENT_EXECUTION_ERROR,
    { recoverable: true },
  );
  const manager = {
    getSessionId: () => "session-a",
    listRuns: () => [failedRun],
    getRun: () => ({ error: failure }),
    getPersistence: () => ({ getRunsDir: () => "D:\\workflow-runs" }),
  } as unknown as import("../src/workflow-manager.js").WorkflowManager;
  const tool = createGetWorkflowOutputTool({ manager });
  const response = (await (tool.execute as any)(
    "output-boundary",
    { runId: failedRun.runId, block: false },
    undefined,
    undefined,
    {},
  )) as { content: Array<{ text: string }>; details: GetWorkflowOutputResultDetails };
  const text = response.content[0].text;
  assert.doesNotMatch(text, /C:\\Users\\alice|alice:secret|D:\\workflow-runs/);
  assert.equal(response.details.errorCode, WorkflowErrorCode.AGENT_EXECUTION_ERROR);
  assert.equal(response.details.recoverable, true);
});

test("usage-limit scheduler rejects invalid numeric options", () => {
  const manager = new EventEmitter() as unknown as SchedulableWorkflowManager;
  const invalidOptions = [
    { maxAttempts: Number.NaN },
    { maxAttempts: Number.POSITIVE_INFINITY },
    { maxAttempts: 0 },
    { minDelayMs: -1 },
    { minDelayMs: Number.NaN },
    { fallbackDelayMs: Number.POSITIVE_INFINITY },
    { maxDelayMs: -1 },
    { maxArmedTimers: 0 },
    { maxArmedTimers: Number.NaN },
  ];
  for (const options of invalidOptions) {
    assert.throws(() => new UsageLimitScheduler(manager, options), RangeError);
  }
});
