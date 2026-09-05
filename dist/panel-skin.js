/**
 * Zentui-style visual skin for the progress panel.
 *
 * One source of truth for glyphs and semantic colors so both the compact and
 * detailed renderers share the same visual contract:
 *  - lightweight segmentation (single-line tree glyphs, no heavy boxes)
 *  - accent only for small emphasis (running markers, live phase titles)
 *  - dim for metadata, muted for tree connectors and low-emphasis states
 *  - success/warning/error tokens for terminal states when the theme has them
 *
 * The glyphs deliberately mirror the tree/todo idiom (● ├─ ◐ ○ ✓ ✗) so the
 * workflow panel reads like the rest of the terminal ecosystem instead of a
 * bespoke dashboard. ASCII mode exists for terminals without Unicode box
 * support; "auto" is the safe default (Unicode glyphs, no font probing).
 */
const UNICODE_SKIN = {
    running: "◐",
    pending: "○",
    done: "✓",
    error: "✗",
    skipped: "-",
    paused: "⏸",
    branch: "├─",
    lastBranch: "└─",
    continuation: "│",
    headerDot: "●",
    ellipsis: "…",
};
const ASCII_SKIN = {
    running: ">",
    pending: "o",
    done: "+",
    error: "x",
    skipped: "-",
    paused: "~",
    branch: "|-",
    lastBranch: "|-",
    continuation: "|",
    headerDot: "*",
    ellipsis: "...",
};
export function panelSkin(mode = "auto") {
    return mode === "ascii" ? ASCII_SKIN : UNICODE_SKIN;
}
/** Status-to-color resolution: prefer semantic tokens, keep safe fallbacks. */
export function statusColor(status) {
    switch (status) {
        case "running":
            return { color: "accent", fallback: "accent" };
        case "done":
            return { color: "success", fallback: "accent" };
        case "error":
            return { color: "error", fallback: "accent" };
        case "paused":
            return { color: "warning", fallback: "muted" };
        case "queued":
            return { color: "dim", fallback: "dim" };
        case "skipped":
            return { color: "muted", fallback: "muted" };
    }
}
export function paintStatus(text, status, theme) {
    const { color, fallback } = statusColor(status);
    return theme.fg(color, text) === text && color !== fallback ? theme.fg(fallback, text) : theme.fg(color, text);
}
/**
 * Render a tree connector in muted color. `last` picks the "└─" elbow so a
 * run/agent block closes cleanly.
 */
export function treeConnector(skin, last, theme) {
    return theme.fg("muted", last ? skin.lastBranch : skin.branch);
}
/**
 * Resolve an IconMode from raw settings input, accepting the exact enum values
 * and falling back to the safe default. Unknown values fall back to "auto"
 * rather than throwing: the panel must never fail because of a corrupt setting.
 */
export function resolveIconMode(value) {
    return value === "ascii" ? "ascii" : "auto";
}
