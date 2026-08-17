import assert from "node:assert/strict";
import test from "node:test";
import { auditWorkflowScript, decideWorkflowScriptGate } from "../src/workflow-script-gate.js";

const META = `export const meta = { name: "demo", description: "d" }`;

/** Assert a script is rejected, and that some violation matches the rule. */
function assertBlocked(script: string, rule: string) {
  const violations = auditWorkflowScript(script);
  assert.ok(violations.length > 0, `expected violations for: ${script}`);
  assert.ok(
    violations.some((v) => v.rule === rule),
    `expected rule "${rule}" in ${JSON.stringify(violations)} for: ${script}`,
  );
}

function assertAllowed(script: string) {
  const violations = auditWorkflowScript(script);
  assert.deepEqual(violations, [], `expected clean audit for: ${script}`);
}

// ─── gate decision shape ──────────────────────────────────────────────────────

test("no custom script (preset / name invocation) is never gated", () => {
  assert.deepEqual(decideWorkflowScriptGate(undefined), { action: "allow", via: "not-required" });
  assert.deepEqual(decideWorkflowScriptGate("   \n "), { action: "allow", via: "not-required" });
});

test("clean orchestration script passes the audit", () => {
  const decision = decideWorkflowScriptGate(`${META}
const items = ["a", "b", "c"];
const results = await parallel(items.map((item, i) => () =>
  agent(\`review \${item}\`, { label: \`r-\${i}\` })
));
log("done");
return results;`);
  assert.deepEqual(decision, { action: "allow", via: "static-audit" });
});

test("rejected script returns a block decision with reason and violations", () => {
  const decision = decideWorkflowScriptGate(`${META}\nconst k = "x"; return args[k];`);
  assert.equal(decision.action, "block");
  if (decision.action === "block") {
    assert.match(decision.reason, /static audit/);
    assert.match(decision.reason, /preset/);
    assert.ok(decision.violations.some((v) => v.rule === "computed-member-access"));
  }
});

test("unparseable script is a parse-error violation, not a throw", () => {
  const violations = auditWorkflowScript("const = ");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "parse-error");
});

// ─── attack vectors must be blocked ───────────────────────────────────────────

test("prototype escape via .constructor on a bridge function is blocked", () => {
  // The classic: agent.constructor("return process")() — `constructor` member
  // access is legal syntax, but this exact escape needs the prelude's runtime
  // patch; the audit blocks the *generic* forms below.
  assertBlocked(`${META}\nconst F = agent["constructor"];`, "computed-member-access");
});

test("string-keyed reflection routes are all blocked", () => {
  assertBlocked(`${META}\nconst k = "construc" + "tor"; return agent[k];`, "computed-member-access");
  assertBlocked(`${META}\nfor (const k in agent) { log(k); }`, "for-in");
  assertBlocked(`${META}\nconst o = { ["x"]: 1 };`, "computed-property-key");
  assertBlocked(`${META}\nconst { ["x"]: y } = {};`, "computed-property-key");
});

test("__proto__ in every position is blocked", () => {
  assertBlocked(`${META}\nreturn ({}).__proto__;`, "dangerous-member");
  assertBlocked(`${META}\nconst o = { __proto__: null };`, "proto-key");
  assertBlocked(`${META}\nconst o = { "__proto__": null };`, "proto-key");
});

test("literal constructor / prototype member access is blocked", () => {
  // The runtime prelude patches .constructor on injected globals; the audit
  // rejects the literal form so a missed runtime patch is not exploitable.
  assertBlocked(`${META}\nreturn agent.constructor;`, "dangerous-member");
  assertBlocked(`${META}\nreturn Object.getPrototypeOf;`, "object-reflection");
  assertBlocked(`${META}\nreturn SomeClass.prototype;`, "unknown-global");
  assertBlocked(`${META}\nconst o = {}; return o.constructor;`, "dangerous-member");
});

test("dynamic code execution is blocked", () => {
  assertBlocked(`${META}\nreturn eval("1+1");`, "eval");
  assertBlocked(`${META}\nreturn Function("return 1")();`, "function-constructor");
  assertBlocked(`${META}\nreturn new Function("return 1")();`, "function-constructor");
  assertBlocked(`${META}\nreturn new GeneratorFunction("yield 1")();`, "function-constructor");
  assertBlocked(`${META}\nreturn new AsyncFunction("return 1")();`, "function-constructor");
});

