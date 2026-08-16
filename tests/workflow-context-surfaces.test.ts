import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import packageJson from "../package.json" with { type: "json" };
import {
  checkWorkflowContextMeasurement,
  measureWorkflowContextSurfaces,
  renderWorkflowContextMeasurement,
  WORKFLOW_CONTEXT_MEASUREMENT_PATH,
} from "../src/workflow-context-measurement.js";
import { createWorkflowTool } from "../src/workflow-tool.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

const ROOT = join(import.meta.dirname, "..");
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

test("workflow context measurement reports Pi-rendered prompt and provider tool definition separately", async () => {
  const artifact = measureWorkflowContextSurfaces(ROOT);
  assert.deepEqual(JSON.parse(renderWorkflowContextMeasurement()), artifact);

  assert.equal(artifact.formatVersion, 9);
  assert.equal(artifact.encoding, "utf8");
  assert.deepEqual(artifact.sources, [
    "src/workflow-tool.ts",
    "src/workflow-control-tool.ts",
    "src/workflow-editor.ts",
    "skills/workflow-authoring",
    "package.json#pi.skills",
  ]);
  assert.match(artifact.surfaces.permanentWorkflowPrompt.serialization, /stable/i);
  assert.match(artifact.surfaces.providerVisibleWorkflowToolDefinition.serialization, /stable/i);
  assert.deepEqual(
    artifact.surfaces.providerVisibleAlwaysOnToolDefinitions.tools.map((tool) => tool.name),
    ["start_workflow", "list_active_workflows", "get_workflow_output", "stop_workflow"],
  );
  assert.ok(artifact.surfaces.providerVisibleAlwaysOnToolDefinitions.bytes > 0);
  assert.equal(
    artifact.surfaces.providerVisibleAlwaysOnToolDefinitions.bytes,
    artifact.surfaces.providerVisibleAlwaysOnToolDefinitions.tools.reduce((sum, tool) => sum + tool.bytes, 0),
  );
  // Every skill in package.json's pi.skills contributes to the always-on
  // discovery tally — not just workflow-authoring — so adding a new skill
  // can't silently go untracked (see the workflow-patterns skill).
  assert.match(artifact.surfaces.registeredSkillsDiscovery.serialization, /pi\.skills/i);
  assert.ok(artifact.surfaces.registeredSkillsDiscovery.bytes > 0);
  assert.deepEqual(
    artifact.surfaces.registeredSkillsDiscovery.skills.map(({ root }) => root).sort(),
    [...packageJson.pi.skills].sort(),
  );
  assert.equal(
    artifact.surfaces.registeredSkillsDiscovery.bytes,
    artifact.surfaces.registeredSkillsDiscovery.skills.reduce((sum, skill) => sum + skill.bytes, 0),
    "the total must be the exact sum of each registered skill's own discovery bytes",
  );
  for (const skill of artifact.surfaces.registeredSkillsDiscovery.skills) {
    assert.ok(skill.bytes > 0, `${skill.root} should report a positive discovery byte count`);
  }
  assert.equal(
    artifact.surfaces.explicitWorkflowRequestOwnedContext.bytes,
    artifact.surfaces.permanentWorkflowPrompt.bytes +
      artifact.surfaces.providerVisibleAlwaysOnToolDefinitions.bytes +
      artifact.surfaces.armedWorkflowPromptRewrite.bytes,
  );
  assert.ok(artifact.surfaces.armedWorkflowPromptRewrite.bytes < 240);
  assert.ok(artifact.surfaces.forcedWorkflowPromptRewrite.bytes < 96);
  assert.equal(
    artifact.surfaces.stableWorkflowOwnedContext.bytes,
    artifact.surfaces.permanentWorkflowPrompt.bytes + artifact.surfaces.providerVisibleAlwaysOnToolDefinitions.bytes,
  );
  assert.equal(
    artifact.surfaces.ordinaryWorkflowOwnedAlwaysOn.bytes,
    artifact.surfaces.providerVisibleAlwaysOnToolDefinitions.bytes + artifact.surfaces.registeredSkillsDiscovery.bytes,
  );
  assert.ok(
    artifact.surfaces.ordinaryWorkflowOwnedAlwaysOn.bytes <= 2_000,
    "ordinary turns keep the stable workflow tools and skill discovery below 2 KiB",
  );
  assert.ok(
    artifact.surfaces.explicitWorkflowRequestOwnedContext.bytes <= 1_800,
    "explicit workflow turns keep the stable tool and request suffix below 1.8 KiB",
  );
  assert.equal(artifact.surfaces.workflowAuthoringSkillCorpus.files, 28);
  assert.ok(artifact.surfaces.workflowAuthoringSkillCorpus.bytes > 0);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.profiles.length, 6);
  assert.deepEqual(
    artifact.surfaces.representativeAuthoringProfiles.profiles.map(({ name }) => name),
    ["write", "edit", "review", "debug", "loop", "retry"],
  );
  for (const profile of artifact.surfaces.representativeAuthoringProfiles.profiles) {
    const expected = profile.files.reduce((sum, path) => sum + Buffer.byteLength(readFileSync(join(ROOT, path))), 0);
    assert.equal(profile.bytes, expected, `${profile.name} profile must sum its declared files`);
  }
  const profileBytes = artifact.surfaces.representativeAuthoringProfiles.profiles
    .map(({ bytes }) => bytes)
    .sort((a, b) => a - b);
  assert.equal(artifact.surfaces.representativeAuthoringProfiles.medianBytes, (profileBytes[2] + profileBytes[3]) / 2);

  await withRenderedWorkflow(async ({ systemPrompt, promptLines, wrappedWorkflow }) => {
    const expectedLines = new Set(promptLines);
    const renderedLines = systemPrompt.split("\n").filter((line) => expectedLines.has(line));
    assert.deepEqual(renderedLines, promptLines, "Pi should render each workflow prompt line exactly once");

    const providerDefinition = JSON.stringify({
      name: wrappedWorkflow.name,
      description: wrappedWorkflow.description,
      parameters: wrappedWorkflow.parameters,
    });
    assert.equal(artifact.surfaces.permanentWorkflowPrompt.bytes, Buffer.byteLength(renderedLines.join("\n"), "utf8"));
    assert.equal(
      artifact.surfaces.providerVisibleWorkflowToolDefinition.bytes,
      Buffer.byteLength(providerDefinition, "utf8"),
    );
  });
});

