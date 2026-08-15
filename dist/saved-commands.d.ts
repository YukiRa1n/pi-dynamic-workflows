/**
 * Saved workflows as `/<name>` slash commands. Each saved workflow becomes a
 * command that runs its script, passing parsed arguments through as `args`.
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "./workflow-manager.js";
import type { SavedWorkflow, WorkflowStorage } from "./workflow-saved.js";
/**
 * Parse a command argument string into an `args` object for the script.
 * Supports `key=value` tokens; everything else collects into `_` (and `_raw`).
 * Declared parameter defaults fill in missing keys.
 */
export declare function parseCommandArgs(raw: string, parameters?: SavedWorkflow["parameters"]): Record<string, unknown>;
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
export declare function registerSavedWorkflow(pi: ExtensionAPI, cwd: string | (() => string), wf: Pick<SavedWorkflow, "name" | "description" | "script" | "parameters">, manager?: WorkflowManager | (() => WorkflowManager | undefined), exists?: () => boolean, 
/**
 * Live loader for this command's workflow. Prefer this over the registration-
 * time `wf` snapshot: after an in-process project switch the same slash
 * command name may resolve to a different script (or nothing) in the new
 * project's storage. When omitted, `wf` is used as a frozen snapshot.
 */
loadWorkflow?: () => Pick<SavedWorkflow, "name" | "description" | "script" | "parameters"> | null | undefined): void;
/** Register every saved workflow found in storage.
 * When a WorkflowManager is provided, workflows run through it (visible in
 * /workflows TUI, background execution, task panel). Idempotent: names already
 * registered (including from a previous project) are skipped at registration
 * time, but each handler re-loads by name from the live storage so a later
 * project switch executes the target project's script. Call again after a
 * cross-project session_start to pick up target-only names. */
export declare function registerAllSavedWorkflows(pi: ExtensionAPI, cwd: string | (() => string), storage: WorkflowStorage | (() => WorkflowStorage), manager?: WorkflowManager | (() => WorkflowManager | undefined)): void;
