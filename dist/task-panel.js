/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { aggregateAgentUsage, fmtCost, fmtTokenSegment, shorten, statusIcon, tokenFigures, } from "./display.js";
import { truncateUtf8 } from "./safe-serialize.js";
import { DEFAULT_WORKFLOW_RESULT_CHARS, summarizeWorkflowResult } from "./workflow-result-projection.js";
import { shortModel } from "./workflow-ui.js";
// `tokenUsage` is included so the detailed panel's live token/s counter refreshes
// as tokens accrue (not only on agent start/end). It is harmless in compact mode —
// it redraws identical content.
const RUN_EVENTS = [
    "agentStart",
    "agentEnd",
    "phase",
    "log",
    "tokenUsage",
    "complete",
    "error",
    "stopped",
    "paused",
    "resumed",
];
/** Events after which a run is gone and its token-rate samples can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped", "paused", "deleted"];
const MAX_TOKEN_SAMPLES_PER_RUN = 128;
const MAX_TOKEN_SAMPLE_RUNS = 1024;
/** Standalone retry projections are only a cache. Durable terminal deliveries
 * remain authoritative in WorkflowManager's outbox and are reconstructed on
 * every resume, so this queue can be hard-bounded without losing results. */
const MAX_PENDING_DELIVERY_PROJECTIONS = 32;
/** Standalone hosts cannot observe provider acceptance, so submit only a
 * bounded number of durable records per host generation. Remaining records
 * stay in the outbox for a later generation instead of expanding a process-
 * lifetime dedup set without limit. */
