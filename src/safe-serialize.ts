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

export const DEFAULT_SERIALIZATION_LIMITS = Object.freeze({
  maxBytes: 256_000,
  maxItems: 2_000,
  maxDepth: 40,
  maxStringBytes: 32_000,
  maxNodes: 10_000,
  pretty: true,
});

const IDENTITY_LIMITS = Object.freeze({
  maxBytes: 1_000_000,
  maxItems: 100_000,
  maxDepth: 128,
  maxStringBytes: 500_000,
  maxNodes: 50_000,
});

const OMITTED = "[... omitted ...]";
const CIRCULAR = "[Circular]";
const REPEATED = "[Repeated]";
const ACCESSOR = "[Accessor]";
const UNAVAILABLE = "[Unserializable node]";
const UNDEFINED = "[undefined]";
const NON_FINITE = "[Non-finite number]";
const BIGINT = "[BigInt]";
const FUNCTION = "[Function]";
const SYMBOL = "[Symbol]";

function finiteLimit(value: unknown, fallback: number, hardMax: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(hardMax, Math.floor(value))
    : fallback;
}

function limitsFor(options: SerializationLimits): Required<SerializationLimits> {
  return {
    maxBytes: finiteLimit(options.maxBytes, DEFAULT_SERIALIZATION_LIMITS.maxBytes, 16_000_000),
    maxItems: finiteLimit(options.maxItems, DEFAULT_SERIALIZATION_LIMITS.maxItems, 100_000),
    maxDepth: finiteLimit(options.maxDepth, DEFAULT_SERIALIZATION_LIMITS.maxDepth, 512),
    maxStringBytes: finiteLimit(options.maxStringBytes, DEFAULT_SERIALIZATION_LIMITS.maxStringBytes, 1_000_000),
    maxNodes: finiteLimit(options.maxNodes, DEFAULT_SERIALIZATION_LIMITS.maxNodes, 100_000),
    pretty: options.pretty ?? DEFAULT_SERIALIZATION_LIMITS.pretty,
  };
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** UTF-8-safe prefix used by text surfaces that retain a character setting. */
export function truncateUtf8(text: string, maxBytes: number, marker = "…"): string {
  const limit =
    typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes >= 0
      ? Math.min(16_000_000, Math.floor(maxBytes))
      : 1;
  if (byteLength(text) <= limit) return text;
  const markerBytes = byteLength(marker);
  if (markerBytes >= limit) return prefixUtf8(marker, limit);
  return `${prefixUtf8(text, limit - markerBytes)}${marker}`;
}

function prefixUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const bytes = byteLength(ch);
    if (used + bytes > maxBytes) break;
    used += bytes;
    end += ch.length;
  }
  return text.slice(0, end);
}

class ByteWriter {
  readonly chunks: string[] = [];
  used = 0;
  exhausted = false;

  constructor(readonly maxBytes: number) {}

  exact(text: string): boolean {
    if (this.exhausted) return false;
    const bytes = byteLength(text);
    if (this.used + bytes > this.maxBytes) {
      this.exhausted = true;
      return false;
    }
    this.chunks.push(text);
    this.used += bytes;
    return true;
  }

