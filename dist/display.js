import { safeStringify } from "./safe-serialize.js";
/**
 * Displayable fresh/cached figures from a usage breakdown and/or a scalar
 * estimate. The token pipeline has two sources that don't always agree: the
 * provider-reported breakdown (input/output/cacheRead/cacheWrite) and a scalar
 * estimate (`total` at run level, `tokens` per agent) that keeps accruing even
 * when the provider reports nothing. Two rules:
 * - `fresh` counts input+output+cacheWrite: cache writes are first-time
 *   ingestion billed at full (or premium) price, so hiding them would
 *   under-report real spend; only cacheRead is the cheap reuse shown apart.
 * - `fresh` is never less than what the estimate can account for after
 *   removing cache reads, so estimate-only providers, cost-only providers
 *   (billed but zero token counts), and mixed runs keep the count the display
 *   showed before the split existed, instead of a false "0 tok".
 */
export function tokenFigures(usage, scalarTokens) {
    const cacheRead = usage?.cacheRead ?? 0;
    const reported = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
    const estimate = Math.max(scalarTokens ?? 0, usage?.total ?? 0);
    return { fresh: Math.max(reported, estimate - cacheRead), cacheRead };
}
/** Sum a set of agents into fresh vs cacheRead totals, via {@link tokenFigures}. */
export function aggregateAgentUsage(agents) {
    let fresh = 0;
    let cacheRead = 0;
    for (const a of agents) {
        const f = tokenFigures(a.tokenUsage, a.tokens);
        fresh += f.fresh;
        cacheRead += f.cacheRead;
    }
    return { fresh, cacheRead };
}
/**
 * Format a token count for a display surface: "12.4K tok" on its own, or
 * "89K tok · 3.0M cached" when there were cache reads. The cache segment is shown
 * only when `cacheRead > 0`, so a non-caching provider (or a single-turn agent that
 * never re-reads its cache) reads as a plain "tok" rather than a bare, contextless
 * "fresh". `fmt` adapts the number style per surface (compact in panels, full in
 * the print view).
 */
export function fmtTokenCount(fresh, cacheRead, fmt) {
    const f = fmt(fresh) || "0";
    return cacheRead > 0 ? `${f} tok · ${fmt(cacheRead)} cached` : `${f} tok`;
}
/**
 * Like {@link fmtTokenCount}, but "" when nothing is known yet (both figures 0),
 * so surfaces omit the segment instead of rendering a false "0 tok" — e.g. for a
 * journal-replayed resume or a run whose agents were all skipped. Every surface
 * should use this rather than re-implementing the zero guard.
 */
export function fmtTokenSegment(figures, fmt) {
    return figures.fresh + figures.cacheRead > 0 ? fmtTokenCount(figures.fresh, figures.cacheRead, fmt) : "";
}
/**
 * "$1.23" from one cent up, four decimals below it, and "<$0.0001" for
 * anything smaller — a real cost never rounds to a zero-looking "$0.00".
 */
export function fmtCost(cost) {
    if (cost > 0 && cost < 0.0001)
        return "<$0.0001";
    return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}
