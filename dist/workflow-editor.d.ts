/**
 * "Workflows mode" keyword trigger: while the submitted message contains the
 * bounded word `workflow`/`workflows` (or a configured custom trigger word),
 * the message is transformed at submit time to instruct Pi to actually run the
 * workflow tool. Detection is purely textual (`event.text` on the `input`
 * hook) — it does not depend on, or own, the host's editor component.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type EffortState } from "./effort-command.js";
import { type WorkflowSettingsStore } from "./workflow-settings.js";
export declare function hasTrigger(text: string, triggerWord?: string): boolean;
/**
 * Provider-facing arming is stricter than lexical highlighting. A configured
 * custom word remains an explicit opt-in, while the default word ignores common
 * discussion/debugging phrases and recognizes compact CJK requests such as
 * "用workflow审查" that Unicode token boundaries otherwise reject.
 */
export declare function hasWorkflowRequestTrigger(text: string, triggerWord?: string): boolean;
export declare function endsWithTrigger(textBeforeCursor: string, triggerWord?: string): boolean;
/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
    active: boolean;
    keywordTriggerEnabled: boolean;
    keywordTriggerWord?: string;
    suppressedKeywordText?: string;
}
export interface InstallWorkflowKeywordArmingOptions {
    settingsStore?: WorkflowSettingsStore;
    /** @deprecated Tool visibility is stable; retained for source compatibility. */
    controlToolName?: string;
    /** @deprecated Tool visibility is stable; retained for source compatibility. */
    steerToolName?: string;
    /** @deprecated Tool visibility is stable; retained for source compatibility. */
    workflowToolFamily?: readonly string[];
}
/** Legacy recognizer retained for embedders; the Pi extension does not lease tools from it. */
export declare function hasExplicitWorkflowControlRequest(text: string): boolean;
/** Legacy recognizer retained for embedders; explicit Pi steering uses /workflows steer. */
export declare function hasExplicitWorkflowSteerRequest(text: string): boolean;
/** Backward-compatible arming reason type; the compact suffix no longer narrates it. */
export type ArmReason = "keyword" | "effort";
/** Add a minimal user-message suffix after an explicit workflow request. */
export declare function buildArmedWorkflowPrompt(text: string, opts?: {
    reason?: ArmReason;
    extraDirective?: string;
}): string;
/** Add the explicit `/workflows run` routing suffix. */
export declare function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string;
/** The exact name of the workflow tool that workflows mode forces. */
export declare const WORKFLOW_TOOL_NAME = "start_workflow";
export declare function registerWorkflowTriggerCommand(pi: ExtensionAPI, state: WorkflowModeState, settingsStore?: WorkflowSettingsStore): void;
/**
 * Register the bottom progress-panel preference command:
 *  - `/workflows-progress compact|detailed|status` — switch (or report) the panel mode.
 *  - `/workflows-progress max <1-1000>` — cap agents shown per phase in detailed mode.
 * Both persist via `settingsStore` and take effect on the next live run (the panel
 * live-reads its settings), so no session restart is needed.
 */
export declare function registerWorkflowProgressCommands(pi: ExtensionAPI, settingsStore?: WorkflowSettingsStore): void;
/**
 * Install the keyword-trigger arming hook (submit-time detection + prompt
 * rewrite) and the related trigger/progress commands. Call once (e.g. in
 * `session_start`).
 */
export declare function installWorkflowKeywordArming(pi: ExtensionAPI, effort?: EffortState, options?: InstallWorkflowKeywordArmingOptions): WorkflowModeState;
