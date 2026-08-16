/** Session-local depth guidance for explicit workflow requests. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export type EffortLevel = "off" | "high" | "ultra";
export interface EffortState {
    level: EffortLevel;
}
export declare function createEffortState(): EffortState;
/** The extra directive appended to the forced-workflow prompt for an effort level. */
export declare function effortDirective(level: EffortLevel): string | undefined;
/** Backward-compatible utility for classifying non-trivial input. */
export declare function isSubstantive(text: string): boolean;
export declare function registerEffortCommand(pi: ExtensionAPI, state: EffortState): void;
