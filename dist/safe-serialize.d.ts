/**
 * Never-throwing serialization for workflow results and delivery payloads.
 * Cycles, BigInt, and unsupported values are represented without allowing a
 * formatter failure to turn a successful workflow into a failed tool call.
 */
export declare function safeStringify(value: unknown): string;