const MAX_STANDALONE_SUBMISSIONS_PER_GENERATION = 512;
function safeAgentSnapshots(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((agent) => {
        return !!agent && typeof agent === "object" && typeof agent.status === "string";
    });
}
function fitLine(line, width) {
    if (typeof width !== "number" || !Number.isFinite(width))
        return line;
    const maxWidth = Math.max(0, Math.floor(width));
    if (visibleWidth(line) <= maxWidth)
        return line;
    return truncateToWidth(line, maxWidth);
}
export function deliverText(run, opts = {}) {
    const maxChars = typeof opts.maxChars === "number" && Number.isFinite(opts.maxChars)
        ? Math.max(0, Math.floor(opts.maxChars))
        : DEFAULT_WORKFLOW_RESULT_CHARS;
    const summary = summarizeWorkflowResult(run.result?.result, maxChars);
    const tu = run.result?.tokenUsage;
    const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
    const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
    const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
    const agents = run.result?.agentCount ?? run.snapshot.agentCount;
    const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
    const lines = [
        `✓ Background workflow "${run.snapshot.name}" finished (${agents} agents${tokens}${duration}).`,
        "",
        summary,
    ];
    // The full result is intentionally not duplicated into provider context.
    // Point at the durable run record for exact JSON and per-agent reports.
    if (opts.resultPath)
        lines.push("", `↳ Full result and subagent reports: ${opts.resultPath}`);
    return lines.join("\n");
}
/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager, runId) {
    try {
        return join(manager.getPersistence().getRunsDir(), `${runId}.json`);
    }
    catch {
        return undefined;
    }
}
function deliveryManager(manager) {
    return manager;
}
function enqueuePending(holder, payload) {
    const deliveryId = payload.details?.deliveryId;
    if (deliveryId && holder.pending.some((item) => item.details?.deliveryId === deliveryId))
        return;
    if (holder.pending.length >= MAX_PENDING_DELIVERY_PROJECTIONS) {
        // Durable records are replayed from WorkflowManager's stable-ID outbox on
        // resume. Keep the bounded in-memory cache biased toward the newest event;
        // an evicted durable projection is not acknowledged or deleted and will be
        // reconstructed later. Non-durable usage-limit notices are best-effort and
        // may be displaced under sustained delivery failure.
        holder.pending.shift();
        if (!holder.warnedProjectionEviction) {
            holder.warnedProjectionEviction = true;
            console.warn(`[workflow-delivery] pending projection cache reached ${MAX_PENDING_DELIVERY_PROJECTIONS} entries; ` +
                "older projections may be evicted from memory. Durable results remain replayable via /workflows.");
        }
    }
    holder.pending.push(payload);
}
function trySend(holder, payload) {
    const startedGeneration = holder.generation;
    const runId = payload.details?.runId;
    const deliveryId = payload.details?.deliveryId;
    const standalone = !holder.sendResult;
    if (standalone &&
        deliveryId &&
        !holder.submittedGeneration.has(deliveryId) &&
        holder.submittedGeneration.size >= MAX_STANDALONE_SUBMISSIONS_PER_GENERATION) {
        enqueuePending(holder, payload);
        return;
    }
    if (runId && deliveryId && !holder.manager.acknowledgeDelivery(runId, deliveryId, startedGeneration, "submitted")) {
        enqueuePending(holder, payload);
        return;
    }
    if (standalone && deliveryId)
        holder.submittedGeneration.set(deliveryId, startedGeneration);
    try {
        if (holder.sendResult) {
            holder.sendResult(payload);
            return;
        }
        const ret = holder.pi.sendMessage({ customType: "workflow-result", content: payload.content, display: true, details: payload.details }, 
        // DELIVERY-PRODUCT-001: final results must land at the next safe point of
        // an ACTIVE turn (like activity messages and like tool results), not wait
        // for the whole turn to finish. triggerTurn wakes an idle session.
        { triggerTurn: true, deliverAs: "steer" });
        // sendMessage may return a promise (defensive — current pi types it void).
        // Standalone delivery has no provider-response hook, so even a successful
        // host submission remains in the durable outbox. The next generation can
        // replay it at-least-once; only the full extension bridge can acknowledge
        // after provider acceptance.
        void Promise.resolve(ret).catch((err) => {
            if (standalone && deliveryId && holder.submittedGeneration.get(deliveryId) === startedGeneration) {
                holder.submittedGeneration.delete(deliveryId);
            }
            enqueuePending(holder, payload);
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[workflow-delivery] async send failed; queued for retry: ${msg}`);
            if (holder.generation !== startedGeneration && !holder.suspended) {
                flushPending(holder);
            }
        });
    }
    catch (err) {
        if (standalone && deliveryId && holder.submittedGeneration.get(deliveryId) === startedGeneration) {
            holder.submittedGeneration.delete(deliveryId);
        }
        enqueuePending(holder, payload);
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[workflow-delivery] send failed; queued for retry: ${msg}`);
    }
}
function flushPending(holder) {
    if (holder.suspended || holder.pending.length === 0)
        return;
    const queued = holder.pending.splice(0, holder.pending.length);
    holder.warnedProjectionEviction = false;
    for (const payload of queued)
        trySend(holder, payload);
}
/** Reconstruct terminal notifications that survived a process/session restart.
 * Standalone consumers do not have extensions/workflow.ts's richer bridge, so
 * they must refill from the manager's durable outbox themselves. */
function replayStandaloneOutbox(holder) {
    if (holder.sendResult)
        return;
    try {
        const records = holder.manager
            .listPendingDeliveries()
            .filter((record) => record.kind === "terminal")
            .sort((a, b) => (a.generation ?? -1) - (b.generation ?? -1) || a.sequence - b.sequence);
        for (const record of records) {
            if (holder.pending.length >= MAX_PENDING_DELIVERY_PROJECTIONS)
                break;
            if (holder.submittedGeneration.get(record.deliveryId) === holder.generation)
                continue;
            if (holder.pending.some((item) => item.details?.deliveryId === record.deliveryId))
                continue;
            const run = holder.manager.getRun(record.runId);
            const content = run
                ? deliverText(run, { resultPath: persistedResultPath(holder.manager, record.runId) })
                : `${record.runStatus === "completed" ? "✓" : "✗"} Background workflow ${record.runId} ${record.runStatus}.`;
            enqueuePending(holder, {
                content,
                details: {
                    status: record.runStatus === "completed" ? "completed" : "failed",
                    isError: record.runStatus !== "completed",
                    notificationKind: "workflow-result",
                    runId: record.runId,
                    sequence: record.sequence,
                    deliveryId: record.deliveryId,
                },
            });
        }
    }
    catch {
        // A transient persistence/read failure leaves the durable outbox untouched;
        // the next generation can retry reconstruction.
    }
}
/**
 * Stop live sends on this manager. In-flight completions only enqueue until
 * {@link resumeResultDelivery} runs (from session_start, after Pi has bound
 * the extension runtime) or the process exits (quit — results stay on disk).
 *
 * Call from session_shutdown BEFORE handoff or discard so a completion that
 * races the teardown cannot deliver into the outgoing session.
 */
export function suspendResultDelivery(manager) {
    const holder = deliveryManager(manager).__holder;
    if (holder)
        holder.suspended = true;
}
/**
 * Unsuspend and flush any queued deliveries. Must run only after Pi has
 * finished constructing the AgentSession and bound sendMessage (i.e. from
 * session_start) — calling it from the extension factory hits the
 * "runtime not initialized" stub and re-queues forever.
 */
export function resumeResultDelivery(manager) {
    const holder = deliveryManager(manager).__holder;
    if (!holder)
        return;
    holder.suspended = false;
    // First submit the bounded live retry cache, then refill from the durable
    // outbox in finite batches. Durable outboxes are schema-bounded (512 records),
    // so this pump cannot grow memory or loop without progress.
    flushPending(holder);
    while (true) {
        const before = holder.submittedGeneration.size;
        replayStandaloneOutbox(holder);
        if (holder.pending.length === 0)
            break;
        flushPending(holder);
        if (holder.pending.length > 0 || holder.submittedGeneration.size === before)
            break;
    }
}
/**
 * When a background run finishes (or fails), deliver its result back into the
 * conversation AND continue the turn so the assistant can act on it — without
 * blocking the user meanwhile:
 *
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the
 *    result to the model so the paused conversation continues.
 *  - `deliverAs: "steer"` means that if the user is busy in another turn, the
 *    result is queued and picked up at the next safe point — the active provider
 *    request is never aborted.
 *
 * Set up once per extension; idempotent via an internal guard. Across session
 * replacement the manager (and this listener) survive via the handoff path;
 * each new generation only refreshes `holder.pi` and flushes any messages that
 * failed or arrived while delivery was suspended.
 */
const resultContextBridges = new WeakSet();
/**
 * Package-root consumers do not load extensions/workflow.ts, so they do not
 * receive the extension's broader custom-message bridge. Install the minimal
 * workflow-result bridge alongside the delivery API to preserve tool-result
 * semantics for standalone package users too.
 */
function installResultContextBridge(pi) {
    const key = pi;
    if (resultContextBridges.has(key))
        return;
    resultContextBridges.add(key);
    pi.on("context", (event) => {
        const output = [];
        for (let index = 0; index < event.messages.length; index++) {
            const message = event.messages[index];
            if (message?.role !== "custom" || message.customType !== "workflow-result") {
                output.push(message && typeof message === "object" ? { ...message } : message);
                continue;
            }
            const contentDescriptor = message && typeof message === "object" ? Object.getOwnPropertyDescriptor(message, "content") : undefined;
            const rawText = contentDescriptor && !contentDescriptor.get && !contentDescriptor.set ? contentDescriptor.value : "";
            const text = truncateUtf8(typeof rawText === "string" ? rawText : String(rawText ?? ""), 32_000, "…");
            const deliveryId = message.details && typeof message.details.deliveryId === "string" ? message.details.deliveryId : undefined;
            const toolCallId = deliveryId ?? `workflow_result_${index}_${message.timestamp ?? 0}`;
            output.push({
                role: "assistant",
                content: [
                    {
                        type: "toolCall",
                        id: toolCallId,
                        name: "workflow_delivery",
                        arguments: { customType: "workflow-result", status: message.details?.status ?? null },
                    },
                ],
                stopReason: "toolUse",
                timestamp: message.timestamp ?? Date.now(),
            });
            output.push({
                role: "toolResult",
                toolCallId,
                toolName: "workflow_delivery",
                content: [{ type: "text", text }],
                isError: message.details?.isError === true,
                timestamp: message.timestamp ?? Date.now(),
            });
        }
        return { messages: output };
    });
}
export function installResultDelivery(pi, manager, opts = {}) {
    // Standalone package-root consumers need this minimal bridge. The full Pi
    // extension installs a richer task-notification bridge for all workflow
    // message types and disables this one to avoid double transformation.
    if (opts.installContextBridge !== false)
        installResultContextBridge(pi);
    const m = deliveryManager(manager);
    if (m.__deliveryInstalled) {
        // The manager and listeners survive session replacement. Refresh every
        // generation-bound dependency and bump the generation (so in-flight
        // rejects from the previous pi can self-flush once resumed). Do NOT
        // unsuspend or flush here: the factory runs before Pi bindCore(), so
        // sendMessage is still the "runtime not initialized" stub. session_start
        // calls resumeResultDelivery() once the runtime is live.
        if (m.__holder) {
            m.__holder.pi = pi;
            m.__holder.loadSettings = opts.loadSettings;
            m.__holder.sendResult = opts.sendResult;
            m.__holder.generation += 1;
            m.__holder.submittedGeneration.clear();
        }
        return;
    }
    m.__deliveryInstalled = true;
    m.__holder = {
        manager,
        pi,
        loadSettings: opts.loadSettings,
        sendResult: opts.sendResult,
        suspended: false,
        pending: [],
        submittedGeneration: new Map(),
        warnedProjectionEviction: false,
        generation: 0,
    };
    const deliver = (payload) => {
        const holder = m.__holder;
        if (!holder)
            return;
        if (holder.suspended) {
            enqueuePending(holder, payload);
            return;
        }
        trySend(holder, payload);
    };
    let notificationSequence = 0;
    manager.on("complete", ({ runId, deliveryId, sequence }) => {
        const run = manager.getRun(runId);
        // Only background/resumed runs are delivered: a foreground (sync) run already
        // returns its result inline as the tool result, so re-delivering would dup it.
        if (run?.background) {
            let maxChars;
            try {
                maxChars = m.__holder?.loadSettings?.().deliveredResultMaxChars;
            }
            catch {
                // Settings are optional presentation input; delivery must still proceed.
            }
            deliver({
                content: deliverText(run, {
                    resultPath: persistedResultPath(manager, runId),
                    maxChars,
                }),
                details: {
                    status: "completed",
                    isError: false,
                    notificationKind: "workflow-result",
                    runId,
                    sequence: sequence ?? notificationSequence++,
                    deliveryId,
                },
            });
        }
    });
    manager.on("error", ({ runId, error, deliveryId, sequence, }) => {
        if (!manager.getRun(runId)?.background)
            return;
        deliver({
            content: `✗ Background workflow ${runId} failed: ${error?.message ?? "unknown error"}`,
            details: {
                status: "failed",
                isError: true,
                notificationKind: "workflow-result",
                runId,
                sequence: sequence ?? notificationSequence++,
                deliveryId,
            },
        });
    });
    // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
    // user it is resumable once their budget refills, rather than letting it look dead.
    // Manual pause() also emits "paused" but with no reason — guard so only the
    // usage-limit case delivers a message.
    manager.on("paused", ({ runId, reason, error, resetHint, }) => {
        if (reason !== "usage_limit")
            return;
        if (!manager.getRun(runId)?.background)
            return;
        const when = resetHint ? ` (${resetHint})` : "";
        const cause = error?.message ?? "provider usage limit reached";
        deliver({
            content: `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
                `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`,
            details: {
                status: "paused",
                isError: true,
                notificationKind: "workflow-result",
                runId,
                sequence: notificationSequence++,
            },
        });
    });
}
export function renderPanel(manager, theme, width) {
    const all = manager.listRuns();
    const active = all.filter((r) => r.status === "running" || r.status === "paused");
    if (!active.length)
        return [];
    const rows = active.map((r) => {
        const live = manager.getRun(r.runId);
        // UIOBS-007: persisted JSON is not structurally validated — a corrupt or
        // legacy `agents` value (null/object) must never crash the panel render.
        const agents = safeAgentSnapshots(live?.snapshot.agents ?? r.agents);
        const done = agents.filter((a) => a.status === "done").length;
        const icon = r.status === "paused" ? "⏸" : "◆";
        const phase = live?.snapshot.currentPhase ? ` · ${live.snapshot.currentPhase}` : "";
        return `  ${icon} ${r.workflowName}  ${done}/${agents.length} agents${phase}`;
    });
    // Finished runs leave this live panel but are kept in the navigator. Tell the
    // user so a completed run doesn't look like it vanished.
    const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
    const hint = theme.fg("dim", finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator");
    return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}
// ─── Detailed mode: live token rate ────────────────────────────────────────────
/** Rolling window for the token/s rate. Older samples age out so a stall decays to 0. */
const RATE_WINDOW_MS = 10_000;
/** Per-run (timestamp, cumulative total) samples, keyed by the persisted runId so
 *  the rolling rate survives pause→resume. Cleared when a run ends. */
const tokenSamples = new Map();
/** Record a token-total sample for `runId` at time `now` (ms). */
export function sampleTokens(runId, total, now) {
    const samples = tokenSamples.get(runId) ?? [];
    const last = samples[samples.length - 1];
    // Collapse repeat renders within the same instant (e.g. width recalcs).
    if (last && last.ts === now && last.total === total)
        return;
    samples.push({ ts: now, total });
    if (samples.length > MAX_TOKEN_SAMPLES_PER_RUN)
        samples.splice(0, samples.length - MAX_TOKEN_SAMPLES_PER_RUN);
    if (!tokenSamples.has(runId) && tokenSamples.size >= MAX_TOKEN_SAMPLE_RUNS) {
        const oldestRun = tokenSamples.keys().next().value;
        if (oldestRun)
            tokenSamples.delete(oldestRun);
    }
    // Drop samples beyond the rolling window, always keeping ≥2 so a rate is computable.
    while (samples.length > 2 && now - samples[0].ts > RATE_WINDOW_MS)
        samples.shift();
    tokenSamples.set(runId, samples);
}
/** Tokens/second over the rolling window; 0 when too few samples or totals plateau. */
export function tokensPerSecond(runId) {
    const samples = tokenSamples.get(runId);
    if (!samples || samples.length < 2)
        return 0;
    const oldest = samples[0];
    const newest = samples[samples.length - 1];
    const elapsedMs = newest.ts - oldest.ts;
    if (elapsedMs <= 0)
        return 0;
    const delta = newest.total - oldest.total;
    if (delta <= 0)
        return 0;
    return (delta / elapsedMs) * 1000;
}
/** Forget a run's samples (call when it finishes) so the map can't grow unbounded. */
export function clearTokenSamples(runId) {
    tokenSamples.delete(runId);
}
/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n) {
    if (!Number.isFinite(n) || n <= 0)
        return "";
    if (n < 1000)
        return `${Math.round(n)}`;
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}
/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1)
        return 8;
    return Math.min(1000, Math.floor(value));
}
/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(snap, agents, maxAgents, theme) {
    const dim = (t) => theme.fg("dim", t);
    const lines = [];
    // Group agents by phase, declared order first then discovery order (as the navigator does).
    const order = snap.phases.length ? [...snap.phases] : [];
    const byPhase = new Map();
    for (const a of agents) {
        const key = a.phase ?? "(no phase)";
        if (!byPhase.has(key))
            byPhase.set(key, []);
        byPhase.get(key)?.push(a);
        if (!order.includes(key))
            order.push(key);
    }
    for (const title of order) {
        const phaseAgents = byPhase.get(title) ?? [];
        if (!phaseAgents.length)
            continue;
        const done = phaseAgents.filter((a) => a.status === "done").length;
        const running = phaseAgents.filter((a) => a.status === "running").length;
        const errors = phaseAgents.filter((a) => a.status === "error").length;
        const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
        const complete = done + errors + skipped === phaseAgents.length;
        const marker = running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
        const phaseMeta = [
            `${done}/${phaseAgents.length} agents`,
            running ? `${running} running` : "",
            errors ? `${errors} errors` : "",
            fmtTokenSegment(aggregateAgentUsage(phaseAgents), fmtTokensShort),
        ]
            .filter(Boolean)
            .join(" · ");
        lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));
        const visible = phaseAgents.slice(-maxAgents);
        for (const a of visible) {
            const segment = fmtTokenSegment(tokenFigures(a.tokenUsage, a.tokens), fmtTokensShort);
            const tok = segment ? dim(` ${segment}`) : "";
            const mdl = shortModel(a.model);
            const model = mdl ? dim(` · ${mdl}`) : "";
            lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}`);
        }
        if (phaseAgents.length > visible.length) {
            lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier agents`));
        }
    }
    return lines;
}
/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and a live token/s rate, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). `now` is injected for testability.
 */
export function renderPanelDetailed(manager, theme, width, maxAgents, now) {
    const all = manager.listRuns();
    const active = all.filter((r) => r.status === "running" || r.status === "paused");
    if (!active.length)
        return [];
    const dim = (t) => theme.fg("dim", t);
    const out = [theme.bold(`Workflows running (${active.length}):`)];
    for (const r of active) {
        const live = manager.getRun(r.runId);
        const snap = live?.snapshot;
        // UIOBS-007: same malformed-state guard as the compact panel.
        const agents = safeAgentSnapshots(snap?.agents ?? r.agents);
        const done = agents.filter((a) => a.status === "done").length;
        const icon = r.status === "paused" ? "⏸" : "◆";
        const usage = snap?.tokenUsage ?? r.tokenUsage;
        // The run-level tokenUsage aggregate is only finalized when the run ends, so
        // it reads 0 for the whole live run; per-agent figures update on each agent
        // completion, so aggregate those instead. The rate samples the same
        // fresh+cacheRead sum the header displays, so tok/s tracks the visible
        // figures. Tokens land at agent-completion granularity, so the rate reflects
        // completion throughput — it decays to 0 during a single long-running agent
        // or a stall (which is the intended signal). Paused runs don't accrue
        // tokens, so their rate is suppressed (a stalled rate would mislead).
        const runUsage = aggregateAgentUsage(agents);
        sampleTokens(r.runId, runUsage.fresh + runUsage.cacheRead, now);
        const rate = r.status === "running" ? tokensPerSecond(r.runId) : 0;
        const meta = [
            `${done}/${agents.length} agents`,
            snap?.currentPhase || "",
            fmtTokenSegment(runUsage, fmtTokensShort),
            // (cost is only known once the run finalizes its usage.)
            usage?.cost ? fmtCost(usage.cost) : "",
            rate > 0 ? `${Math.round(rate)} tok/s` : "",
        ]
            .filter(Boolean)
            .join(" · ");
        out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
        if (snap)
            out.push(...renderRunBody(snap, agents, maxAgents, theme));
    }
    const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
    out.push(dim(finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator"));
    return out.map((line) => fitLine(line, width));
}
/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(_pi, manager, ui, opts = {}) {
    // Live-read settings with a ~1s TTL: a render-path disk read every frame would
    // be wasteful, but re-reading at most once a second still makes
    // /workflows-progress take effect "immediately" (no restart).
    let cached = {};
    let cachedAt = Number.NEGATIVE_INFINITY;
    const settings = () => {
        if (!opts.loadSettings)
            return cached;
        const now = Date.now();
        if (now - cachedAt > 1000) {
            try {
                cached = opts.loadSettings() ?? {};
            }
            catch {
                cached = {};
            }
            cachedAt = now;
        }
        return cached;
    };
    const hasActiveRun = () => manager.listRuns().some((r) => r.status === "running" || r.status === "paused");
    ui.setWidget("workflow-tasks", (tui, theme) => {
        let timer;
        let disposed = false;
        const stopTimer = () => {
            if (!timer)
                return;
            clearTimeout(timer);
            timer = undefined;
        };
        const syncTimer = () => {
            if (disposed)
                return;
            if (settings().progressPanelMode !== "detailed" || !hasActiveRun()) {
                stopTimer();
                return;
            }
            if (timer)
                return;
            timer = setTimeout(() => {
                timer = undefined;
                if (disposed)
                    return;
                tui.requestRender();
                syncTimer();
            }, 2000);
            timer.unref?.();
        };
        const onEvent = () => {
            tui.requestRender();
            syncTimer();
        };
        for (const ev of RUN_EVENTS)
            manager.on(ev, onEvent);
        const onRunEnd = ({ runId }) => {
            clearTokenSamples(runId);
            syncTimer();
        };
        for (const ev of RUN_END_EVENTS)
            manager.on(ev, onRunEnd);
        // Detailed mode samples token/s only while at least one run is active.
        // Compact/idle panels own no periodic timer and perform no settings/disk
        // reads merely because the widget exists.
        syncTimer();
        // Purely informational: it lists running runs and re-renders on events. To
        // open the navigator, the user runs /workflows (the panel takes no input).
        const comp = {
            render: (width) => {
                const s = settings();
                if (s.progressPanelMode === "detailed") {
                    return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
                }
                return renderPanel(manager, theme, width);
            },
            invalidate: () => { },
            dispose: () => {
                disposed = true;
                stopTimer();
                for (const ev of RUN_EVENTS)
                    manager.off(ev, onEvent);
                for (const ev of RUN_END_EVENTS)
                    manager.off(ev, onRunEnd);
            },
        };
        return comp;
    }, { placement: "belowEditor" });
}
