import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
/** Preserve prompt text while excluding credentials and opaque binary/reasoning blobs.
 * This is a diagnostic copy only; never return it to the provider pipeline. */
export declare function serializeRequestTrace(payload: unknown): {
    text: string;
    truncated: boolean;
};
export declare function requestTracePath(sessionId: string): string;
export declare function appendRequestTrace(path: string, record: unknown): void;
export declare function installWorkflowRequestTrace(pi: ExtensionAPI): void;
