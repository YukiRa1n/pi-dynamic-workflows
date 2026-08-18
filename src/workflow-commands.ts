/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  fmtFull,
  fmtTokenSegment,
  recomputeWorkflowSnapshot,
  renderWorkflowText,
  tokenFigures,
  type WorkflowSnapshot,
} from "./display.js";
import { type EffortState, effortDirective } from "./effort-command.js";
import type { PersistedRunState } from "./run-persistence.js";
import { redactForModel, sanitizeForTerminal } from "./sanitize.js";
import { registerSavedWorkflow } from "./saved-commands.js";
import { buildForcedWorkflowPrompt } from "./workflow-editor.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
import { openWorkflowNavigator } from "./workflow-ui.js";

const STATUS_ICON: Record<string, string> = {
  pending: "·",
  running: "◆",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  aborted: "⊘",
};

const USAGE =
  "Usage: /workflows [list] | run <prompt> | status <id> | watch <id> | stop <id> | pause <id> | resume <id> | steer <id> [same_task_correction|blocker_answer|changed_fact] <message> | rm <id> | save <name> [runId]";

const RUN_USAGE = "Usage: /workflows run <prompt> — force a dynamic workflow from the prompt";

function terminalText(value: unknown): string {
  return sanitizeForTerminal(typeof value === "string" ? value : String(value ?? ""));
}

function modelText(value: string): string {
  return sanitizeForTerminal(redactForModel(value, Buffer.byteLength(value, "utf8")));
}

function summarizeRun(run: PersistedRunState): string {
  const icon = STATUS_ICON[run.status] ?? "?";
  const done = run.agents.filter((a) => a.status === "done").length;
  const total = run.agents.length;
  const segment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  const tokens = segment ? ` · ${segment}` : "";
  const workflowName = terminalText(run.workflowName);
  return modelText(`${icon} ${run.runId}  ${workflowName} [${run.status}] ${done}/${total} agents${tokens}`);
}

function oneLineProgress(snapshot: WorkflowSnapshot, status?: string): string {
  const total = snapshot.agents.length;
  const done = snapshot.agents.filter((a) => a.status === "done").length;
  const running = snapshot.agents.filter((a) => a.status === "running").length;
  const errs = snapshot.agents.filter((a) => a.status === "error").length;
  const phase = snapshot.currentPhase ? ` · ${terminalText(snapshot.currentPhase)}` : "";
  const marker = status === "paused" ? "⏸" : "◆";
  return `${marker} ${terminalText(snapshot.name)}: ${done}/${total} done${running ? `, ${running} running` : ""}${
    errs ? `, ${errs} err` : ""
  }${phase}`;
}

/**
 * Subscribe to a running run's events and stream live progress to the status bar,
 * printing the final snapshot when it finishes. Non-blocking: returns true if the
 * run was active and is now being watched, false otherwise. Listeners clean up on
 * completion so nothing leaks.
 */
function watchRun(
  manager: WorkflowManager,
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  id: string,
  onDispose?: () => void,
): (() => void) | false {
  const active = manager.getRun(id);
  if (active?.status !== "running" && active?.status !== "paused") return false;

  const key = `wf:${id}`;
  const update = () => {
    const run = manager.getRun(id);
    if (run) ctx.ui.setStatus(key, oneLineProgress(run.snapshot, run.status));
  };
  const onEvent = (e: { runId?: string }) => {
    if (!e || e.runId === id) update();
  };
  let settled = false;
  // Pausing is a resumable checkpoint, not a terminal watcher state. Keep the
  // subscription alive through pause -> resume so a later completion is still
  // delivered exactly once.
  const progressEvents = ["agentStart", "agentEnd", "phase", "log", "paused", "resumed"];
  const finalEvents = ["complete", "error", "stopped", "deleted"];
  const dispose = () => {
    if (settled) return;
    settled = true;
    for (const ev of progressEvents) manager.off(ev, onEvent);
    for (const ev of finalEvents) manager.off(ev, finish);
    ctx.ui.setStatus(key, undefined);
    onDispose?.();
  };
  const finish = (e: { runId?: string }) => {
    if (e && e.runId !== id) return;
    if (settled) return;
    const run = manager.getRun(id);
    dispose();
    if (run) {
      try {
        const sent = pi.sendMessage(
          {
            customType: "workflows",
            content: renderWorkflowText(
              recomputeWorkflowSnapshot(run.snapshot),
              run.status === "completed",
              run.status,
            ),
            display: true,
          },
          { triggerTurn: false },
        );
        void Promise.resolve(sent).catch((err: unknown) => {
          console.warn(
            `[workflows] async completion update failed: ${terminalText(err instanceof Error ? err.message : String(err))}`,
          );
        });
      } catch (err) {
        console.warn(
          `[workflows] completion update failed: ${terminalText(err instanceof Error ? err.message : String(err))}`,
        );
      }
    }
  };
  for (const ev of progressEvents) manager.on(ev, onEvent);
  for (const ev of finalEvents) manager.on(ev, finish);
  update();
  return dispose;
}

