/** Explicit workflow command prompt rewrites and interactive UI preferences. */
import { loadWorkflowSettings, saveWorkflowSettings, } from "./workflow-settings.js";
/** Legacy recognizer retained for embedders; the Pi extension does not lease tools from it. */
export function hasExplicitWorkflowControlRequest(text) {
    return (/\b(?:pause|resume|stop|cancel)\b.{0,64}\b(?:workflow|run)\b/iu.test(text) ||
        /\b(?:workflow|run)\b.{0,64}\b(?:pause|resume|stop|cancel)\b/iu.test(text) ||
        /(?:暂停|恢复|停止|取消).{0,48}(?:workflow|工作流|run)/iu.test(text) ||
        /(?:workflow|工作流|run).{0,48}(?:暂停|恢复|停止|取消)/iu.test(text));
}
/** Legacy recognizer retained for embedders; explicit Pi steering uses /workflows steer. */
export function hasExplicitWorkflowSteerRequest(text) {
    const generatedRunId = /\b(?:[A-Za-z0-9][A-Za-z0-9._-]*-)?[a-z0-9]{7,}-[a-z0-9]{6}\b/iu.test(text);
    if (!generatedRunId)
        return false;
    return (/\b(?:steer|continue|correct|update|amend|answer|reply)\b.{0,64}\b(?:workflow|run)\b/iu.test(text) ||
        /\b(?:workflow|run)\b.{0,64}\b(?:steer|continue|correct|update|amend|answer|reply)\b/iu.test(text) ||
        /(?:继续|修正|更正|补充|回复|回答|转告).{0,48}(?:workflow|工作流|run)/iu.test(text) ||
        /(?:workflow|工作流|run).{0,48}(?:继续|修正|更正|补充|回复|回答|转告)/iu.test(text));
}
/** Add the explicit `/workflows run` routing suffix. */
export function buildForcedWorkflowPrompt(text, extraDirective) {
    const lines = [text, "", "[Workflow command: call `start_workflow` for this request.]"];
    if (extraDirective)
        lines.push("", extraDirective);
    return lines.join("\n");
}
/**
 * Register the bottom progress-panel preference command:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export function registerWorkflowProgressCommands(pi, settingsStore = DEFAULT_SETTINGS_STORE) {
    pi.registerCommand?.("workflows-progress", {
        description: "Bottom progress panel: compact | detailed | status | max <N>",
        async handler(args, _ctx) {
            const trimmed = args.trim();
            const say = (content) => pi.sendMessage({ customType: "workflows-progress", content, display: true });
            const spaceIdx = trimmed.indexOf(" ");
            const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
            const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();
            if (verb === "compact" || verb === "detailed") {
                const saved = persistProgressSettings(settingsStore, { progressPanelMode: verb });
                await say(saved
                    ? `Workflow progress panel set to ${verb} — takes effect on the next render of a live run (no restart needed).`
                    : `Workflow progress panel set to ${verb} for this session, but the preference could not be saved.`);
                return;
            }
            if (verb === "max") {
                if (!rest) {
                    await say(`Detailed progress shows up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress max <1-1000>`);
                    return;
                }
                const n = Number.parseInt(rest, 10);
                if (!Number.isFinite(n) || n < 1) {
                    await say(`Invalid value "${rest}". Usage: /workflows-progress max <1-1000> (a whole number ≥ 1).`);
                    return;
                }
                const clamped = Math.min(1000, n);
                const saved = persistProgressSettings(settingsStore, { progressPanelMaxAgents: clamped });
                await say(saved
                    ? `Detailed progress now shows up to ${clamped} agents per phase.`
                    : `Set to ${clamped} for this session, but the preference could not be saved.`);
                return;
            }
            await say(`Workflow progress panel is ${loadProgressMode(settingsStore)}, showing up to ${loadProgressMaxAgents(settingsStore)} agents per phase. Usage: /workflows-progress compact | detailed | status | max <N>`);
        },
    });
}
const DEFAULT_SETTINGS_STORE = {
    load: loadWorkflowSettings,
    save: saveWorkflowSettings,
};
function persistProgressSettings(settingsStore, settings) {
    try {
        settingsStore.save(settings);
        return true;
    }
    catch {
        return false;
    }
}
function loadProgressMode(settingsStore) {
    try {
        return settingsStore.load().progressPanelMode ?? "compact";
    }
    catch {
        return "compact";
    }
}
function loadProgressMaxAgents(settingsStore) {
    try {
        return settingsStore.load().progressPanelMaxAgents ?? 8;
    }
    catch {
        return 8;
    }
}
