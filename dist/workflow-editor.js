/**
 * "Workflows mode" keyword trigger: while the submitted message contains the
 * bounded word `workflow`/`workflows` (or a configured custom trigger word),
 * the message is transformed at submit time to instruct Pi to actually run the
 * workflow tool. Detection is purely textual (`event.text` on the `input`
 * hook) — it does not depend on, or own, the host's editor component.
 */
import { DEFAULT_KEYWORD_TRIGGER_WORD, normalizeKeywordTriggerWord } from "./config.js";
import { effortDirective } from "./effort-command.js";
import { loadWorkflowSettings, saveWorkflowSettings, } from "./workflow-settings.js";
// A keyword trigger is a configured literal term. All trigger words use token
// boundaries so slash commands, paths, and identifier-like text stay untouched.
// The default `workflow` trigger additionally supports the plural `workflows`.
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function triggerSource(triggerWord) {
    const escaped = escapeRegExp(triggerWord);
    const plural = triggerWord.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD ? "s?" : "";
    return `(?<![/\\p{ID_Continue}$-])(?<!\\\\)${escaped}${plural}(?![/\\p{ID_Continue}$-])(?!\\\\)`;
}
function triggerRegex(triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD, flags = "iu", atEnd = false) {
    const word = normalizeKeywordTriggerWord(triggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
    return new RegExp(`${triggerSource(word)}${atEnd ? "$" : ""}`, flags);
}
export function hasTrigger(text, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD) {
    return triggerRegex(triggerWord).test(text);
}
/**
 * Provider-facing arming is stricter than lexical highlighting. A configured
 * custom word remains an explicit opt-in, while the default word ignores common
 * discussion/debugging phrases and recognizes compact CJK requests such as
 * "用workflow审查" that Unicode token boundaries otherwise reject.
 */
export function hasWorkflowRequestTrigger(text, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD) {
    const word = normalizeKeywordTriggerWord(triggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
    if (word.toLowerCase() !== DEFAULT_KEYWORD_TRIGGER_WORD)
        return hasTrigger(text, word);
    const explicitRequest = /\b(?:run|start|launch|execute|invoke|use)\b.{0,48}\bworkflows?\b/iu.test(text) ||
        /^\s*workflows?\s*[:：]\s*\S/iu.test(text) ||
        /\bworkflows?\b\s+(?:audit|review|research|analy[sz]e|inspect|check|run)\b/iu.test(text) ||
        /(?:用|使用|运行|启动|调用|跑)(?:一下|一个|这个|该)?\s*workflows?/iu.test(text) ||
        /(?:帮我|请).{0,24}\bworkflows?\b.{0,24}(?:审|查|分析|研究|执行|并行|跑)/iu.test(text);
    return explicitRequest;
}
export function endsWithTrigger(textBeforeCursor, triggerWord = DEFAULT_KEYWORD_TRIGGER_WORD) {
    return triggerRegex(triggerWord, "iu", true).test(textBeforeCursor);
}
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
/** Add a minimal user-message suffix after an explicit workflow request. */
export function buildArmedWorkflowPrompt(text, opts = {}) {
    const lines = [text, "", "[Workflow requested.]"];
    if (opts.extraDirective)
        lines.push("", opts.extraDirective);
    return lines.join("\n");
}
/** Add the explicit `/workflows run` routing suffix. */
export function buildForcedWorkflowPrompt(text, extraDirective) {
    const lines = [text, "", "[Workflow command: call `start_workflow` for this request.]"];
    if (extraDirective)
        lines.push("", extraDirective);
    return lines.join("\n");
}
/** The exact name of the workflow tool that workflows mode forces. */
export const WORKFLOW_TOOL_NAME = "start_workflow";
export function registerWorkflowTriggerCommand(pi, state, settingsStore = DEFAULT_SETTINGS_STORE) {
    pi.registerCommand?.("workflows-trigger", {
        description: "Keyword workflow trigger: on | off | set <word> | reset | status",
        async handler(args, _ctx) {
            const raw = args.trim();
            const [command = "status", ...rest] = raw.split(/\s+/);
            const arg = command.toLowerCase();
            const say = (content) => pi.sendMessage({ customType: "workflows-trigger", content, display: true });
            if (arg === "on") {
                state.keywordTriggerEnabled = true;
                state.suppressedKeywordText = undefined;
                const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerEnabled: true });
                await say(saved
                    ? `Workflows keyword trigger on — mentioning ${triggerDisplayName(state.keywordTriggerWord)} in an interactive message will auto-arm workflows mode. Saved for new sessions.`
                    : "Workflows keyword trigger on for this session, but the preference could not be saved.");
                return;
            }
            if (arg === "off") {
                state.keywordTriggerEnabled = false;
                state.active = false;
                state.suppressedKeywordText = undefined;
                const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerEnabled: false });
                await say(saved
                    ? `Workflows keyword trigger off — messages can mention ${triggerDisplayName(state.keywordTriggerWord)} without forcing the workflow tool. Saved for new sessions. Use /workflows-trigger on to restore.`
                    : "Workflows keyword trigger off for this session, but the preference could not be saved. Use /workflows-trigger on to restore.");
                return;
            }
            if (arg === "set") {
                const requested = rest.join(" ");
                const keywordTriggerWord = normalizeKeywordTriggerWord(requested);
                if (!keywordTriggerWord) {
                    await say('Invalid trigger word. Use a non-empty term with no spaces and no leading "/", e.g. /workflows-trigger set pi-workflow');
                    return;
                }
                state.keywordTriggerWord = keywordTriggerWord;
                state.suppressedKeywordText = undefined;
                const saved = persistWorkflowTriggerSettings(settingsStore, { keywordTriggerWord });
                await say(saved
                    ? `Workflows keyword trigger word set to "${keywordTriggerWord}". Saved for new sessions.`
                    : `Workflows keyword trigger word set to "${keywordTriggerWord}" for this session, but the preference could not be saved.`);
                return;
            }
            if (arg === "reset") {
                state.keywordTriggerWord = DEFAULT_KEYWORD_TRIGGER_WORD;
                state.suppressedKeywordText = undefined;
                const saved = persistWorkflowTriggerSettings(settingsStore, {
                    keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD,
                });
                await say(saved
                    ? 'Workflows keyword trigger word reset to "workflow" (also matches "workflows"). Saved for new sessions.'
                    : 'Workflows keyword trigger word reset to "workflow" for this session, but the preference could not be saved.');
                return;
            }
            const keywordTriggerWord = resolvedTriggerWord(state.keywordTriggerWord);
            await say(`Workflows keyword trigger is ${state.keywordTriggerEnabled ? "on" : "off"}; trigger word is "${keywordTriggerWord}". Changes are saved for new sessions. Usage: /workflows-trigger on | off | set <word> | reset | status`);
        },
    });
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
/**
 * Install the keyword-trigger arming hook (submit-time detection + prompt
 * rewrite) and the related trigger/progress commands. Call once (e.g. in
 * `session_start`).
 */
