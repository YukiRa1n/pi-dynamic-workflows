import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentUsage } from "../src/agent.js";
import { BUILTIN_WORKFLOW_NAMES } from "../src/builtin-workflows.js";
import { WorkflowError, WorkflowErrorCode } from "../src/errors.js";
import { WorkflowManager } from "../src/workflow-manager.js";
import { createWorkflowStorage } from "../src/workflow-saved.js";
import { backgroundStartedText, createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

/** Minimal fake ModelRegistry, matching the shape used by workflow manager tests. */
function fakeRegistry(models: Array<{ provider: string; id: string }>) {
  return {
    getAvailable: () => models,
    find: () => undefined,
    getAll: () => models,
  } as any;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parameterDescription(tool: ReturnType<typeof createWorkflowTool>, name: string): string {
  const parameters = tool.parameters;
  const properties = isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : {};
  const parameter = properties[name];
  return isRecord(parameter) && typeof parameter.description === "string" ? parameter.description : "";
}

// ─── backgroundStartedText ─────────────────────────────────────────────────────

test("backgroundStartedText is a compact automatic-delivery acknowledgement", () => {
  const text = backgroundStartedText("audit", "abc-123");
  assert.match(text, /audit/);
  assert.match(text, /abc-123/);
  assert.match(text, /started in background/i);
  assert.match(text, /result returns automatically/i);
  assert.doesNotMatch(text, /end this turn|do not poll|keep chatting|\/workflows/i);
});

// ─── createWorkflowTool ────────────────────────────────────────────────────────

test("createWorkflowTool has correct name and label", () => {
  const tool = createWorkflowTool();
  assert.equal(tool.name, "workflow");
  assert.equal(tool.label, "Workflow");
});

test("createWorkflowTool description stays focused on background execution", () => {
  const description = createWorkflowTool().description;

  assert.equal(
    description,
    "Start a new background workflow for an explicitly requested multi-agent task. Provide a saved name or JavaScript using agent(), parallel(), and pipeline(); results return automatically. Existing runs use /workflows.",
  );
});

test("createWorkflowTool has parameters defined", () => {
  const tool = createWorkflowTool();
  assert.ok(tool.parameters, "should have parameters schema");
});

test("createWorkflowTool has execute function", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWorkflowTool has renderCall and renderResult", () => {
  const tool = createWorkflowTool();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");
});

test("createWorkflowTool omits a duplicate Available tools snippet", () => {
  assert.equal(createWorkflowTool().promptSnippet, undefined);
});

test("createWorkflowTool keeps provider guidance in the schema and description", () => {
  const tool = createWorkflowTool({ allowResume: false });
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(tool.promptSnippet, undefined);
  assert.match(tool.description, /start a new background workflow/i);
});

test("createWorkflowTool keeps script syntax in the parameter schema", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "script");

  assert.match(description, /JavaScript workflow/i);
  assert.match(description, /agent\(/i);
  assert.ok(Buffer.byteLength(description, "utf8") < 150, "syntax summary stays compact");

  assert.equal(tool.promptGuidelines, undefined, "script mechanics stay out of a permanent prompt block");
});

test("createWorkflowTool declares `args` as an explicitly typed object, not a typeless Type.Any() schema", () => {
  // Regression test: `args` used to be `Type.Any()`, which compiles to a
  // schema with no "type" keyword at all (just `{ description }`). At least
  // one MCP/tool-calling bridge does not treat a typeless property as
  // "accept any JSON value" — it coerces/flattens the value before the
  // handler ever sees it, so every named built-in pattern's required args
  // field (e.g. `args.scope` for codebase-audit, `args.question` for
  // deep-research) silently arrives as `undefined`, regardless of what the
  // caller actually sent — making name-based invocation of every built-in
  // pattern fail on that bridge. Every built-in pattern's `args` is a JSON
  // object at the top level, so it must be declared `type: "object"`.
  const tool = createWorkflowTool();
  const parameters = tool.parameters as { properties: Record<string, unknown> };
  const argsSchema = parameters.properties.args as Record<string, unknown> | undefined;

  assert.ok(argsSchema, "tool.parameters.properties.args should exist");
  assert.equal(argsSchema?.type, "object", "args schema must declare an explicit object type");
  assert.equal(
    typeof argsSchema?.description,
    "string",
    "args schema should keep its description alongside the explicit type",
  );
});

