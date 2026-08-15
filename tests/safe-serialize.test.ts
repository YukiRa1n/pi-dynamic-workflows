import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeStringify, serializeBounded, serializeIdentity } from "../src/safe-serialize.js";

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

describe("bounded serialization", () => {
  it("stops giant arrays during traversal rather than stringifying the tail", () => {
    let reads = 0;
    const value = Array.from({ length: 100_000 }, (_, index) => index);
    Object.defineProperty(value, "10", {
      configurable: true,
      get() {
        reads++;
        return 10;
      },
    });
    const output = serializeBounded(value, { maxItems: 3, maxBytes: 200 });
    assert.ok(output.includes("omitted"));
    assert.ok(reads <= 1, `only the bounded prefix may be inspected (reads=${reads})`);
    assert.ok(bytes(output) <= 200);
  });

  it("counts UTF-8 bytes and truncates strings without splitting a code point", () => {
    const output = serializeBounded("😀😀😀😀", { maxBytes: 13, maxStringBytes: 100, pretty: false });
    assert.ok(bytes(output) <= 13);
    assert.doesNotThrow(() => [...output]);
  });

  it("does not invoke getters, toJSON, or conversion methods", () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const value = {
      get secret() {
        getterCalls++;
        throw new Error("must not run");
      },
      toJSON() {
        toJsonCalls++;
        throw new Error("must not run");
      },
      okay: 1,
    };
    const output = serializeBounded(value);
    assert.equal(getterCalls, 0);
    assert.equal(toJsonCalls, 0);
    assert.match(output, /Accessor/);
    assert.match(output, /okay/);
  });

  it("is deterministic and never throws for cycles, repeated references, and revoked proxies", () => {
    const child = { answer: 42 };
    const value: Record<string, unknown> = { first: child, second: child };
    value.cycle = value;
    const first = serializeBounded(value);
    assert.equal(first, serializeBounded(value));
    assert.match(first, /Repeated/);
    assert.match(first, /Circular/);

    const target = { x: 1 };
    const proxy = Proxy.revocable(target, {});
    proxy.revoke();
    assert.doesNotThrow(() => serializeBounded(proxy.proxy));
  });

  it("bounds depth, items, non-finite values, bigint, undefined, and symbols", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 100; i++) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const output = safeStringify({
      deep,
      nan: Number.NaN,
      infinity: Infinity,
      bigint: 3n,
      missing: undefined,
      fn: () => 1,
    });
    assert.match(output, /Non-finite/);
    assert.match(output, /BigInt/);
    assert.match(output, /undefined/);
    assert.match(output, /Function/);
    assert.match(output, /omitted/);
    assert.ok(bytes(output) <= 256_000);
  });
});

describe("identity serialization", () => {
  it("is canonical and changes when any identity field changes", () => {
    const a = serializeIdentity({ b: 2, a: ["x", true] });
    const b = serializeIdentity({ a: ["x", true], b: 2 });
    const c = serializeIdentity({ a: ["x", false], b: 2 });
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("rejects overflow and unsupported identity values instead of truncating", () => {
    assert.throws(() => serializeIdentity({ value: "x".repeat(100) }, { maxBytes: 20 }), /rejected/);
    assert.throws(() => serializeIdentity({ value: 1n }), /bigint/);
    assert.throws(() => serializeIdentity({ value: Number.NaN }), /non-finite/);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => serializeIdentity(cyclic), /cycle/);
  });
});