export function installWorkflowKeywordArming(pi, effort, options = {}) {
    const settingsStore = options.settingsStore ?? DEFAULT_SETTINGS_STORE;
    const initialSettings = loadInitialWorkflowSettings(settingsStore);
    const state = {
        active: false,
        keywordTriggerEnabled: initialSettings.keywordTriggerEnabled ?? true,
        keywordTriggerWord: initialSettings.keywordTriggerWord ?? DEFAULT_KEYWORD_TRIGGER_WORD,
    };
    registerWorkflowTriggerCommand(pi, state, settingsStore);
    registerWorkflowProgressCommands(pi, settingsStore);
    // Tool visibility is deliberately not changed here. Pi's setActiveTools()
    // mutates session-global provider state and has no per-input lease, so doing
    // that from the input hook can race streaming turns and invalidate the stable
    // prompt-cache prefix. This hook only adds a short suffix to an explicit
    // workflow request; the compact start/list/stop tool set stays stable.
    pi.on("input", (event) => {
        if (event.source !== "interactive" || !event.text)
            return { action: "continue" };
        const normalizedText = event.text.trim();
        const suppressed = state.suppressedKeywordText === normalizedText;
        if (suppressed)
            state.suppressedKeywordText = undefined;
        const triggered = state.keywordTriggerEnabled && !suppressed && hasWorkflowRequestTrigger(event.text, state.keywordTriggerWord);
        if (!triggered)
            return { action: "continue" };
        const extra = effort && effort.level !== "off" ? effortDirective(effort.level) : undefined;
        return {
            action: "transform",
            text: buildArmedWorkflowPrompt(event.text, { reason: "keyword", extraDirective: extra }),
        };
    });
    return state;
}
const DEFAULT_SETTINGS_STORE = {
    load: loadWorkflowSettings,
    save: saveWorkflowSettings,
};
function loadInitialWorkflowSettings(settingsStore) {
    try {
        const settings = settingsStore.load();
        return {
            keywordTriggerEnabled: settings.keywordTriggerEnabled,
            keywordTriggerWord: normalizeKeywordTriggerWord(settings.keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD,
        };
    }
    catch {
        return { keywordTriggerEnabled: true, keywordTriggerWord: DEFAULT_KEYWORD_TRIGGER_WORD };
    }
}
function persistWorkflowTriggerSettings(settingsStore, settings) {
    try {
        settingsStore.save(settings);
        return true;
    }
    catch {
        return false;
    }
}
function resolvedTriggerWord(keywordTriggerWord) {
    return normalizeKeywordTriggerWord(keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD;
}
function triggerDisplayName(keywordTriggerWord) {
    const word = resolvedTriggerWord(keywordTriggerWord);
    return word.toLowerCase() === DEFAULT_KEYWORD_TRIGGER_WORD ? "workflow/workflows" : `"${word}"`;
}
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
