/**
 * `/workflows` slash command: list, inspect, and control background workflow runs.
 * Shares the extension's single WorkflowManager so background runs are reachable.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type EffortState } from "./effort-command.js";
import type { WorkflowManager } from "./workflow-manager.js";
import type { WorkflowStorage } from "./workflow-saved.js";
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
export declare function registerWorkflowCommands(pi: ExtensionAPI, manager: WorkflowManager | (() => WorkflowManager), opts?: WorkflowCommandOptions): void;
