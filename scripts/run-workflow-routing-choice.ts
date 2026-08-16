import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  defineTool,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };
import {
  type CapturedWorkflowRoutingCall,
  evaluateWorkflowRoutingChoice,
  WORKFLOW_ROUTING_CHOICE_SCENARIOS,
  type WorkflowRoutingChoiceScenario,
  type WorkflowRoutingSessionEvidence,
} from "../src/workflow-routing-choice.js";
import { createWorkflowTool } from "../src/workflow-tool.js";

const ROOT = resolve(import.meta.dirname, "..");

interface CliOptions {
  model: string;
  output: string;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) return printUsage();
  const cli = parseArgs(process.argv.slice(2));
  const agentDir = getAgentDir();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  await modelRuntime.getAvailable();
  const registry = new ModelRegistry(modelRuntime);
  const resolved = resolveCliModel({ cliModel: cli.model, modelRuntime });
  if (resolved.error || !resolved.model) throw new Error(resolved.error ?? `Could not resolve ${cli.model}`);
  if (!registry.hasConfiguredAuth(resolved.model)) {
    throw new Error(`Selected model ${resolved.model.provider}/${resolved.model.id} is not currently available`);
  }

  const scenarios = [];
  for (const scenario of WORKFLOW_ROUTING_CHOICE_SCENARIOS) {
    process.stdout.write(`[routing-choice] ${scenario.id}\n`);
    scenarios.push(
      await runScenario(scenario, {
        modelRuntime,
        model: resolved.model,
        thinkingLevel: resolved.thinkingLevel,
      }),
    );
  }
  const output = {
    formatVersion: 1,
    extensionVersion: packageJson.version,
    modelSelection: {
      requested: cli.model,
      resolved: `${resolved.model.provider}/${resolved.model.id}`,
      thinkingLevel: resolved.thinkingLevel ?? null,
    },
    summary: {
      total: scenarios.length,
      passed: scenarios.filter(({ passed }) => passed).length,
      failed: scenarios.filter(({ passed }) => !passed).length,
    },
    scenarios,
  };
  await mkdir(dirname(cli.output), { recursive: true });
  await writeFile(cli.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`[routing-choice] ${output.summary.passed}/${output.summary.total} passed (non-blocking)\n`);
  process.stdout.write(`[routing-choice] evidence written to ${cli.output}\n`);
}

async function runScenario(
  scenario: WorkflowRoutingChoiceScenario,
  options: { modelRuntime: ModelRuntime; model: Model<Api>; thinkingLevel?: ModelThinkingLevel },
) {
  const root = await mkdtemp(join(tmpdir(), "workflow-routing-choice-"));
  const calls: CapturedWorkflowRoutingCall[] = [];
  // Match the production extension surface exactly: start-only, with no
  // per-call limits or replay/control fields. The full schema remains a
  // library compatibility option for embedders that explicitly opt in.
  const workflow = createWorkflowTool({
    cwd: root,
    allowResume: false,
    exposeAdvancedParameters: false,
    modelFacing: true,
  });
  const captureWorkflow = defineTool({
    name: workflow.name,
    label: workflow.label,
    description: workflow.description,
    promptGuidelines: workflow.promptGuidelines,
    parameters: workflow.parameters,
    // Keep capture behavior aligned with the production tool. This removes
    // optional fences and applies the same defensive argument validation
    // before the evaluator inspects a call.
    prepareArguments: workflow.prepareArguments,
    async execute(_id, params) {
      calls.push({ name: workflow.name, arguments: params });
      return {
        content: [{ type: "text" as const, text: "Captured workflow call." }],
        details: { captured: true },
        // Detached production workflows terminate the current model turn;
        // preserve that boundary so the model cannot make a second routing
        // decision after the first captured call.
        terminate: true,
      };
    },
  });
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    sessionManager: SessionManager.inMemory(root),
    tools: ["start_workflow"],
    customTools: [captureWorkflow],
  });
  try {
    // This is intentionally the user request only. Extra evaluator prose can
    // teach the model the expected answer and produce a false routing pass.
    let promptError: string | undefined;
    try {
      await session.prompt(scenario.prompt);
    } catch (error) {
      promptError = error instanceof Error ? error.message : String(error);
    }
    const sessionEvidence = inspectSessionResponse(session, promptError);
    const evaluation = evaluateWorkflowRoutingChoice(scenario, calls, sessionEvidence);
    const tokenUsage = sessionTokenUsage(session.getSessionStats());
    return {
      task: scenario,
      calls,
      session: sessionEvidence,
      tokenUsage,
      // Keep cache accounting explicit in the evidence file. These values are
      // sourced from Pi's session stats; providers that do not report cache
      // usage surface zero rather than an inferred hit.
      usage: tokenUsage,
      cache: { read: tokenUsage.cacheRead, write: tokenUsage.cacheWrite },
      ...evaluation,
    };
  } finally {
    session.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function inspectSessionResponse(
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  promptError?: string,
): WorkflowRoutingSessionEvidence {
  const assistants = session.messages.filter((message) => message.role === "assistant") as Array<{
    stopReason?: string;
    errorMessage?: string;
    content?: unknown[];
  }>;
  const lastAssistant = assistants.at(-1);
  return {
    promptError,
    assistantMessages: assistants.length,
    assistantStopReason: lastAssistant?.stopReason,
    assistantError: lastAssistant?.errorMessage,
    assistantHasContent: Array.isArray(lastAssistant?.content) && lastAssistant.content.length > 0,
  };
}

function sessionTokenUsage(
  stats: ReturnType<Awaited<ReturnType<typeof createAgentSession>>["session"]["getSessionStats"]>,
) {
  return {
    input: stats.tokens.input,
    output: stats.tokens.output,
    total: stats.tokens.total,
    cost: stats.cost,
    // Provider-reported cache accounting. Keep zeroes because they distinguish
    // a real zero from an SDK that did not expose cache fields at all.
    cacheRead: stats.tokens.cacheRead,
    cacheWrite: stats.tokens.cacheWrite,
  };
}

function parseArgs(args: string[]): CliOptions {
  let model: string | undefined;
  let output: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--model" && value) {
      model = value;
      index++;
    } else if (flag === "--output" && value) {
      output = resolve(value);
      index++;
    } else throw new Error(`Unknown or incomplete argument: ${flag ?? ""}`);
  }
  if (!model) throw new Error("--model <provider/model> is required; the harness never chooses implicitly");
  const safeModel = model.replaceAll(/[^a-zA-Z0-9._-]+/g, "-");
  return { model, output: output ?? join(ROOT, ".pi/model-comprehension", `routing-choice-${safeModel}.json`) };
}

function printUsage(): void {
  process.stdout.write(`Usage: npm run routing-choice -- --model <provider/model> [--output <path>]

Runs four optional model-facing scenarios for direct work, fresh workflows, and existing-run isolation.\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
