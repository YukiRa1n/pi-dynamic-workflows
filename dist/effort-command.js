/** Session-local depth guidance for explicit workflow requests. */
export function createEffortState() {
    return { level: "off" };
}
const HIGH_DIRECTIVE = "Workflow effort: high. Use independent parallel perspectives and one verification pass.";
const ULTRA_DIRECTIVE = "Workflow effort: ultra. Use broad independent coverage, adversarial verification, and a final completeness check.";
/** The extra directive appended to the forced-workflow prompt for an effort level. */
export function effortDirective(level) {
    if (level === "high")
        return HIGH_DIRECTIVE;
    if (level === "ultra")
        return ULTRA_DIRECTIVE;
    return undefined;
}
/** Backward-compatible utility for classifying non-trivial input. */
export function isSubstantive(text) {
    const t = text.trim();
    return t.length >= 16 && !t.startsWith("/");
}
export function registerEffortCommand(pi, state) {
    pi.registerCommand("effort", {
        description: "Workflow depth for explicit workflow requests: off | high | ultra",
        async handler(args, _ctx) {
            const arg = args.trim().toLowerCase();
            const say = (content) => pi.sendMessage({ customType: "effort", content, display: true });
            if (arg === "off" || arg === "high" || arg === "ultra") {
                state.level = arg;
                await say(arg === "off"
                    ? "Workflow effort off. Ordinary messages and explicit workflow requests use their default behavior."
                    : `Workflow effort ${arg} — applies only when you explicitly request or run a workflow. Ordinary messages remain direct. Use /effort off to stop.`);
                return;
            }
            await say(`Effort is currently "${state.level}". Usage: /effort off | high | ultra`);
        },
    });
    // `/ultracode` — the headline name for the maximal-effort mode (Pi's ultracode):
    // `/ultracode` turns it on, `/ultracode off` turns it off. Alias for /effort ultra.
    pi.registerCommand("ultracode", {
        description: "Ultracode: maximal depth for explicit workflows in this session. /ultracode off to stop.",
        async handler(args, _ctx) {
            const arg = args.trim().toLowerCase();
            const say = (content) => pi.sendMessage({ customType: "effort", content, display: true });
            if (arg === "off") {
                state.level = "off";
                await say("Ultracode off.");
                return;
            }
            state.level = "ultra";
            await say("Ultracode on — explicit workflow requests use maximal depth; ordinary messages remain direct. Use /ultracode off to stop.");
        },
    });
}