  text(text: string): void {
    if (this.exhausted || !text) return;
    const remaining = this.maxBytes - this.used;
    if (remaining <= 0) {
      this.exhausted = true;
      return;
    }
    const prefix = prefixUtf8(text, remaining);
    if (prefix.length !== text.length) this.exhausted = true;
    if (prefix) {
      this.chunks.push(prefix);
      this.used += byteLength(prefix);
    }
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function quoteString(value: string, maxSourceBytes: number, writer: ByteWriter): void {
  if (!writer.exact('"')) return;
  let sourceBytes = 0;
  let truncated = false;
  for (const ch of value) {
    const chBytes = byteLength(ch);
    if (sourceBytes + chBytes > maxSourceBytes) {
      truncated = true;
      break;
    }
    sourceBytes += chBytes;
    let encoded: string;
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') encoded = '\\"';
    else if (ch === "\\") encoded = "\\\\";
    else if (code < 0x20) encoded = `\\u${code.toString(16).padStart(4, "0")}`;
    else encoded = ch;
    if (!writer.exact(encoded)) {
      truncated = true;
      break;
    }
  }
  if (truncated) {
    // The marker is intentionally plain ASCII so it remains deterministic and
    // can be emitted without converting the hostile value to a string.
    writer.exact("… [truncated]");
  }
  writer.exact('"');
}

function appendMarker(writer: ByteWriter, marker: string): void {
  quoteString(marker, byteLength(marker), writer);
}

function encodedStringBytes(value: string, maxSourceBytes: number): number {
  let sourceBytes = 0;
  let outputBytes = 2; // surrounding quotes
  for (const ch of value) {
    const chBytes = byteLength(ch);
    if (sourceBytes + chBytes > maxSourceBytes) return -1;
    sourceBytes += chBytes;
    const code = ch.codePointAt(0) ?? 0;
    outputBytes += byteLength(
      ch === '"' ? '\\"' : ch === "\\" ? "\\\\" : code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch,
    );
  }
  return outputBytes;
}

type ProjectionTask =
  | { kind: "value"; value: unknown; depth: number }
  | { kind: "property"; owner: object; key: string; depth: number }
  | { kind: "array"; owner: object; index: number; depth: number }
  | { kind: "text"; value: string }
  | { kind: "close"; value: string; owner: object };

function indent(depth: number): string {
  return "  ".repeat(depth);
}

function safeOwnKeys(value: object): (string | symbol)[] | null {
  try {
    return Reflect.ownKeys(value);
  } catch {
    return null;
  }
}

function safeDescriptor(value: object, key: string | symbol): PropertyDescriptor | null {
  try {
    return Object.getOwnPropertyDescriptor(value, key) ?? null;
  } catch {
    return null;
  }
}

function isArray(value: object): boolean {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function primitiveProjection(value: unknown, writer: ByteWriter, limits: Required<SerializationLimits>): boolean {
  if (value === null) {
    return writer.exact("null");
  }
  switch (typeof value) {
    case "string":
      quoteString(value, limits.maxStringBytes, writer);
      return true;
    case "boolean":
      return writer.exact(value ? "true" : "false");
    case "number":
      return Number.isFinite(value)
        ? writer.exact(Object.is(value, -0) ? "-0" : String(value))
        : (appendMarker(writer, NON_FINITE), true);
    case "undefined":
      appendMarker(writer, UNDEFINED);
      return true;
    case "bigint":
      appendMarker(writer, BIGINT);
      return true;
    case "function":
      appendMarker(writer, FUNCTION);
      return true;
    case "symbol":
      appendMarker(writer, SYMBOL);
      return true;
    default:
      return false;
  }
}

/**
 * Serialize for display/log/provider use. Traversal is iterative and stops
 * before descending past any finite limit. Property descriptors are inspected
 * instead of reading properties, so getters, toJSON methods, and conversion
 * hooks are never called. This function never throws.
 */
export function serializeBounded(value: unknown, options: SerializationLimits = {}): string {
  const limits = limitsFor(options);
  const writer = new ByteWriter(limits.maxBytes);
  const stack: ProjectionTask[] = [{ kind: "value", value, depth: 0 }];
  const seen = new WeakSet<object>();
  const active = new WeakSet<object>();
  let items = 0;
  let nodes = 0;

  try {
    while (stack.length && !writer.exhausted) {
      const task = stack.pop()!;
      if (task.kind === "text") {
        writer.exact(task.value);
        continue;
      }
      if (task.kind === "close") {
        writer.exact(task.value);
        active.delete(task.owner);
        continue;
      }
      if (task.kind === "property" || task.kind === "array") {
        if (task.kind === "property") {
          quoteString(task.key, limits.maxStringBytes, writer);
          writer.exact(limits.pretty ? ": " : ":");
          const descriptor = safeDescriptor(task.owner, task.key);
          if (!descriptor) appendMarker(writer, UNAVAILABLE);
          else if (descriptor.get || descriptor.set) appendMarker(writer, ACCESSOR);
          else stack.push({ kind: "value", value: descriptor.value, depth: task.depth });
        } else {
          const descriptor = safeDescriptor(task.owner, String(task.index));
          if (!descriptor) writer.exact("null");
          else if (descriptor.get || descriptor.set) appendMarker(writer, ACCESSOR);
          else stack.push({ kind: "value", value: descriptor.value, depth: task.depth });
        }
        continue;
      }

      const current = task.value;
      if (primitiveProjection(current, writer, limits)) continue;
      if (!current || (typeof current !== "object" && typeof current !== "function")) {
        appendMarker(writer, UNAVAILABLE);
        continue;
      }
      if (active.has(current)) {
        appendMarker(writer, CIRCULAR);
        continue;
      }
      if (seen.has(current)) {
        appendMarker(writer, REPEATED);
        continue;
      }
      if (task.depth >= limits.maxDepth || nodes >= limits.maxNodes) {
        appendMarker(writer, OMITTED);
        continue;
      }
      seen.add(current);
      active.add(current);
      nodes++;

      let array = false;
      try {
        array = isArray(current);
      } catch {
        appendMarker(writer, UNAVAILABLE);
        active.delete(current);
        continue;
      }
      if (array) {
        const lengthDescriptor = safeDescriptor(current, "length");
        const length = lengthDescriptor && typeof lengthDescriptor.value === "number" ? lengthDescriptor.value : 0;
        const count = Math.min(Math.max(0, Math.floor(length)), Math.max(0, limits.maxItems - items));
        const omitted = count < length;
        writer.exact("[");
        const child: ProjectionTask[] = [];
        for (let i = 0; i < count; i++) {
          if (i > 0) child.push({ kind: "text", value: limits.pretty ? ",\n" : "," });
          if (limits.pretty) child.push({ kind: "text", value: indent(task.depth + 1) });
          items++;
          child.push({ kind: "array", owner: current, index: i, depth: task.depth + 1 });
        }
        if (count > 0 && limits.pretty) child.unshift({ kind: "text", value: "\n" });
        if (omitted) {
          if (count > 0) child.push({ kind: "text", value: limits.pretty ? ",\n" : "," });
          if (limits.pretty) child.push({ kind: "text", value: indent(task.depth + 1) });
          child.push({ kind: "value", value: OMITTED, depth: task.depth + 1 });
        }
        if (omitted || count > 0) child.push({ kind: "text", value: limits.pretty ? `\n${indent(task.depth)}` : "" });
        stack.push({ kind: "close", value: "]", owner: current });
        for (let i = child.length - 1; i >= 0; i--) stack.push(child[i]);
        continue;
      }

      const keys = safeOwnKeys(current);
      if (!keys) {
        appendMarker(writer, UNAVAILABLE);
        active.delete(current);
        continue;
      }
      const names = keys
        .filter((key): key is string => typeof key === "string")
        .slice(0, Math.max(0, limits.maxItems - items));
      const omitted = keys.filter((key) => typeof key === "string").length > names.length;
      writer.exact("{");
      const child: ProjectionTask[] = [];
      for (let i = 0; i < names.length; i++) {
        if (i > 0) child.push({ kind: "text", value: limits.pretty ? ",\n" : "," });
        if (limits.pretty) child.push({ kind: "text", value: indent(task.depth + 1) });
        items++;
        child.push({ kind: "property", owner: current, key: names[i], depth: task.depth + 1 });
      }
      if (names.length > 0 && limits.pretty) child.unshift({ kind: "text", value: "\n" });
      if (omitted) {
        if (names.length > 0) child.push({ kind: "text", value: limits.pretty ? ",\n" : "," });
        if (limits.pretty) child.push({ kind: "text", value: indent(task.depth + 1) });
        child.push({ kind: "value", value: OMITTED, depth: task.depth + 1 });
      }
      if (omitted || names.length > 0)
        child.push({ kind: "text", value: limits.pretty ? `\n${indent(task.depth)}` : "" });
      stack.push({ kind: "close", value: "}", owner: current });
      for (let i = child.length - 1; i >= 0; i--) stack.push(child[i]);
    }
  } catch {
    // A revoked proxy can fail even while handling a descriptor/WeakSet. The
    // projection contract is never-throwing; retain the prefix already emitted.
    if (!writer.exhausted) appendMarker(writer, UNAVAILABLE);
  }
  return writer.toString();
}

function identityError(reason: string): never {
  throw new TypeError(`Identity serialization rejected: ${reason}`);
}

type IdentityTask =
  | { kind: "value"; value: unknown; depth: number }
  | { kind: "property"; owner: object; key: string; depth: number }
  | { kind: "array"; owner: object; index: number; depth: number }
  | { kind: "text"; value: string }
  | { kind: "close"; owner: object; value: string };

/**
 * Deterministic, non-truncating encoding for identities and cache keys.
 * Unsupported values, accessors, cycles, and finite resource-limit overflow
 * fail closed instead of becoming display markers. Repeated non-cyclic values
 * are encoded by value so shared-reference DAGs hash like equivalent JSON.
 */
export function serializeIdentity(value: unknown, options: SerializationLimits = {}): string {
  const limits = {
    maxBytes: finiteLimit(options.maxBytes, IDENTITY_LIMITS.maxBytes, 16_000_000),
    maxItems: finiteLimit(options.maxItems, IDENTITY_LIMITS.maxItems, 1_000_000),
    maxDepth: finiteLimit(options.maxDepth, IDENTITY_LIMITS.maxDepth, 512),
    maxStringBytes: finiteLimit(options.maxStringBytes, IDENTITY_LIMITS.maxStringBytes, 4_000_000),
    maxNodes: finiteLimit(options.maxNodes, IDENTITY_LIMITS.maxNodes, 500_000),
  };
  const writer = new ByteWriter(limits.maxBytes);
  const stack: IdentityTask[] = [{ kind: "value", value, depth: 0 }];
  const active = new WeakSet<object>();
  let items = 0;
  let nodes = 0;

  const identityString = (text: string): void => {
    const encodedBytes = encodedStringBytes(text, limits.maxStringBytes);
    if (encodedBytes < 0 || writer.used + encodedBytes > limits.maxBytes) identityError("string overflow");
    quoteString(text, limits.maxStringBytes, writer);
    if (writer.exhausted) identityError("string overflow");
  };

  while (stack.length) {
    const task = stack.pop()!;
    if (task.kind === "text") {
      if (!writer.exact(task.value)) identityError("byte limit exceeded");
      continue;
    }
    if (task.kind === "close") {
      if (!writer.exact(task.value)) identityError("byte limit exceeded");
      active.delete(task.owner);
      continue;
    }
    if (task.kind === "property" || task.kind === "array") {
      if (task.kind === "property") {
        identityString(task.key);
        if (!writer.exact(":")) identityError("byte limit exceeded");
        const descriptor = safeDescriptor(task.owner, task.key);
        if (!descriptor) identityError("missing property");
        if (descriptor.get || descriptor.set) identityError("accessor");
        stack.push({ kind: "value", value: descriptor.value, depth: task.depth });
      } else {
        const descriptor = safeDescriptor(task.owner, String(task.index));
        if (!descriptor) identityError("array hole");
        if (descriptor.get || descriptor.set) identityError("accessor");
        stack.push({ kind: "value", value: descriptor.value, depth: task.depth });
      }
      continue;
    }

    const current = task.value;
    if (current === null) {
      if (!writer.exact("null")) identityError("byte limit exceeded");
      continue;
    }
    switch (typeof current) {
      case "string":
        identityString(current);
        continue;
      case "boolean":
        if (!writer.exact(current ? "true" : "false")) identityError("byte limit exceeded");
        continue;
      case "number":
        if (!Number.isFinite(current)) identityError("non-finite number");
        if (!writer.exact(Object.is(current, -0) ? "-0" : String(current))) identityError("byte limit exceeded");
        continue;
      case "undefined":
        return identityError("undefined");
      case "bigint":
        return identityError("bigint");
      case "function":
        return identityError("function");
      case "symbol":
        return identityError("symbol");
    }
    if (typeof current !== "object") identityError("unsupported value");
    if (active.has(current)) identityError("cycle");
    if (task.depth >= limits.maxDepth) identityError("depth limit exceeded");
    if (nodes++ >= limits.maxNodes) identityError("node limit exceeded");
    active.add(current);

    let array = false;
    try {
      array = Array.isArray(current);
    } catch {
      identityError("unavailable proxy");
    }
    if (array) {
      const lengthDescriptor = safeDescriptor(current, "length");
      const length = lengthDescriptor?.value;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length > limits.maxItems)
        identityError("array limit exceeded");
      const keys = safeOwnKeys(current);
      if (
        !keys ||
        keys.some(
          (key) => typeof key === "symbol" || (typeof key === "string" && key !== "length" && !/^\d+$/.test(key)),
        )
      ) {
        identityError("unsupported array property");
      }
      if (!writer.exact("[")) identityError("byte limit exceeded");
      const child: IdentityTask[] = [];
      for (let i = 0; i < length; i++) {
        if (i > 0) child.push({ kind: "text", value: "," });
        items++;
        if (items > limits.maxItems) identityError("item limit exceeded");
        child.push({ kind: "array", owner: current, index: i, depth: task.depth + 1 });
      }
      stack.push({ kind: "close", owner: current, value: "]" });
      for (let i = child.length - 1; i >= 0; i--) stack.push(child[i]);
      continue;
    }

    let proto: object | null;
    try {
      proto = Object.getPrototypeOf(current);
    } catch {
      identityError("unavailable proxy");
    }
    if (proto !== null && proto !== Object.prototype) {
      // Values created in the workflow VM have a different realm's
      // Object.prototype. Accept that exact cross-realm plain-object shape,
      // while still rejecting class instances and host objects.
      const objectConstructor = safeDescriptor(proto, "constructor")?.value;
      if (typeof objectConstructor !== "function" || objectConstructor.name !== "Object")
        identityError("unsupported object prototype");
    }
    const keys = safeOwnKeys(current);
    if (!keys || keys.some((key) => typeof key !== "string")) identityError("symbol key");
    const names = (keys as string[]).sort();
    if (items + names.length > limits.maxItems) identityError("item limit exceeded");
    if (!writer.exact("{")) identityError("byte limit exceeded");
    const child: IdentityTask[] = [];
    for (let i = 0; i < names.length; i++) {
      if (i > 0) child.push({ kind: "text", value: "," });
      items++;
      child.push({ kind: "property", owner: current, key: names[i], depth: task.depth + 1 });
    }
    stack.push({ kind: "close", owner: current, value: "}" });
    for (let i = child.length - 1; i >= 0; i--) stack.push(child[i]);
  }
  return writer.toString();
}

/** Backwards-compatible display helper. It is bounded; it is not a durable encoder. */
export function safeStringify(value: unknown, options: SerializationLimits = {}): string {
  return serializeBounded(value, options);
}
