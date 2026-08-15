/**
 * Bundled workflow commands: `/deep-research`, `/adversarial-review`,
 * `/multi-perspective`, `/code-review`, and `/codebase-audit`.
 *
 * Each command starts its generated workflow through the WorkflowManager's
 * background path — the command returns immediately, progress is visible in
 * the task panel and `/workflows` (pause/stop work like any managed run), and
 * the report is delivered back into the conversation on completion by
 * installResultDelivery. Running inline in the handler instead would block the
 * whole session until the workflow finished (#104).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WorkflowManager } from "./workflow-manager.js";
import { type WorkflowStorage } from "./workflow-saved.js";
export declare function registerBuiltinWorkflows(pi: ExtensionAPI, opts: {
    cwd?: string;
    manager?: WorkflowManager;
    storage?: WorkflowStorage;
    /** Live accessors — preferred when the extension may replace manager/cwd after session_start. */
    getManager?: () => WorkflowManager;
    getCwd?: () => string;
    getStorage?: () => WorkflowStorage;
}): void;