test("module system and scope-escaping syntax are blocked", () => {
  assertBlocked(`${META}\nimport fs from "node:fs";`, "import-declaration");
  assertBlocked(`${META}\nconst m = await import("node:fs");`, "dynamic-import");
  assertBlocked(`${META}\nexport * from "x";`, "export-all");
  // `with` is a strict-mode parse error under sourceType:module — still
  // blocked, one layer earlier (parse-error), which is the guarantee that
  // matters.
  assertBlocked(`${META}\nwith (Math) { return floor(1.5); }`, "parse-error");
});

test("host-reachable globals are not in the whitelist", () => {
  assertBlocked(`${META}\nreturn fetch("https://example.com");`, "unknown-global");
  assertBlocked(`${META}\nreturn require("node:fs");`, "unknown-global");
  assertBlocked(`${META}\nreturn setTimeout(() => {}, 1);`, "unknown-global");
  assertBlocked(`${META}\nreturn Buffer.from("x");`, "unknown-global");
  // Function referenced as a value (not just called) is also not whitelisted.
  assertBlocked(`${META}\nreturn Function;`, "unknown-global");
});

test("bridge globals cannot be shadowed by local bindings", () => {
  assertBlocked(`${META}\nconst agent = () => null;`, "shadowed-bridge-global");
  assertBlocked(`${META}\nfunction parallel() {}`, "shadowed-bridge-global");
  assertBlocked(`${META}\nconst { log } = {};`, "shadowed-bridge-global");
});

// ─── legitimate orchestration must pass ───────────────────────────────────────

test("locals, closures, classes, and safe built-ins pass", () => {
  assertAllowed(`${META}
const helper = (xs) => xs.map((x) => x * 2);
class Acc { constructor() { this.total = 0; } add(n) { this.total += n; return this; } }
const acc = new Acc();
for (const n of helper([1, 2, 3])) { acc.add(n); }
log(\`total=\${acc.total}\`);
const payload = JSON.stringify({ total: acc.total });
return { total: acc.total, size: payload.length, keys: Object.keys({ a: 1 }) };`);
});

test("all injected workflow globals pass", () => {
  assertAllowed(`${META}
phase("p1");
log(cwd);
log(String(budget.remaining()));
console.log(typeof args);
process.cwd();
const r = await retry(() => agent("t", { label: "x" }), { retries: 1 });
await gate("g", () => true);
checkpoint("c");
deliver("d");
return r;`);
});

test("promise composition and error handling pass", () => {
  assertAllowed(`${META}
try {
  const settled = await Promise.allSettled([agent("a"), agent("b")]);
  return settled.filter((s) => s.status === "fulfilled").map((s) => s.value);
} catch (err) {
  if (err instanceof Error) throw new TypeError(err.message);
  throw err;
}`);
});

test("Date with explicit args and Math minus random() pass", () => {
  // DETERMINISM_PRELUDE + the runner's findNondeterminism own Date.now()/
  // Math.random(); the audit only owns structural safety.
  assertAllowed(`${META}
const d = new Date("2026-01-01T00:00:00Z");
return { year: d.getUTCFullYear(), floor: Math.floor(1.9), max: Math.max(1, 2) };`);
});

test("non-computed member access and property definitions pass", () => {
  assertAllowed(`${META}
const o = { alpha: 1, beta: { gamma: 2 } };
o.alpha = o.beta.gamma + 1;
return o?.alpha ?? 0;`);
});

test("locally declared arrays pass with for-of (for-in is the blocked form)", () => {
  assertAllowed(`${META}
const xs = [1, 2, 3];
let sum = 0;
for (const x of xs) sum += x;
return sum;`);
});

// ─── reference-position classification ────────────────────────────────────────

test("property names, labels, and binding positions are not unknown-globals", () => {
  assertAllowed(`${META}
const o = { customName: 1 };
outer: for (const x of [1]) { break outer; }
const { customName: renamed } = o;
return renamed;`);
});

// ─── realm-escape primitives are not whitelisted ─────────────────────────────