function renderPersistedStatus(run: PersistedRunState): string {
  const workflowName = terminalText(run.workflowName);
  const lines = [`${STATUS_ICON[run.status] ?? "?"} ${workflowName} (${run.runId}) — ${run.status}`];
  if (run.currentPhase) lines.push(`  phase: ${terminalText(run.currentPhase)}`);
  for (const agent of run.agents) {
    const icon =
      agent.status === "done" ? "✓" : agent.status === "error" ? "✗" : agent.status === "running" ? "◆" : "·";
    lines.push(`  ${icon} ${terminalText(agent.label)}`);
  }
  const tokenSegment = fmtTokenSegment(tokenFigures(run.tokenUsage), fmtFull);
  if (tokenSegment) lines.push(`  tokens: ${tokenSegment}`);
  if (run.durationMs) lines.push(`  duration: ${(run.durationMs / 1000).toFixed(1)}s`);
  return modelText(lines.join("\n"));
}

export interface WorkflowCommandOptions {
  /** Saved-workflow storage, enabling `/workflows save`. */
  storage?: WorkflowStorage;
  /** Live storage accessor when the extension may replace storage after session_start. */
  getStorage?: () => WorkflowStorage | undefined;
  /** Working directory for saved workflows registered via `save`. */
  cwd?: string;
  /** Live cwd accessor. */
  getCwd?: () => string;
  /** Live manager accessor; preferred over a closed-over manager. */
  getManager?: () => WorkflowManager;
  /** Standing effort mode; when high/ultra, `/workflows run` carries its directive too. */
  effort?: EffortState;
}