test("createWorkflowTool is background-only and exposes no foreground toggle", () => {
  const tool = createWorkflowTool();
  const parameters = tool.parameters as unknown as { properties?: Record<string, unknown> };
  assert.equal(parameters.properties?.background, undefined);
  assert.doesNotMatch(JSON.stringify(tool.parameters), /background:false|result inline/i);
  assert.throws(
    () => tool.prepareArguments?.({ script: resumeToolScript, background: false }),
    /background-only/,
    "defense-in-depth rejects legacy callers that bypass the schema",
  );
});

test("createWorkflowTool schema keeps the per-agent timeout opt-in", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "agentTimeoutMs");

  assert.equal(description, "Per-call timeout (ms).");
});

test("createWorkflowTool schema forbids inferred token budgets", () => {
  const tool = createWorkflowTool();
  const description = parameterDescription(tool, "tokenBudget");

  assert.equal(description, "User-requested soft cap; omit otherwise.");
  assert.doesNotMatch(description, /never|do not/i);
});

test("createWorkflowTool schema exposes resource controls and large-fan-out authority", () => {
  const tool = createWorkflowTool();

  assert.equal(parameterDescription(tool, "concurrency"), "Maximum concurrent calls.");
  assert.equal(parameterDescription(tool, "agentRetries"), "Retries per agent() call.");
  assert.equal(parameterDescription(tool, "maxAgents"), "Maximum agent() calls.");
});

test("createWorkflowTool invalid args throws descriptive error", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => unknown;
    assert.throws(() => prepare({ script: 123 }), /script.*string/);
    assert.throws(() => prepare("not-an-object"), /object argument/);
    assert.throws(() => prepare({}), /script.*name/i, "neither `script` nor `name` should throw clearly");
    // A malformed `script` alongside `name` must not be silently coerced away
    // — it should throw the same way a malformed script-only call does.
    assert.throws(() => prepare({ name: "deep-research", script: 123 }), /script.*string/i);
  }
});

test("createWorkflowTool with custom cwd creates tool", () => {
  const tool = createWorkflowTool({ cwd: "/tmp" });
  assert.equal(tool.name, "workflow");
});

test("createWorkflowTool does not add configured model IDs to permanent guidance", () => {
  const manager = new WorkflowManager({ cwd: "/tmp" });
  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "private-model" }]));
  const tool = createWorkflowTool({ cwd: "/tmp", manager });

  assert.doesNotMatch(JSON.stringify(tool), /router\/private-model/);

  manager.setModelRegistry(fakeRegistry([{ provider: "router", id: "later-private-model" }]));
  assert.doesNotMatch(JSON.stringify(tool), /router\/later-private-model/);
});

// ─── prepareArguments / normalizeWorkflowScript ─────────────────────────────────

test("createWorkflowTool prepareArguments strips markdown fences from script", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```js\nconst x = 1\n```",
    });
    assert.equal(result.script, "const x = 1");
  }
});

test("createWorkflowTool prepareArguments strips javascript fences", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => { script: string };
    const result = prepare({
      script: "```\nexport const meta = { name: 't', description: 't' }\n```",
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
  }
});

test("createWorkflowTool prepareArguments passes through args", () => {
  const tool = createWorkflowTool();
  if (tool.prepareArguments) {
    const prepare = tool.prepareArguments as (args: unknown) => {
      script: string;
      args?: unknown;
      maxAgents?: number;
      concurrency?: number;
      agentRetries?: number;
    };
    const result = prepare({
      script: "export const meta = { name: 't', description: 't' }",
      args: { question: "test" },
      maxAgents: 5,
      concurrency: 2,
      agentRetries: 1,
    });
    assert.equal(result.script, "export const meta = { name: 't', description: 't' }");
    assert.deepEqual(result.args, { question: "test" });
    assert.equal(result.maxAgents, 5);
    assert.equal(result.concurrency, 2);
    assert.equal(result.agentRetries, 1);
  }
});

// ─── resumeFromRunId (edited-script iteration) ─────────────────────────────────

const resumeToolScript = `export const meta = { name: 'resume_tool', description: 'one agent' }
const a = await agent('do it', { label: 'a' })
return { a }`;

