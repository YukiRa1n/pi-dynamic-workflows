import { serializeBounded, truncateUtf8 } from "./safe-serialize.js";
/** Default provider-visible projection size for a workflow's semantic result. */
export const DEFAULT_WORKFLOW_RESULT_CHARS = 12_000;
/**
 * Build a bounded provider-visible projection of a workflow's semantic return
 * value. The complete value remains in the persisted run record. Strings are
 * the common final-report shape; structured returns are serialized
 * deterministically. Both the head and tail survive truncation so conclusions
 * and caveats at the end are not silently discarded.
 */
export function summarizeWorkflowResult(result, maxChars = DEFAULT_WORKFLOW_RESULT_CHARS) {
    const limit = Math.max(1, Math.floor(maxChars));
    let serialized;
    if (typeof result === "string") {
        serialized = result;
    }
    else if (result && typeof result === "object" && !Array.isArray(result)) {
        const record = result;
        // Inspect data descriptors only: a provider projection must not invoke a
        // getter/proxy conversion merely to find the preferred report field.
        let preferredKey;
        let artifact;
        try {
            for (const key of ["report", "synthesis", "summary", "answer"]) {
                const descriptor = Object.getOwnPropertyDescriptor(record, key);
                if (!descriptor || descriptor.get || descriptor.set || typeof descriptor.value !== "string")
                    continue;
                if (descriptor.value.trim()) {
                    preferredKey = key;
                    artifact = descriptor.value;
                    break;
                }
            }
        }
        catch {
            // The complete value remains durable; an inaccessible projection simply
            // falls back to the bounded descriptor traversal.
        }
        if (preferredKey && artifact !== undefined) {
            const metadata = Object.create(null);
            try {
                for (const key of Reflect.ownKeys(record)) {
                    if (typeof key !== "string" || key === preferredKey)
                        continue;
                    const descriptor = Object.getOwnPropertyDescriptor(record, key);
                    if (!descriptor)
                        metadata[key] = "[Unserializable node]";
                    else if (descriptor.get || descriptor.set)
                        metadata[key] = "[Accessor]";
                    else
                        metadata[key] = descriptor.value;
                }
            }
            catch {
                // Keep the artifact even when a proxy refuses metadata inspection.
            }
            serialized = `${artifact}\n\n[Workflow metadata]\n${serializeBounded(metadata, { maxBytes: limit + 512 })}`;
        }
        else {
            serialized = serializeBounded(result, { maxBytes: limit + 512 });
        }
    }
    else {
        serialized = serializeBounded(result, { maxBytes: limit + 512 });
    }
    if (Buffer.byteLength(serialized, "utf8") <= limit)
        return serialized;
    const marker = `\n\n[... middle omitted; final workflow result projected to ${limit} characters ...]\n\n`;
    if (limit <= marker.length)
        return truncateUtf8(marker, limit, "");
    const available = limit - Buffer.byteLength(marker, "utf8");
    const head = Math.ceil(available * 0.7);
    const tail = available - head;
    return `${truncateUtf8(serialized, head, "")}${marker}${truncateUtf8(serialized.slice(-tail), tail, "")}`;
}
