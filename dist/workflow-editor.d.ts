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
export declare function hasTrigger(text: string, triggerWord?: any): boolean;
export declare function endsWithTrigger(textBeforeCursor: string, triggerWord?: any): boolean;
/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
    active: boolean;
    keywordTriggerEnabled: boolean;
    keywordTriggerWord?: string;
    suppressedKeywordText?: string;
}
export interface InstallWorkflowKeywordArmingOptions {
    settingsStore?: WorkflowSettingsStore;
}
/**
 * Why a turn was armed. This is stated truthfully in the banner so the model
 * isn't told "the trigger word you typed" on a path where no word was typed:
 *  - "keyword": the user typed the configured workflow trigger word.
 *  - "effort": standing `/effort` armed this turn (no workflow word was typed).
 */
export type ArmReason = "keyword" | "effort";
/**
 * Appended to the effort-path directive: standing `/effort` arms on every
 * substantive message, so the model must be told it can decline the workflow on
 * a conversational or trivial turn (mirrors "solo only on conversational turns").
 */
export declare const EFFORT_CONVERSATIONAL_ESCAPE = "This turn was armed by standing effort mode, not by an explicit workflow request: if it is conversational or trivial, skip the workflow and just respond directly.";
/**
 * The directive appended to a submitted message when workflows mode is ARMED by a
 * HEURISTIC path — the keyword trigger or standing `/effort`. (The explicit
 * `/workflows run` command uses {@link buildForcedWorkflowPrompt} instead.)
 *
 * This authorizes — it does not force. Arming is a confirmed opt-in signal that
 * lifts the always-on "do not call the tool" gate for THIS message; the model
 * still decides whether the message is actually a request to do work (→ call the
 * `workflow` tool) or just talk about workflows (→ answer directly). The old
 * "You MUST / the ONLY acceptable action / Do NOT answer directly" forcing text
 * caused two bugs: it over-triggered on messages that merely mention workflows
 * (#88), and — by commanding the model to emit nothing but one `workflow` call
 * and not talk — it produced a bare background run that ends the turn and leaves
 * the user at an idle prompt (#89).
 *
 * The banner therefore (1) LEADS with the decision boundary (question/trivial →
 * answer directly; a real decomposable request → call `workflow`) rather than
 * leading with "call the tool"; (2) states the truthful opt-in `reason` for THIS
 * path (no "the word you typed" on the effort path, where none was); and (3)
 * carries the #89 background/deliver-back reassurance so an ending turn reads as
 * expected. The how-to mechanics are NOT here — they live in the tool's static
 * `description` (see createWorkflowTool), visible whenever the model looks at the
 * tool, so they aren't re-injected per armed turn (#65).
 *
 * `extraDirective` (e.g. an effort-tier nudge + EFFORT_CONVERSATIONAL_ESCAPE) is
 * appended when present.
 */
export declare function buildArmedWorkflowPrompt(text: string, opts?: {
    reason?: ArmReason;
    extraDirective?: string;
}): string;
/**
 * The directive for the explicit `/workflows run <prompt>` command. Unlike the
 * heuristic {@link buildArmedWorkflowPrompt}, `/workflows run` is a maximal-intent
 * command — the user typed a command whose whole purpose is to execute a workflow
 * now — so it does NOT get the "if it's a question, just answer" escape. It still
 * avoids the old MUST/ONLY forcing language (which caused #88/#89) and still
 * carries the #89 background/deliver-back reassurance so an ending turn reads as
 * expected. `extraDirective` (e.g. a standing effort-tier nudge) is appended.
 */
export declare function buildForcedWorkflowPrompt(text: string, extraDirective?: string): string;
/** The exact name of the workflow tool that workflows mode forces. */
export declare const WORKFLOW_TOOL_NAME = "workflow";
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
