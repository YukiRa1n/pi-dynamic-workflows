/** Explicit workflow command prompt rewrites and interactive UI preferences. */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildLiveWorkflowDemoPrompt, openWorkflowDemo } from "./workflow-demo.js";
import {
  loadWorkflowSettings,
  saveWorkflowSettings,
  type WorkflowSettings,
  type WorkflowSettingsStore,
} from "./workflow-settings.js";

/** Legacy recognizer retained for embedders; the Pi extension does not lease tools from it. */
export function hasExplicitWorkflowControlRequest(text: string): boolean {
  return (
    /\b(?:pause|resume|stop|cancel)\b.{0,64}\b(?:workflow|run)\b/iu.test(text) ||
    /\b(?:workflow|run)\b.{0,64}\b(?:pause|resume|stop|cancel)\b/iu.test(text) ||
    /(?:暂停|恢复|停止|取消).{0,48}(?:workflow|工作流|run)/iu.test(text) ||
    /(?:workflow|工作流|run).{0,48}(?:暂停|恢复|停止|取消)/iu.test(text)
  );
}

/** Legacy recognizer retained for embedders; explicit Pi steering uses /workflows steer. */
export function hasExplicitWorkflowSteerRequest(text: string): boolean {
  const generatedRunId = /\b(?:[A-Za-z0-9][A-Za-z0-9._-]*-)?[a-z0-9]{7,}-[a-z0-9]{6}\b/iu.test(text);
  if (!generatedRunId) return false;
  return (
    /\b(?:steer|continue|correct|update|amend|answer|reply)\b.{0,64}\b(?:workflow|run)\b/iu.test(text) ||
    /\b(?:workflow|run)\b.{0,64}\b(?:steer|continue|correct|update|amend|answer|reply)\b/iu.test(text) ||
    /(?:继续|修正|更正|补充|回复|回答|转告).{0,48}(?:workflow|工作流|run)/iu.test(text) ||
    /(?:workflow|工作流|run).{0,48}(?:继续|修正|更正|补充|回复|回答|转告)/iu.test(text)
  );
}

/** Add the explicit `/workflows run` routing suffix. */
export function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string {
  const lines = [text, "", "[Workflow command: call `start_workflow` for this request.]"];
  if (extraDirective) lines.push("", extraDirective);
  return lines.join("\n");
}

/**
 * Register the bottom progress-panel preference command:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress max <1-1000>` — cap agents shown per phase in detailed mode.
 *  - `/workflows-progress icons auto|ascii` — pick the glyph set for the tree panel.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export function registerWorkflowProgressCommands(
  pi: ExtensionAPI,
  settingsStore: WorkflowSettingsStore = DEFAULT_SETTINGS_STORE,
): void {
  pi.registerCommand?.("workflows-progress", {
    description: "Bottom progress panel: compact | detailed | status | max <N> | icons auto | ascii",
    async handler(args: string, _ctx: ExtensionCommandContext) {
      const trimmed = args.trim();
      const say = (content: string) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
      const spaceIdx = trimmed.indexOf(" ");
      const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
      const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      if (verb === "compact" || verb === "detailed") {
        const saved = persistProgressSettings(settingsStore, { progressPanelMode: verb });
        await say(
          saved
            ? `Workflow progress panel set to ${verb} — takes effect on the next render of a live run (no restart needed).`
            : `Workflow progress panel set to ${verb} for this session, but the preference could not be saved.`,
        );
        return;
      }

      if (verb === "max") {
        if (!rest) {
          await say(
            `Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress max <1-1000>`,
          );
          return;
        }
        const trimmed = rest.trim();
        if (!/^\d+$/.test(trimmed)) {
          await say(`Invalid value "${rest}". Usage: /workflows-progress max <1-1000> (a whole number ≥ 1).`);
          return;
        }
        const n = Number.parseInt(trimmed, 10);
        if (n < 1) {
          await say(`Invalid value "${rest}". Usage: /workflows-progress max <1-1000> (a whole number ≥ 1).`);
          return;
        }
        const clamped = Math.min(1000, n);
        const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
        await say(
          saved
            ? `Detailed progress now shows up to ${clamped} agents per phase.`
            : `Set to ${clamped} for this session, but the preference could not be saved.`,
        );
        return;
      }

      if (verb === "icons") {
        if (!rest) {
          await say(
            `Progress panel glyphs are ${loadProgressIcons(settingsStore)}. Usage: /workflows-progress icons auto | ascii`,
          );
          return;
        }
        const value = rest.toLowerCase();
        if (value !== "auto" && value !== "ascii") {
          await say(`Invalid value "${rest}". Usage: /workflows-progress icons auto | ascii`);
          return;
        }
        const saved = persistProgressSettings(settingsStore, { progressPanelIcons: value });
        await say(
          saved
            ? `Progress panel glyphs set to ${value} — takes effect on the next render of a live run.`
            : `Set to ${value} for this session, but the preference could not be saved.`,
        );
        return;
      }

      await say(
        `Workflow progress panel is ${loadProgressMode(settingsStore)}, showing up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress compact | detailed | status | max <N> | icons auto | ascii`,
      );
    },
  });

  pi.registerCommand?.("workflows-demo", {
    description: "Run the real Pi chat demo (2 model-backed agents); preview opens the offline panel",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const mode = args.trim().toLowerCase();
      if (mode === "preview") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/workflows-demo preview requires TUI mode", "warning");
          return;
        }
        await ctx.waitForIdle();
        await openWorkflowDemo(ctx.ui, loadProgressIcons(settingsStore));
        return;
      }
      if (mode && mode !== "live") {
        ctx.ui.notify(
          "/workflows-demo [live | preview]：默认在主会话运行真实演示，使用两个子代理和模型 token。",
          "info",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("请等当前回合结束后运行 /workflows-demo；演示开始后可以正常插话。", "info");
        return;
      }
      pi.sendUserMessage(buildLiveWorkflowDemoPrompt());
    },
  });
}

const DEFAULT_SETTINGS_STORE: WorkflowSettingsStore = {
  load: loadWorkflowSettings,
  save: saveWorkflowSettings,
};

function persistProgressSettings(settingsStore: WorkflowSettingsStore, settings: WorkflowSettings): boolean {
  try {
    settingsStore.save(settings);
    return true;
  } catch {
    return false;
  }
}

function loadProgressMode(settingsStore: WorkflowSettingsStore): "compact" | "detailed" {
  try {
    return settingsStore.load().progressPanelMode ?? "compact";
  } catch {
    return "compact";
  }
}

function loadProgressMaxAgents(settingsStore: WorkflowSettingsStore): number {
  try {
    return settingsStore.load().progressPanelMaxAgents ?? 8;
  } catch {
    return 8;
  }
}

function loadProgressIcons(settingsStore: WorkflowSettingsStore): "auto" | "ascii" {
  try {
    return settingsStore.load().progressPanelIcons ?? "auto";
  } catch {
    return "auto";
  }
}
