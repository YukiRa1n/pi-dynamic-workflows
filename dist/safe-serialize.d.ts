/**
 * Bounded, side-effect-free projections for values crossing a display/provider
 * boundary. This is deliberately separate from the native JSON path used by
 * persistence: projections may omit data, while durable state must not.
 */
export interface SerializationLimits {
    /** Maximum UTF-8 bytes emitted. Never unlimited. */
    maxBytes?: number;
    /** Maximum child values visited (array slots and object properties). */
    maxItems?: number;
    /** Maximum object/array nesting depth. */
    maxDepth?: number;
    /** Maximum UTF-8 bytes from any one string value. */
    maxStringBytes?: number;
    /** Maximum object/array nodes visited. */
    maxNodes?: number;
    /** Pretty-print object/array projections (the legacy safeStringify shape). */
    pretty?: boolean;
}
export declare const DEFAULT_SERIALIZATION_LIMITS: Readonly<{
    maxBytes: 256000;
    maxItems: 2000;
    maxDepth: 40;
    maxStringBytes: 32000;
    maxNodes: 10000;
    pretty: true;
}>;
/** UTF-8-safe prefix used by text surfaces that retain a character setting. */
export declare function truncateUtf8(text: string, maxBytes: number, marker?: string): string;
/**
 * Serialize for display/log/provider use. Traversal is iterative and stops
 * before descending past any finite limit. Property descriptors are inspected
 * instead of reading properties, so getters, toJSON methods, and conversion
 * hooks are never called. This function never throws.
 */
export declare function serializeBounded(value: unknown, options?: SerializationLimits): string;
/**
 * Deterministic, non-truncating encoding for identities and cache keys.
 * Unsupported values, accessors, cycles, and finite resource-limit overflow
 * fail closed instead of becoming display markers. Repeated non-cyclic values
 * are encoded by value so shared-reference DAGs hash like equivalent JSON.
 */
export declare function serializeIdentity(value: unknown, options?: SerializationLimits): string;
/** Backwards-compatible display helper. It is bounded; it is not a durable encoder. */
export declare function safeStringify(value: unknown, options?: SerializationLimits): string;