test("globalThis, Reflect, and Proxy are not in the safe built-in set", () => {
  // globalThis.constructor is the host Object (probe-verified); Reflect.*
  // and Proxy reach across the realm boundary regardless of literal checks.
  assertBlocked(`${META}\nreturn globalThis.constructor;`, "dangerous-member");
  assertBlocked(`${META}\nreturn Reflect.get(agent, "x");`, "unknown-global");
  assertBlocked(`${META}\nreturn new Proxy({}, {});`, "unknown-global");
});

test("Object cross-realm reflection methods are blocked", () => {
  assertBlocked(`${META}\nreturn Object.getPrototypeOf(agent);`, "object-reflection");
  assertBlocked(`${META}\nreturn Object.setPrototypeOf({}, null);`, "object-reflection");
  assertBlocked(`${META}\nreturn Object.defineProperty({}, "x", {});`, "object-reflection");
  assertBlocked(`${META}\nreturn Object.create(null);`, "object-reflection");
  // Data-shape helpers stay allowed.
  assertAllowed(`${META}\nreturn Object.keys({ a: 1 }).length + Object.values({ b: 2 }).length;`);
});

// ─── indexed-access carve-out ────────────────────────────────────────────────

test("local array indexed by a number or loop variable passes", () => {
  assertAllowed(`${META}
const verdicts = [1, 2, 3];
let total = verdicts[0];
for (let i = 0; i < verdicts.length; i++) { total += verdicts[i]; }
const first = verdicts[0];
return { total, first };`);
});

test("indexed access on bridge globals and non-array locals stays blocked", () => {
  // args / agent results are not plain local arrays — the audit cannot prove
  // the container shape, so string-keyed access stays rejected.
  assertBlocked(`${META}\nconst k = "x"; return args[k];`, "computed-member-access");
  assertBlocked(`${META}\nreturn agent["constructor"];`, "computed-member-access");
  assertBlocked(`${META}\nconst o = { a: 1 }; return o["a"];`, "computed-member-access");
});

// ─── bridge-global shadowing in nested positions ─────────────────────────────

test("bridge globals cannot be shadowed as params or catch bindings", () => {
  assertBlocked(`${META}\nconst f = (agent) => agent;`, "shadowed-bridge-global");
  assertBlocked(`${META}\ntry {} catch (log) {}`, "shadowed-bridge-global");
  assertBlocked(`${META}\nconst g = function parallel() {};`, "shadowed-bridge-global");
});

// ─── gate byte cap ───────────────────────────────────────────────────────────

test("oversized script is rejected without parsing", () => {
  const huge = `${META}\n//` + "x".repeat(1_100_000);
  const violations = auditWorkflowScript(huge);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].rule, "script-too-large");
});

// ─── tool_call wiring (mock event, no Pi session) ───────────────────────────

test("gateWorkflowScriptToolCall blocks a malicious start_workflow call", async () => {
  const { gateWorkflowScriptToolCall } = await import("../extensions/workflow.js");
  const result = gateWorkflowScriptToolCall({
    toolName: "start_workflow",
    input: { script: `${META}\nreturn globalThis.constructor.constructor("return process")();` },
  });
  assert.ok(result, "expected a block result");
  assert.equal(result.block, true);
  assert.equal(result.terminate, true);
  assert.match(result.reason, /static audit/);
});

test("gateWorkflowScriptToolCall passes through non-workflow tools and clean scripts", async () => {
  const { gateWorkflowScriptToolCall } = await import("../extensions/workflow.js");
  // Other tools are never gated.
  assert.equal(gateWorkflowScriptToolCall({ toolName: "read_file", input: { script: "evil" } }), undefined);
  // Preset / no-script invocations are never gated.
  assert.equal(gateWorkflowScriptToolCall({ toolName: "start_workflow", input: { preset: "code-review" } }), undefined);
  assert.equal(gateWorkflowScriptToolCall({ toolName: "start_workflow", input: {} }), undefined);
  // Clean script passes.
  assert.equal(
    gateWorkflowScriptToolCall({
      toolName: "start_workflow",
      input: { script: `${META}\nreturn agent("ok", { label: "x" });` },
    }),
    undefined,
  );
});