test("workflow context measurement generation is deterministic and committed artifact is fresh", () => {
  const first = renderWorkflowContextMeasurement();
  const second = renderWorkflowContextMeasurement();

  assert.equal(first, second);
  assert.equal(readFileSync(join(ROOT, WORKFLOW_CONTEXT_MEASUREMENT_PATH), "utf8"), first);
  assert.equal(checkWorkflowContextMeasurement(ROOT), true);
  assert.equal(checkWorkflowContextMeasurement(ROOT, `${first}stale`), false);
  assert.equal(packageJson.scripts["context:check"], "tsx scripts/generate-workflow-context-measurement.ts --check");
  assert.match(packageJson.scripts.test, /release:check/);
  assert.match(packageJson.scripts["release:check"], /context:check/);
});

test("context freshness command prints stable and on-demand byte counts", () => {
  const output = execSync(`${NPM_COMMAND} run context:check`, { cwd: ROOT, encoding: "utf8" });

  assert.match(output, /Stable workflow prompt: \d+ bytes/);
  assert.match(output, /Stable workflow tool definition: \d+ bytes/);
  assert.match(output, /Explicit-request rewrite: \d+ bytes/);
  assert.match(output, /Forced command rewrite: \d+ bytes/);
  assert.match(output, /Stable workflow-owned context: \d+ bytes/);
  assert.match(output, /Explicit workflow request context: \d+ bytes/);
  assert.match(output, /Ordinary stable workflow tool definitions: \d+ bytes/);
  assert.match(output, /- start_workflow: \d+ bytes/);
  assert.match(output, /- list_active_workflows: \d+ bytes/);
  assert.match(output, /- get_workflow_output: \d+ bytes/);
  assert.match(output, /- stop_workflow: \d+ bytes/);
  assert.doesNotMatch(output, /- workflow_control: \d+ bytes/);
  assert.doesNotMatch(output, /- workflow_steer: \d+ bytes/);
  assert.match(output, /Registered skills discovery \(all \d+\): \d+ bytes/);
  assert.match(output, /- skills\/workflow-authoring: \d+ bytes/);
  assert.match(output, /- skills\/workflow-patterns: \d+ bytes/);
  assert.match(output, /Workflow-authoring skill corpus: \d+ bytes across \d+ files/);
  assert.match(output, /Representative authoring profile median: \d+(?:\.5)? bytes/);
  assert.match(output, /measurement is fresh/i);
});

async function withRenderedWorkflow(
  inspect: (surface: {
    systemPrompt: string;
    promptLines: string[];
    wrappedWorkflow: { name: string; description: string; parameters: unknown };
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "workflow-context-measurement-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await withFakeHomeAsync(root, async () => {
      const workflow = createWorkflowTool({
        cwd: root,
        allowResume: false,
        exposeAdvancedParameters: false,
        modelFacing: true,
      });
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        appendSystemPromptOverride: () => [],
      });
      await loader.reload();

      const { session } = await createAgentSession({
        cwd: root,
        agentDir: root,
        tools: ["start_workflow"],
        customTools: [workflow],
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(root),
        settingsManager: SettingsManager.inMemory(),
      });

      try {
        const wrappedWorkflow = session.agent.state.tools.find((tool) => tool.name === "start_workflow");
        assert.ok(wrappedWorkflow, "Pi should expose the wrapped workflow tool");
        await inspect({
          systemPrompt: session.agent.state.systemPrompt,
          promptLines: [
            ...(workflow.promptSnippet ? [`- workflow: ${workflow.promptSnippet}`] : []),
            ...(workflow.promptGuidelines ?? []).map((guideline) => `- ${guideline}`),
          ],
          wrappedWorkflow,
        });
      } finally {
        session.dispose();
      }
    });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
}