function toolFakeAgent(result: unknown = "ok") {
  return {
    async run(_prompt: string, options?: { onUsage?: (u: AgentUsage) => void }) {
      options?.onUsage?.({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 });
      return result;
    },
  };
}

function deferredToolAgent() {
  let resolveFn: ((v: unknown) => void) | null = null;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });
  return {
    resolve: (v: unknown = "done") => resolveFn?.(v),
    runner: {
      async run() {
        return promise;
      },
    },
  };
}

function withToolTempCwd(fn: (cwd: string) => Promise<void>) {
  return async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-dw-tool-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "pi-dw-tool-home-"));
    try {
      await withFakeHomeAsync(fakeHome, () => fn(cwd));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  };
}

test("workflowToolSchema exposes resumeFromRunId, script, and name as optional at the schema level", () => {
  const tool = createWorkflowTool({ allowResume: true });
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
  assert.ok(schema.properties.resumeFromRunId, "resumeFromRunId should be a schema property");
  assert.ok(schema.properties.name, "name should be a schema property");
  // Neither `script` nor `name` is in the schema's `required` list — exactly one
  // is required at runtime (normalizeWorkflowToolArgs enforces it), because
  // TypeBox's flat object schema can't express an either/or constraint.
  assert.ok(!(schema.required ?? []).includes("script"), "script is schema-optional (name is the alternative)");
  assert.ok(!(schema.required ?? []).includes("name"), "name is schema-optional (script is the alternative)");
  assert.ok(!(schema.required ?? []).includes("resumeFromRunId"), "resumeFromRunId is optional");
});

test("extension-facing workflow schema is start-only", () => {
  const tool = createWorkflowTool({ allowResume: false, exposeAdvancedParameters: false, modelFacing: true });
  const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };

  assert.equal(tool.name, "start_workflow");
  assert.equal(schema.properties.resumeFromRunId, undefined, "extension surface must not advertise resume");
  for (const field of [
    "maxAgents",
    "concurrency",
    "agentRetries",
    "agentTimeoutMs",
    "workflowTimeoutMs",
    "tokenBudget",
  ]) {
    assert.equal(schema.properties[field], undefined, `extension surface must not advertise ${field}`);
  }
  assert.ok(schema.properties.preset, "extension surface should expose curated presets, not arbitrary names");
  assert.equal(schema.properties.name, undefined, "extension surface must not accept arbitrary saved/run names");
  assert.equal((tool.parameters as Record<string, unknown>).additionalProperties, false);
  assert.equal(tool.promptGuidelines, undefined);
  assert.match(tool.description, /existing runs use \/workflows/i);
  const prepared = tool.prepareArguments?.({ script: "await agent('inspect', { label: 'inspect' })" }) as {
    script: string;
  };
  assert.match(prepared.script, /^export const meta =/);
  assert.throws(
    () => tool.prepareArguments?.({ script: resumeToolScript, resumeFromRunId: "run-1" }),
    /unsupported field|starts a new run.*workflows/i,
  );
  assert.throws(
    () => tool.prepareArguments?.({ script: resumeToolScript, workflowTimeoutMs: 1 }),
    /unsupported field/i,
  );
  assert.throws(() => tool.prepareArguments?.({ preset: "run-old-a" }), /preset.*one of/i);
});

test(
  "extension-facing start keeps the main model turn alive for a normal acknowledgement",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({
      cwd,
      manager,
      allowResume: false,
      exposeAdvancedParameters: false,
      modelFacing: true,
    });

    const result = await tool.execute("model-start", { script: resumeToolScript }, undefined, undefined, undefined);
    assert.notEqual(result.terminate, true, "start_workflow must not terminate the main model turn");
    const details = result.details as { runId?: string; background?: boolean };
    assert.ok(details.runId);
    assert.equal(details.background, true);
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a nonexistent run errors and creates no new run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager, allowResume: true });
    await assert.rejects(
      () =>
        tool.execute(
          "t1",
          { script: resumeToolScript, resumeFromRunId: "no-such-run" },
          undefined,
          undefined,
          undefined,
        ),
      /no run with that ID|not found/i,
    );
    assert.equal(manager.listRuns().length, 0, "no new run should be created on a failed resume");
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a completed run errors clearly",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager, allowResume: true });
    // Create + complete a run.
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await promise;
    assert.equal(manager.getRun(runId)?.status, "completed");
    await assert.rejects(
      () => tool.execute("t2", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, undefined),
      /already completed/i,
    );
  }),
);

