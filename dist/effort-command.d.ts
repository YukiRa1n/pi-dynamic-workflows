/**
 * Standing `/effort` opt-in (pi's answer to CC's ultracode): a session toggle that
 * auto-arms a workflow for substantive interactive messages, with effort-tier
 * guidance nudging fan-out breadth and the maxAgents ceiling the model should set
 * on the workflow tool call.
 *
 * Honest scope: the runtime cannot enforce "reviewer N / loop K" — those live in
 * the script the model writes — so the tiers are guidance plus the model setting
 * maxAgents to match the planned fan-out. Token budgets remain opt-in spend gates
 * governed by the workflow tool schema; an effort level does not imply one. The
 * pre-flight ceiling-confirm dialog (roadmap P1-5 #4) is a downscope point: an
 * `input` hook transforms synchronously and can't await a confirm, so it is left
 * to a follow-up; `/effort` is explicit opt-in, which is the safety valve.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export type EffortLevel = "off" | "high" | "ultra";
export interface EffortState {
    level: EffortLevel;
}
export declare function createEffortState(): EffortState;
/** The extra directive appended to the forced-workflow prompt for an effort level. */
export declare function effortDirective(level: EffortLevel): string | undefined;
/**
 * Whether a message should auto-arm under effort mode: a real interactive request,
 * not a terse acknowledgement or a slash command. (hasTrigger handles the explicit
 * "workflow(s)" keyword separately.)
 */
export declare function isSubstantive(text: string): boolean;
export declare function registerEffortCommand(pi: ExtensionAPI, state: EffortState): void;
