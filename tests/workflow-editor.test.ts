import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function load() {
  return import("../src/workflow-editor.js");
}

describe("hasExplicitWorkflowSteerRequest", () => {
  it("requires both a generated run ID and explicit same-run continuation language", async () => {
    const { hasExplicitWorkflowSteerRequest } = await load();
    assert.equal(
      hasExplicitWorkflowSteerRequest("continue workflow run audit-m1abc234-de5f67 with this correction"),
      true,
    );
    assert.equal(hasExplicitWorkflowSteerRequest("修正工作流 audit-m1abc234-de5f67：路径应为 src/auth.ts"), true);
    assert.equal(hasExplicitWorkflowSteerRequest("build a new workflow for the auth module"), false);
    assert.equal(hasExplicitWorkflowSteerRequest("continue the old workflow"), false);
    assert.equal(hasExplicitWorkflowSteerRequest("what does workflow_steer do?"), false);
  });
});

describe("hasExplicitWorkflowControlRequest", () => {
  it("recognizes explicit lifecycle requests without activating on status or ordinary work", async () => {
    const { hasExplicitWorkflowControlRequest } = await load();
    for (const text of [
      "pause workflow run audit-m1abc234-de5f67",
      "resume the workflow",
      "stop run audit-m1abc234-de5f67",
      "取消工作流 audit-m1abc234-de5f67",
    ]) {
      assert.equal(hasExplicitWorkflowControlRequest(text), true, `${text} should expose lifecycle control`);
    }
    for (const text of [
      "show workflow status",
      "continue workflow run audit-m1abc234-de5f67 with this correction",
      "implement a new auth requirement",
      "what does workflow_control do?",
    ]) {
      assert.equal(hasExplicitWorkflowControlRequest(text), false, `${text} should not expose lifecycle control`);
    }
  });
});

describe("buildForcedWorkflowPrompt (/workflows run)", () => {
  it("uses a compact explicit-command signal", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    const result = buildForcedWorkflowPrompt("audit the repo");
    assert.ok(result.startsWith("audit the repo"), "starts with the original prompt");
    assert.match(result, /Workflow command: call `start_workflow` for this request/);
    assert.ok(Buffer.byteLength(result.slice("audit the repo".length), "utf8") < 96);
  });

  it("appends the extra directive when provided", async () => {
    const { buildForcedWorkflowPrompt } = await load();
    assert.ok(!buildForcedWorkflowPrompt("do X").includes("SENTINEL"));
    assert.ok(buildForcedWorkflowPrompt("do X", "SENTINEL").includes("SENTINEL"));
  });
});

describe("registerWorkflowProgressCommands", () => {
  function setup() {
    const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
    const sent: Array<{ content?: string }> = [];
    let settings: Record<string, unknown> = {};
    const pi = {
      registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
        commands.set(name, command);
      },
      sendMessage: (message: { content?: string }) => {
        sent.push(message);
      },
    } as unknown as ExtensionAPI;
    const settingsStore = {
      load: () => ({ ...settings }),
      save: (next: Record<string, unknown>) => {
        settings = { ...settings, ...next };
      },
    };
    return { commands, sent, settingsStore, getSettings: () => settings, pi };
  }

  it("registers a single merged /workflows-progress command (no separate -max command)", async () => {
    const mod = await load();
    const { commands, settingsStore, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    assert.ok(commands.get("workflows-progress"), "registers /workflows-progress");
    assert.equal(commands.get("workflows-progress-max"), undefined, "no separate /workflows-progress-max command");
    assert.equal(commands.size, 1, "only one command is registered");
  });

  it("persists a valid mode and reports both mode and max on status", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("detailed", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed" });
    assert.match(sent.at(-1)?.content ?? "", /detailed/i);

    await cmd.handler("compact", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "compact" });
    assert.match(sent.at(-1)?.content ?? "", /compact/i);

    await cmd.handler("status", {});
    assert.match(sent.at(-1)?.content ?? "", /panel is compact/i);
    assert.match(sent.at(-1)?.content ?? "", /up to \d+ agents per phase/i);

    await cmd.handler("", {});
    assert.match(sent.at(-1)?.content ?? "", /panel is compact/i);
    assert.match(sent.at(-1)?.content ?? "", /Usage: \/workflows-progress compact \| detailed \| status \| max <N>/);
  });

  it("ignores an invalid/unrecognized subverb without persisting, reporting current status", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    await commands.get("workflows-progress")?.handler("verbose", {});
    assert.deepEqual(getSettings(), {}, "invalid mode is not saved");
    assert.match(sent.at(-1)?.content ?? "", /Usage:/);
  });

  it("max <N> clamps and persists the per-phase agent cap, rejecting non-numbers", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("max 12", {});
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 12 });
    assert.match(sent.at(-1)?.content ?? "", /up to 12 agents per phase/);

    await cmd.handler("max 5000", {});
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "clamps to 1000");

    await cmd.handler("max abc", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "invalid value does not overwrite");

    await cmd.handler("max 0", {});
    assert.match(sent.at(-1)?.content ?? "", /Invalid value/);
    assert.deepEqual(getSettings(), { progressPanelMaxAgents: 1000 }, "invalid value does not overwrite");
  });

  it("max with no number reports the current max and usage", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("max", {});
    assert.match(sent.at(-1)?.content ?? "", /shows up to \d+ agents per phase/);
    assert.match(sent.at(-1)?.content ?? "", /Usage: \/workflows-progress max <1-1000>/);
  });

  it("is case-insensitive for subverbs", async () => {
    const mod = await load();
    const { commands, sent, settingsStore, getSettings, pi } = setup();
    mod.registerWorkflowProgressCommands(pi, settingsStore);

    const cmd = commands.get("workflows-progress");
    assert.ok(cmd, "registers /workflows-progress");

    await cmd.handler("DETAILED", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed" });

    await cmd.handler("MAX 7", {});
    assert.deepEqual(getSettings(), { progressPanelMode: "detailed", progressPanelMaxAgents: 7 });
    assert.match(sent.at(-1)?.content ?? "", /up to 7 agents per phase/);
  });
});
