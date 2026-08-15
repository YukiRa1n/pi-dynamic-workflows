/**
 * Never-throwing serialization for workflow results and delivery payloads.
 * Cycles, BigInt, and unsupported values are represented without allowing a
 * formatter failure to turn a successful workflow into a failed tool call.
 */
export function safeStringify(value) {
    const seen = new WeakSet();
    try {
        const json = JSON.stringify(value, (_key, current) => {
            if (typeof current === "bigint")
                return `${current}n`;
            if (typeof current === "function")
                return "[Function]";
            if (typeof current === "symbol")
                return "[Symbol]";
            if (current === undefined)
                return "[undefined]";
            if (current !== null && typeof current === "object") {
                if (seen.has(current))
                    return "[Circular]";
                seen.add(current);
            }
            return current;
        }, 2);
        return json ?? "null";
    }
    catch {
        return "[Unserializable workflow result]";
    }
}
