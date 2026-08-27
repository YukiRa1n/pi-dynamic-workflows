/** Explicit workflow command prompt rewrites and interactive UI preferences. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type WorkflowSettingsStore } from "./workflow-settings.js";
/** Legacy recognizer retained for embedders; the Pi extension does not lease tools from it. */
export declare function hasExplicitWorkflowControlRequest(text: string): boolean;
/** Legacy recognizer retained for embedders; explicit Pi steering uses /workflows steer. */
export declare function hasExplicitWorkflowSteerRequest(text: string): boolean;
/** Add the explicit `/workflows run` routing suffix. */
export declare function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string;
/**
 * Register the bottom progress-panel preference command:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export declare function registerWorkflowProgressCommands(pi: ExtensionAPI, settingsStore?: WorkflowSettingsStore): void;
