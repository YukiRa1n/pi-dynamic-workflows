/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */

import { createCodingTools, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { safeStringify } from "./safe-serialize.js";
import { runWorkflow, type WorkflowRunResult } from "./workflow.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";

function isRegistered(pi: ExtensionAPI, name: string): boolean {
  try {
    return (pi.getCommands?.() ?? []).some((c: { name: string }) => c.name === name);
  } catch {
    return false;
  }
}

function reportText(result: WorkflowRunResult): string {
  const r = result.result as { report?: unknown } | undefined;
  if (r && typeof r.report === "string" && r.report.trim()) return r.report;
  return safeStringify(result.result);
}

/**
 * Parse a command argument string into an `args` object for the script.
 * Supports `key=value` tokens; everything else collects into `_` (and `_raw`).
 * Declared parameter defaults fill in missing keys.
 */
export function parseCommandArgs(raw: string, parameters?: SavedWorkflow["parameters"]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const positional: string[] = [];
  for (const tok of raw.trim().split(/\s+/).filter(Boolean)) {
    const eq = tok.indexOf("=");
    if (eq > 0) out[tok.slice(0, eq)] = tok.slice(eq + 1);
    else positional.push(tok);
  }
  out._ = positional.join(" ");
  out._raw = raw.trim();
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    if (out[key] === undefined && spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

/** Register one saved workflow as a `/<name>` command (idempotent).
 * When a WorkflowManager is provided, the workflow runs through it (visible in
 * /workflows TUI, background execution, task panel). Otherwise falls back to
 * the inline runWorkflow() (foreground, no TUI tracking).
 *
 * Pi has no `unregisterCommand`, so a command cannot be removed mid-session
 * after its workflow is deleted (it is correctly gone on next launch, since
 * registerAllSavedWorkflows only registers what's in storage). The optional
 * `exists` predicate lets the handler detect that case at invocation time and
 * tell the user to reload rather than silently re-running a deleted workflow. */
export function registerSavedWorkflow(
  pi: ExtensionAPI,
  cwd: string | (() => string),
  wf: Pick<SavedWorkflow, "name" | "description" | "script" | "parameters">,
  manager?: WorkflowManager | (() => WorkflowManager | undefined),
  exists?: () => boolean,
  /**
   * Live loader for this command's workflow. Prefer this over the registration-
   * time `wf` snapshot: after an in-process project switch the same slash
   * command name may resolve to a different script (or nothing) in the new
   * project's storage. When omitted, `wf` is used as a frozen snapshot.
   */
  loadWorkflow?: () => Pick<SavedWorkflow, "name" | "description" | "script" | "parameters"> | null | undefined,
): void {
  if (isRegistered(pi, wf.name)) return;
  const getCwd = typeof cwd === "function" ? cwd : () => cwd;
  const getManager = typeof manager === "function" ? manager : () => manager;
  pi.registerCommand(wf.name, {
    description: wf.description || `Saved workflow: ${wf.name}`,
    async handler(args: string, ctx: ExtensionCommandContext) {
      // Resolve the workflow at invocation time so a cross-project session
      // switch picks up the target project's script (or reports deletion)
      // instead of replaying the source project's registration-time snapshot.
      const liveWf = loadWorkflow ? loadWorkflow() : exists && !exists() ? null : wf;
      if (!liveWf) {
        ctx.ui.notify(
          `/${wf.name} is not available in this project — reload the session to drop the stale command.`,
          "warning",
        );
        return;
      }
      try {
        const liveManager = getManager();
        if (liveManager) {
          // Run through the WorkflowManager's background path: the handler
          // returns immediately (awaiting the promise here would block the whole
          // session, #104), progress shows in the /workflows TUI and task panel,
          // and installResultDelivery posts the result back into the
          // conversation on completion — sending it here too would duplicate it.
          const { runId } = liveManager.startInBackground(liveWf.script, parseCommandArgs(args, liveWf.parameters));
          ctx.ui.notify(
            `/${liveWf.name} running in the background (${runId}) — watch the task panel or /workflows; the result is posted here when it finishes.`,
            "info",
          );
          return;
        }
        // Fallback: inline runWorkflow (foreground, no TUI tracking, blocks).
        const liveCwd = getCwd();
        ctx.ui.notify(`Starting /${liveWf.name}…`, "info");
        const result = await runWorkflow(liveWf.script, {
          cwd: liveCwd,
          args: parseCommandArgs(args, liveWf.parameters),
          tools: createCodingTools(liveCwd),
          onPhase: (title) => ctx.ui.setStatus(`wf:${liveWf.name}`, `${liveWf.name}: ${title}`),
        });
        ctx.ui.setStatus(`wf:${liveWf.name}`, undefined);
        await pi.sendMessage({
          customType: `workflow:${liveWf.name}`,
          content: reportText(result),
          display: true,
        });
      } catch (error) {
        ctx.ui.setStatus(`wf:${liveWf.name}`, undefined);
        ctx.ui.notify(`/${liveWf.name} failed: ${error instanceof Error ? error.message : error}`, "error");
      }
    },
  });
}

/** Register every saved workflow found in storage.
 * When a WorkflowManager is provided, workflows run through it (visible in
 * /workflows TUI, background execution, task panel). Idempotent: names already
 * registered (including from a previous project) are skipped at registration
 * time, but each handler re-loads by name from the live storage so a later
 * project switch executes the target project's script. Call again after a
 * cross-project session_start to pick up target-only names. */
export function registerAllSavedWorkflows(
  pi: ExtensionAPI,
  cwd: string | (() => string),
  storage: WorkflowStorage | (() => WorkflowStorage),
  manager?: WorkflowManager | (() => WorkflowManager | undefined),
): void {
  const getStorage = typeof storage === "function" ? storage : () => storage;
  const getCwd = typeof cwd === "function" ? cwd : () => cwd;
  for (const wf of getStorage().list()) {
    const name = wf.name;
    registerSavedWorkflow(
      pi,
      getCwd,
      wf,
      manager,
      () => getStorage().load(name) != null,
      () => getStorage().load(name),
    );
  }
}