/** Register the `/workflows` command against the shared manager. Idempotent. */
export function registerWorkflowCommands(
  pi: ExtensionAPI,
  manager: WorkflowManager | (() => WorkflowManager),
  opts: WorkflowCommandOptions = {},
): void {
  // Prefer opts.getManager when provided; otherwise accept a getter (or value)
  // as the second argument. Both forms are supported so embedders can pass
  // either a live accessor bag or a bare manager.
  const getManager = opts.getManager ?? (typeof manager === "function" ? manager : () => manager);
  const getCwd = () => opts.getCwd?.() ?? opts.cwd ?? process.cwd();
  const getStorage = () => opts.getStorage?.() ?? opts.storage;
  try {
    const taken = (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === "workflows");
    if (taken) return;
  } catch {
    // getCommands may be unavailable in some hosts; fall through and try to register.
  }

  const registerEvent = (pi as ExtensionAPI & { on?: (event: string, handler: () => void) => void }).on;
  const watcherCleanups = new Map<string, () => void>();
  registerEvent?.call(pi, "session_shutdown", () => {
    for (const cleanup of [...watcherCleanups.values()]) cleanup();
    watcherCleanups.clear();
  });

  pi.registerCommand("workflows", {
    description:
      "Manage workflow runs — no args (opens navigator) | run <prompt> | status/stop/pause/resume/steer | rm | save",
    async handler(args: string, ctx: ExtensionCommandContext) {
      const manager = getManager();
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "list").toLowerCase();
      const id = parts[1];
      const print = (text: string) =>
        pi.sendMessage({ customType: "workflows", content: text, display: true }, { triggerTurn: false });

      switch (sub) {
        case "run": {
          const prompt = args
            .trim()
            .slice(parts[0]?.length ?? 0)
            .trim();
          if (!prompt) {
            ctx.ui.notify(RUN_USAGE, "warning");
            return;
          }

          const effort = opts.effort;
          const extra = effort && effort.level !== "off" ? effortDirective(effort.level) : undefined;
          // `/workflows run` is an explicit, maximal-intent command — use the
          // forcing directive (no "if it's a question just answer" escape),
          // distinct from the heuristic keyword/effort arming.
          const armed = buildForcedWorkflowPrompt(prompt, extra);
          ctx.ui.notify(`Running workflow: ${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "info");
          try {
            await pi.sendMessage(
              { customType: "workflow-run", content: armed, display: true },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          } catch {
            ctx.ui.notify("Could not start the workflow turn.", "error");
          }
          return;
        }
        case "ui":
        case "list": {
          // Interactive navigator when a UI is available; plain text otherwise
          // (print/RPC mode) or when the user explicitly asks for `list`.
          if (sub !== "list" && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, {
              storage: getStorage(),
              cwd: getCwd(),
              getStorage,
              getCwd,
              getManager,
            });
            return;
          }
          if (parts.length === 0 && ctx.hasUI) {
            await openWorkflowNavigator(pi, manager, ctx.ui, {
              storage: getStorage(),
              cwd: getCwd(),
              getStorage,
              getCwd,
              getManager,
            });
            return;
          }
          const runs = manager.listRuns();
          if (!runs.length) {
            await print(
              "No workflow runs yet. Start one with the workflow tool; new invocations always run in the background.",
            );
            return;
          }
          await print(["Workflow runs:", ...runs.map(summarizeRun), "", USAGE].join("\n"));
          return;
        }
        case "watch":
        case "status": {
          if (!id) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          // A running run streams live progress to the status bar and prints the
          // final snapshot when it finishes — no need to re-run the command.
          watcherCleanups.get(id)?.();
          let cleanup: (() => void) | undefined;
          const opened = watchRun(manager, pi, ctx, id, () => {
            if (cleanup && watcherCleanups.get(id) === cleanup) watcherCleanups.delete(id);
          });
          if (opened) {
            cleanup = opened;
            watcherCleanups.set(id, cleanup);
            ctx.ui.notify(`Watching ${id} — live progress in the status bar; result prints when it finishes.`, "info");
            return;
          }
          const live = manager.getSnapshot(id);
          if (live) {
            await print(renderWorkflowText(recomputeWorkflowSnapshot(live), false));
            return;
          }
          const run = manager.listRuns().find((r) => r.runId === id);
          if (!run) {
            ctx.ui.notify(`No workflow run "${id}"`, "error");
            return;
          }
          await print(renderPersistedStatus(run));
          return;
        }
        case "stop": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(
            manager.stop(id) ? `Stopped ${id}` : `Cannot stop ${id} (not running)`,
            manager.getRun(id) ? "info" : "warning",
          );
          return;
        }
        case "pause": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.pause(id) ? `Paused ${id}` : `Cannot pause ${id} (not running)`, "info");
          return;
        }
        case "resume": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          const ok = await manager.resume(id);
          ctx.ui.notify(ok ? `Resumed ${id}` : `Resume not available for ${id} yet`, ok ? "info" : "warning");
          return;
        }
        case "steer": {
          const match = args
            .trim()
            .match(/^steer\s+(\S+)\s+(?:(same_task_correction|blocker_answer|changed_fact)\s+)?([\s\S]+)$/iu);
          if (!match) {
            ctx.ui.notify(
              "Usage: /workflows steer <id> [same_task_correction|blocker_answer|changed_fact] <message>",
              "warning",
            );
            return;
          }
          const [, runId, requestedKind, rawMessage] = match;
          const message = rawMessage.trim();
          if (!message || message.length > 8_000) {
            ctx.ui.notify("Steering message must contain 1-8000 characters.", "warning");
            return;
          }
          const kind = (requestedKind ?? "same_task_correction") as
            | "same_task_correction"
            | "blocker_answer"
            | "changed_fact";
          let queued: string | undefined;
          try {
            queued = manager.enqueueUserMessage(message, runId, kind);
          } catch {
            ctx.ui.notify(`Invalid workflow run ID "${runId}"`, "error");
            return;
          }
          ctx.ui.notify(
            queued
              ? `Queued ${kind} for ${queued}; it will be applied at the next child-call safe point.`
              : `Cannot steer ${runId} (the run is not active or its queue is full).`,
            queued ? "info" : "warning",
          );
          return;
        }
        case "rm": {
          if (!id) return ctx.ui.notify(USAGE, "warning");
          ctx.ui.notify(manager.deleteRun(id) ? `Removed ${id}` : `No run ${id}`, "info");
          return;
        }
        case "save": {
          const name = id;
          if (!name) return ctx.ui.notify("Usage: /workflows save <name> [runId]", "warning");
          const storage = getStorage();
          if (!storage) return ctx.ui.notify("Saving is not available (no storage configured)", "error");
          const runs = manager.listRuns();
          const runIdArg = parts[2];
          // Pick the named run, else the most recent run that still has its script.
          const run = runIdArg ? runs.find((r) => r.runId === runIdArg) : runs.find((r) => r.script);
          if (!run?.script) {
            ctx.ui.notify(runIdArg ? `No run ${runIdArg} with a script` : "No saved run to save", "error");
            return;
          }
          let saved: ReturnType<WorkflowStorage["save"]>;
          try {
            saved = storage.save({
              name,
              description: run.workflowName,
              script: run.script,
              location: "project",
            });
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
          registerSavedWorkflow(
            pi,
            getCwd,
            saved,
            getManager,
            // Always re-resolve storage at invocation — do not close over the
            // instance from this save call, or a later project switch leaves
            // the loader pointed at the source project's store.
            () => getStorage()?.load(name) != null,
            () => getStorage()?.load(name) ?? null,
          );
          ctx.ui.notify(`Saved /${name} (from ${run.runId})`, "info");
          return;
        }
        default:
          ctx.ui.notify(`Unknown subcommand "${sub}". ${USAGE}`, "warning");
      }
    },
  });
}