test(
  "workflow tool: resumeFromRunId pointing at a running run errors clearly",
  withToolTempCwd(async (cwd) => {
    const da = deferredToolAgent();
    const manager = new WorkflowManager({ cwd, agent: da.runner });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, allowResume: true });
    const { runId, promise } = manager.startInBackground(resumeToolScript);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(manager.getRun(runId)?.status, "running");
    await assert.rejects(
      () => tool.execute("t3", { script: resumeToolScript, resumeFromRunId: runId }, undefined, undefined, undefined),
      /still running/i,
    );
    da.resolve("ok");
    await promise.catch(() => {});
  }),
);

test(
  "workflow tool: omitting resumeFromRunId preserves new-run background behavior",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent() });
    const tool = createWorkflowTool({ cwd, manager, allowResume: true });
    const res = await tool.execute("t4", { script: resumeToolScript }, undefined, undefined, undefined);
    const details = res.details as { runId?: string; background?: boolean; resumedFrom?: string };
    assert.ok(details.runId, "a new run id should be returned");
    assert.equal(details.background, true);
    assert.equal(details.resumedFrom, undefined, "a fresh run is not a resume");
    assert.equal(res.terminate, true, "starting a detached run terminates the current model turn");
    assert.equal(manager.listRuns().length, 1, "exactly one new run created");
    // The compact result ends the turn and leaves revision guidance on demand.
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.match(text, /result returns automatically/i);
    assert.doesNotMatch(text, /resumeFromRunId/, "background acknowledgement stays lean");
  }),
);