/** Full (non-compact) number style for print/text surfaces: locale-grouped digits. */
export const fmtFull = (n) => n.toLocaleString();
export function createWorkflowSnapshot(meta) {
    return {
        name: meta.name,
        description: meta.description,
        phases: meta.phases?.map((phase) => phase.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
    };
}
export function recomputeWorkflowSnapshot(snapshot) {
    const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
    const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
    const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
    return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}
export function createWidgetWorkflowDisplay(ctx, options = {}) {
    const key = options.key ?? "workflow";
    const placement = options.placement ?? "belowEditor";
    const showStatus = options.showStatus ?? false;
    // Mutable state captured by the component closure so re-renders
    // always read the latest snapshot even though the factory ran once.
    let snapshot;
    let completed = false;
    // Store the factory so update()/complete() can re-register it to trigger re-render.
    const widgetFactory = (_tui, theme) => ({
        render: () => (snapshot ? renderWorkflowLines(snapshot, options, theme) : []),
        invalidate: () => { },
    });
    if (ctx.hasUI) {
        ctx.ui.setWidget(key, widgetFactory, { placement });
    }
    return {
        update(s) {
            snapshot = s;
            if (!ctx.hasUI)
                return;
            if (showStatus)
                ctx.ui.setStatus(key, statusLine(s, completed));
            ctx.ui.setWidget(key, widgetFactory, { placement });
        },
        complete(s) {
            snapshot = s;
            completed = true;
            if (!ctx.hasUI)
                return;
            if (showStatus)
                ctx.ui.setStatus(key, statusLine(s, true));
            ctx.ui.setWidget(key, widgetFactory, { placement });
        },
        clear() {
            if (!ctx.hasUI)
                return;
            if (showStatus)
                ctx.ui.setStatus(key, undefined);
            ctx.ui.setWidget(key, undefined);
        },
    };
}
export function createToolUpdateWorkflowDisplay(onUpdate, ctx, options = {}) {
    const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
    const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;
    const emit = (snapshot, completed = false) => {
        if (streamToolUpdates) {
            onUpdate?.({
                content: [{ type: "text", text: renderWorkflowText(snapshot, completed) }],
                details: snapshot,
            });
        }
        if (completed)
            widget?.complete(snapshot);
        else
            widget?.update(snapshot);
    };
    return {
        update(snapshot) {
            emit(snapshot, false);
        },
        complete(snapshot) {
            emit(snapshot, true);
        },
        clear() {
            widget?.clear();
        },
    };
}
/** Identity passthrough for contexts where no theme is available (tool text output). */
const NO_THEME = { fg: (_c, t) => t, bold: (t) => t };
/** The bracketed per-agent token cell (" [89 tok · 3,000 cached]"), or "" when nothing is known yet. */
function agentTokenCell(agent, theme) {
    const segment = fmtTokenSegment(tokenFigures(agent.tokenUsage, agent.tokens), fmtFull);
    return segment ? theme.fg("dim", ` [${segment}]`) : "";
}
export function renderWorkflowLines(snapshot, options = {}, theme = NO_THEME) {
    const maxAgents = options.maxAgents ?? 8;
    const showResultPreviews = options.showResultPreviews ?? false;
    const state = snapshot.errorCount > 0
        ? `, ${snapshot.errorCount} errors`
        : snapshot.runningCount > 0
            ? `, ${snapshot.runningCount} running`
            : "";
    // Build header with token info (and cost when the provider reports it)
    const usage = snapshot.tokenUsage;
    const costInfo = usage?.cost ? ` · ${fmtCost(usage.cost)}` : "";
    const segment = fmtTokenSegment(tokenFigures(usage), fmtFull);
    const tokenInfo = `${segment ? ` · ${segment}` : ""}${costInfo}`;
    const lines = [
        `${theme.bold(`◆ Workflow: ${snapshot.name}`)} (${snapshot.doneCount}/${snapshot.agentCount} done${state}${tokenInfo})`,
    ];
    const phaseNames = snapshot.phases.length
        ? snapshot.phases
        : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean));
    const rendered = new Set();
    for (const phase of phaseNames) {
        const agents = snapshot.agents.filter((agent) => agent.phase === phase);
        for (const agent of agents)
            rendered.add(agent);
        const done = agents.filter((agent) => agent.status === "done").length;
        const running = agents.filter((agent) => agent.status === "running").length;
        const errors = agents.filter((agent) => agent.status === "error").length;
        const skipped = agents.filter((agent) => agent.status === "skipped").length;
        const complete = agents.length > 0 && done + errors + skipped === agents.length;
        const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
        lines.push(theme.fg("accent", `  ${marker} ${phase}`) +
            theme.fg("dim", ` ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`));
        const visibleAgents = agents.slice(-maxAgents);
        for (const agent of visibleAgents) {
            const order = `[${agent.id}]`;
            const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
            lines.push(`    ${order} ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokenCell(agent, theme)}${result}`);
        }
        if (agents.length > visibleAgents.length)
            lines.push(theme.fg("dim", `    … ${agents.length - visibleAgents.length} earlier agents`));
    }
    const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
    if (unphased.length) {
        lines.push(theme.fg("accent", "  Unphased"));
        for (const agent of unphased.slice(-maxAgents)) {
            const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
            lines.push(`    [${agent.id}] ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${agentTokenCell(agent, theme)}${result}`);
        }
    }
    return lines;
}
export function renderWorkflowText(snapshot, completed = false) {
    const header = completed ? "Workflow completed" : "Workflow running";
    return [header, ...renderWorkflowLines(snapshot)].join("\n");
}
function statusLine(snapshot, completed) {
    if (completed)
        return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
    if (snapshot.runningCount > 0)
        return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
    return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}
export function statusIcon(status) {
    switch (status) {
        case "queued":
            return "○";
        case "running":
            return "●";
        case "done":
            return "✓";
        case "error":
            return "✗";
        case "skipped":
            return "-";
    }
}
function unique(values) {
    return [...new Set(values)];
}
export function shorten(value, max) {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
export function preview(value, max = 80) {
    if (value === null || value === undefined)
        return "";
    const text = typeof value === "string" ? value : safeStringify(value);
    if (!text)
        return "";
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
