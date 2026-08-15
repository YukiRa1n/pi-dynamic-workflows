import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { describe, it } from "node:test";
import { WORKFLOW_SETTINGS_FILE } from "../src/config.js";
import {
  getWorkflowProjectSettingsPath,
  getWorkflowSettingsPath,
  loadWorkflowSettings,
  saveWorkflowSettings,
  saveWorkflowSettingsForCwd,
} from "../src/workflow-settings.js";
import { withFakeHome } from "./helpers/fake-home.js";

function withSettingsPath(fn: (settingsPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-settings-"));
  try {
    fn(join(dir, "nested", "settings.json"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function withRevision<T extends object>(settings: T, revision: number): T & { revision: number } {
  return { ...settings, revision };
}

describe("workflow settings", () => {
  it("resolves the user-level settings path", () => {
    assert.ok(getWorkflowSettingsPath().endsWith(normalize(WORKFLOW_SETTINGS_FILE)));
  });

  it("returns empty settings when the file is missing", () => {
    withSettingsPath((settingsPath) => {
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("saves and loads keyword trigger preferences", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: false, keywordTriggerWord: "pi-workflow" }, settingsPath);

      assert.ok(existsSync(settingsPath), "settings file should be created");
      assert.deepEqual(
        loadWorkflowSettings(settingsPath),
        withRevision({ keywordTriggerEnabled: false, keywordTriggerWord: "pi-workflow" }, 1),
      );
    });
  });

  it("normalizes keyword trigger word settings", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerWord: "  pi-workflow  " }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { keywordTriggerWord: "pi-workflow" });

      for (const keywordTriggerWord of ["", "   ", "/workflow", "pi workflow", 42, false]) {
        writeFileSync(settingsPath, JSON.stringify({ keywordTriggerWord }), "utf-8");
        assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      }
    });
  });

  it("saves and loads default agent timeout preference", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ defaultAgentTimeoutMs: 600000 }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ defaultAgentTimeoutMs: 600000 }, 1));

      saveWorkflowSettings({ defaultAgentTimeoutMs: null }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ defaultAgentTimeoutMs: null }, 2));
    });
  });

  it("saves, loads, and normalizes defaultTokenBudget (#68)", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      saveWorkflowSettings({ defaultTokenBudget: 500_000 }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ defaultTokenBudget: 500_000 }, 1));

      // null is a meaningful value: "explicitly no budget" (project override).
      saveWorkflowSettings({ defaultTokenBudget: null }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ defaultTokenBudget: null }, 2));

      // Floats floor; zero/negative/garbage are dropped.
      writeFileSync(settingsPath, JSON.stringify({ defaultTokenBudget: 1000.9 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultTokenBudget: 1000 });
      writeFileSync(settingsPath, JSON.stringify({ defaultTokenBudget: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      writeFileSync(settingsPath, JSON.stringify({ defaultTokenBudget: "lots" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("loads and normalizes excludeSubagentTools, dropping non-string/blank entries (#107)", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: ["pi-subagents", "spawn"] }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { excludeSubagentTools: ["pi-subagents", "spawn"] });

      // Non-string and blank entries are filtered out.
      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: ["keep", 42, "", "  ", null] }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { excludeSubagentTools: ["keep"] });

      // An all-invalid (or empty) list yields no key at all.
      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: [1, 2, ""] }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
      writeFileSync(settingsPath, JSON.stringify({ excludeSubagentTools: "nope" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("normalizes default concurrency and agent retries", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 4.9, defaultAgentRetries: 2.8 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 4, defaultAgentRetries: 2 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 99, defaultAgentRetries: 99 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { defaultConcurrency: 16, defaultAgentRetries: 3 });

      writeFileSync(settingsPath, JSON.stringify({ defaultConcurrency: 0, defaultAgentRetries: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("merges project settings over global settings when cwd is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        const globalPath = getWorkflowSettingsPath();
        const projectPath = getWorkflowProjectSettingsPath(cwd);
        saveWorkflowSettings({ keywordTriggerEnabled: true, defaultAgentTimeoutMs: 600000 }, globalPath);
        saveWorkflowSettings({ keywordTriggerEnabled: false }, { cwd, settingsPath: globalPath, scope: "project" });

        assert.deepEqual(
          loadWorkflowSettings(globalPath),
          withRevision({ keywordTriggerEnabled: true, defaultAgentTimeoutMs: 600000 }, 1),
        );
        assert.deepEqual(
          loadWorkflowSettings({ cwd, settingsPath: globalPath, projectSettingsPath: projectPath }),
          withRevision({ keywordTriggerEnabled: false, defaultAgentTimeoutMs: 600000 }, 1),
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves cwd preferences globally without creating a project override", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        saveWorkflowSettingsForCwd({ keywordTriggerEnabled: false }, cwd);

        assert.deepEqual(loadWorkflowSettings({ cwd }), withRevision({ keywordTriggerEnabled: false }, 1));
        assert.equal(existsSync(getWorkflowProjectSettingsPath(cwd)), false);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves cwd preferences into an existing project override", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-project-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        saveWorkflowSettings({ keywordTriggerEnabled: false }, { cwd, scope: "project" });

        saveWorkflowSettingsForCwd({ keywordTriggerEnabled: true }, cwd);

        assert.deepEqual(loadWorkflowSettings(), withRevision({ keywordTriggerEnabled: true }, 1));
        assert.deepEqual(loadWorkflowSettings({ cwd }), withRevision({ keywordTriggerEnabled: true }, 2));
        assert.deepEqual(
          loadWorkflowSettings({ projectSettingsPath: getWorkflowProjectSettingsPath(cwd) }),
          withRevision({ keywordTriggerEnabled: true }, 2),
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves unknown settings when saving known settings", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: true }, settingsPath);
      const current = JSON.parse(readFileSync(settingsPath, "utf-8"));
      writeFileSync(settingsPath, `${JSON.stringify({ ...current, theme: "dark" }, null, 2)}\n`, "utf-8");

      saveWorkflowSettings({ keywordTriggerEnabled: false }, settingsPath);

      assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf-8")), {
        keywordTriggerEnabled: false,
        _workflowSettingsRevision: 2,
        theme: "dark",
      });
    });
  });

  it("uses the loaded revision as a compare-and-swap fence", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ keywordTriggerEnabled: true }, settingsPath);
      const loaded = loadWorkflowSettings(settingsPath);
      assert.equal(loaded.revision, 1);

      saveWorkflowSettings({ keywordTriggerEnabled: false, revision: loaded.revision }, settingsPath);
      assert.equal(loadWorkflowSettings(settingsPath).revision, 2);

      assert.throws(
        () => saveWorkflowSettings({ keywordTriggerEnabled: true, revision: loaded.revision }, settingsPath),
        /changed concurrently.*expected revision 1.*found 2/,
      );
      assert.equal(loadWorkflowSettings(settingsPath).keywordTriggerEnabled, false);
    });
  });

  it("saves and loads the progress panel mode", () => {
    withSettingsPath((settingsPath) => {
      saveWorkflowSettings({ progressPanelMode: "detailed" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ progressPanelMode: "detailed" }, 1));

      saveWorkflowSettings({ progressPanelMode: "compact" }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ progressPanelMode: "compact" }, 2));
    });
  });

  it("rejects an invalid progress panel mode", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ progressPanelMode: "verbose" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("clamps and floors progressPanelMaxAgents into [1, 1000]", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 12.7 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMaxAgents: 12 });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 5000 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { progressPanelMaxAgents: 1000 });

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ progressPanelMaxAgents: "8" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("saves and loads persistAgentSessions", () => {
    withSettingsPath((settingsPath) => {
      assert.deepEqual(loadWorkflowSettings(settingsPath), {}, "absent by default");

      saveWorkflowSettings({ persistAgentSessions: true }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ persistAgentSessions: true }, 1));

      saveWorkflowSettings({ persistAgentSessions: false }, settingsPath);
      assert.deepEqual(loadWorkflowSettings(settingsPath), withRevision({ persistAgentSessions: false }, 2));
    });
  });

  it("ignores non-boolean persistAgentSessions values", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ persistAgentSessions: "true" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ persistAgentSessions: 1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ persistAgentSessions: null }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("clamps and floors deliveredResultMaxChars into [1, 1000000]", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 250.9 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { deliveredResultMaxChars: 250 });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 5_000_000 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), { deliveredResultMaxChars: 1_000_000 });

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ deliveredResultMaxChars: "400" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });

  it("project persistAgentSessions overrides the global setting", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-dynamic-workflows-persist-settings-"));
    const cwd = join(dir, "project");
    const fakeHome = join(dir, "home");
    try {
      withFakeHome(fakeHome, () => {
        const globalPath = getWorkflowSettingsPath();
        const projectPath = getWorkflowProjectSettingsPath(cwd);

        saveWorkflowSettings({ persistAgentSessions: false }, globalPath);
        saveWorkflowSettings({ persistAgentSessions: true }, { cwd, settingsPath: globalPath, scope: "project" });

        assert.deepEqual(loadWorkflowSettings(globalPath), withRevision({ persistAgentSessions: false }, 1));
        assert.deepEqual(
          loadWorkflowSettings({ cwd, settingsPath: globalPath, projectSettingsPath: projectPath }),
          withRevision({ persistAgentSessions: true }, 1),
        );
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores corrupt or invalid settings", () => {
    withSettingsPath((settingsPath) => {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, "{not json", "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ keywordTriggerEnabled: "off" }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: 0 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});

      writeFileSync(settingsPath, JSON.stringify({ defaultAgentTimeoutMs: -1 }), "utf-8");
      assert.deepEqual(loadWorkflowSettings(settingsPath), {});
    });
  });
});