test(
  "workflow tool: resumeFromRunId resumes a paused run with the edited script",
  withToolTempCwd(async (cwd) => {
    const seen: string[] = [];
    let failSecond = true;
    const manager = new WorkflowManager({
      cwd,
      agent: {
        async run(prompt: string) {
          seen.push(prompt);
          if (prompt.includes("SECOND-ORIG") && failSecond) {
            throw new WorkflowError("usage limit", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, {
              recoverable: false,
              resetHint: "soon",
            });
          }
          return `ran:${prompt}`;
        },
      },
    });
    manager.on("paused", () => {});
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, allowResume: true });

    const v1 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-ORIG', { label: 'second' })
return { a, b }`;
    const { runId, promise } = manager.startInBackground(v1);
    await promise.catch(() => {});
    assert.equal(manager.getRun(runId)?.status, "paused");

    failSecond = false;
    const v2 = `export const meta = { name: 'iter', description: 'two' }
const a = await agent('FIRST', { label: 'first' })
const b = await agent('SECOND-EDITED', { label: 'second' })
return { a, b }`;
    const seenBefore = seen.length;
    const res = await tool.execute("t5", { script: v2, resumeFromRunId: runId }, undefined, undefined, undefined);
    const details = res.details as { runId?: string; resumedFrom?: string };
    assert.equal(details.runId, runId, "resumed run keeps the same run id");
    assert.equal(details.resumedFrom, runId);
    assert.equal(res.terminate, true, "resuming a detached run terminates the current model turn");
    const text = res.content?.[0]?.type === "text" ? res.content[0].text : "";
    assert.ok(text.includes(`resumed (run ${runId})`), "text names the resumed run");

    await new Promise((r) => setTimeout(r, 80));
    const finalRun = manager.getRun(runId);
    assert.equal(finalRun?.status, "completed");
    assert.equal(finalRun?.result?.result?.b, "ran:SECOND-EDITED");
    const during = seen.slice(seenBefore);
    assert.ok(!during.includes("FIRST"), "unchanged agent 1 replays from journal");
    assert.ok(during.includes("SECOND-EDITED"), "edited agent 2 re-runs live");
    // No extra run created — resume reuses the same id.
    assert.equal(manager.listRuns().length, 1, "resume does not create a second run");
  }),
);

// ─── `name`: reach a saved or built-in workflow without writing a script ───────

const validArgsByBuiltinName: Record<string, unknown> = {
  "deep-research": { question: "what is pi?" },
  "adversarial-review": { task: "investigate this" },
  "code-review": { diff: "some diff" },
  "multi-perspective": { topic: "a topic" },
  "codebase-audit": { scope: "src/", checks: ["security"] },
};

test(
  "workflow tool: `name` resolves each of the 5 built-in patterns and starts a run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, allowResume: true });

    for (const name of BUILTIN_WORKFLOW_NAMES) {
      const res = await tool.execute(
        `name-${name}`,
        { name, args: validArgsByBuiltinName[name] },
        undefined,
        undefined,
        undefined,
      );
      const details = res.details as { runId?: string; background?: boolean };
      const runId = details.runId;
      assert.ok(runId, `${name} should start a run`);
      assert.equal(details.background, true);
      const managed = manager.getRun(runId);
      assert.ok(managed, `${name} run should be tracked by the manager`);
    }
    // Let the fire-and-forget background runs settle before the test tears down.
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: `name` carries deep-research's web-research exec context through the run",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager });
    const res = await tool.execute(
      "name-deep-research",
      { name: "deep-research", args: { question: "what is pi?" } },
      undefined,
      undefined,
      undefined,
    );
    const details = res.details as { runId?: string };
    const runId = details.runId;
    assert.ok(runId, "deep-research should start a run");
    const managed = manager.getRun(runId);
    assert.equal(managed?.toolset, "web-research", "the run should carry the web-research toolset tag");
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "workflow tool: a saved workflow of the same name takes precedence over a built-in",
  withToolTempCwd(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    const customScript = "export const meta = { name: 'custom_deep_research', description: 'override' }\nreturn 1";
    storage.save({ name: "deep-research", description: "custom override", script: customScript });
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, storage });

    const res = await tool.execute(
      "name-precedence",
      { name: "deep-research", args: { question: "irrelevant here" } },
      undefined,
      undefined,
      undefined,
    );
    const details = res.details as { runId?: string };
    const runId = details.runId;
    assert.ok(runId, "the run should start");
    const managed = manager.getRun(runId);
    assert.equal(managed?.snapshot.name, "custom_deep_research", "the saved workflow should win, not the built-in");
    assert.equal(managed?.toolset, undefined, "the saved workflow does not carry the built-in's exec context");
    await new Promise((r) => setTimeout(r, 50));
  }),
);

test(
  "model-facing workflow preset cannot be shadowed by a saved workflow",
  withToolTempCwd(async (cwd) => {
    const storage = createWorkflowStorage(cwd);
    storage.save({
      name: "deep-research",
      description: "saved shadow",
      script: "export const meta = { name: 'shadow', description: 'shadow' }\nreturn 1",
    });
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    manager.on("error", () => {});
    const tool = createWorkflowTool({ cwd, manager, storage, modelFacing: true, exposeAdvancedParameters: false });

    const res = await tool.execute(
      "preset-shadow-fence",
      { preset: "deep-research", args: { question: "what is pi?" } },
      undefined,
      undefined,
      undefined,
    );
    const runId = (res.details as { runId?: string }).runId;
    assert.ok(runId);
    const managed = manager.getRun(runId);
    assert.equal(managed?.snapshot.name, "deep_research");
    assert.equal(managed?.toolset, "web-research");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }),
);

test(
  "workflow tool: an unknown `name` throws a clear error naming the built-ins",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("bad-name", { name: "not-a-real-workflow" }, undefined, undefined, undefined),
      /no saved or built-in workflow named "not-a-real-workflow"/,
    );
  }),
);

test(
  "workflow tool: invalid args for a built-in surface a descriptive error",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager });
    await assert.rejects(
      () => tool.execute("bad-args", { name: "deep-research", args: {} }, undefined, undefined, undefined),
      /question/,
    );
  }),
);

test(
  "workflow tool: `name` cannot be combined with `resumeFromRunId`",
  withToolTempCwd(async (cwd) => {
    const manager = new WorkflowManager({ cwd, agent: toolFakeAgent("ok") });
    const tool = createWorkflowTool({ cwd, manager, allowResume: true });
    await assert.rejects(
      () =>
        tool.execute(
          "bad-combo",
          { name: "deep-research", args: { question: "q" }, resumeFromRunId: "some-run" },
          undefined,
          undefined,
          undefined,
        ),
      /cannot be combined with `resumeFromRunId`/,
    );
  }),
);
