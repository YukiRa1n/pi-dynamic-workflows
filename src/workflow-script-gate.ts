import { parse } from "acorn";

/**
 * Static audit for model-authored workflow scripts.
 *
 * Background: workflow scripts run under Node's `vm`, which is a determinism
 * and synchronous-CPU boundary, NOT a hostile-code security boundary. The
 * prototype-escape primitive is always the same shape: reach a host-created
 * function (any injected bridge function), then `fn.constructor` is the host
 * `Function`, and `fn.constructor("return process")()` executes in the host
 * realm. DETERMINISM_PRELUDE strips `.constructor` from injected globals, but
 * only as a best-effort runtime patch.
 *
 * This gate is the extension-level audit layer that runs BEFORE the script
 * reaches the runner, with no interactive confirmation: calls carrying a
 * custom script are statically rejected when they use constructs outside the
 * declarative orchestration subset, and allowed otherwise. `preset`
 * invocations are curated in-repo and pass ungated.
 *
 * Policy (default-deny on dangerous shapes):
 * - Syntax: no `with`, no `import`/`export *`, no `eval()`, no
 *   `Function()`/`GeneratorFunction`/`AsyncFunction` constructors (call or
 *   `new`), no dynamic `import()`.
 * - Prototype tampering: no `__proto__` as member, property key, or pattern
 *   key.
 * - Reflection-by-string: no computed member access `obj[expr]`, no computed
 *   property keys, no `for...in` — string-keyed access can reach
 *   `constructor`/mutators that literal checks cannot see. (Plain indexed
 *   access on a local array with a numeric/loop-variable index is allowed;
 *   see `isLocalIndexedAccess`.)
 * - Dangerous members: literal `.constructor` / `.prototype` / `__proto__`
 *   member access is always rejected — these are the escape primitives that
 *   string-keyed reflection is just a longer path to.
 * - Global names: free references must resolve to a local binding, an
 *   injected workflow global, or a safe vm-realm built-in (Function/eval are
 *   NOT in the built-in set; `globalThis`, `Reflect`, and `Proxy` are also
 *   not in the built-in set because they are realm-escape primitives).
 *
 * Known limits (documented, not hidden): a script inside this subset can
 * still waste tokens through agent() fan-out (bounded by run resource
 * limits) or burn event-loop time from an async continuation (bounded by the
 * run wall-clock timeout). Those are resource-governance problems, not
 * sandbox escapes, and are enforced by the manager's existing ceilings.
 */

/** Injected workflow runtime globals (mirrors the capability contract's
 * runtimeGlobal list — keep in sync). `meta` is NOT listed: the runner strips
 * the `export const meta` declaration before wrapping, so a top-level `meta`
 * reference would be a ReferenceError at runtime. */
const WORKFLOW_GLOBALS = new Set([
  "agent",
  "parallel",
  "pipeline",
  "createTeam",
  "workflow",
  "verify",
  "judgePanel",
  "loopUntilDry",
  "completenessCheck",
  "retry",
  "gate",
  "checkpoint",
  "deliver",
  "log",
  "phase",
  "args",
  "cwd",
  "process",
  "budget",
  "console",
]);

/** vm-realm built-ins that cannot reach host state. Function, eval,
 * GeneratorFunction and AsyncFunction are deliberately absent (dynamic code
 * execution). `globalThis`, `Reflect`, and `Proxy` are absent: they are
 * realm-escape primitives (globalThis.constructor is the host Object;
 * Reflect.get/setPrototypeOf reach across the realm boundary regardless of
 * the audit's literal-member checks). Date/Math are present; their
 * nondeterministic entry points are neutered in-realm by DETERMINISM_PRELUDE
 * and rejected by the runner's own findNondeterminism pass. */
const SAFE_BUILTINS = new Set([
  "undefined",
  "NaN",
  "Infinity",
  "Object",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Int16Array",
  "Int32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Uint32Array",
  "Intl",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Promise",
  "RegExp",
  "Set",
  "SharedArrayBuffer",
  "String",
  "Symbol",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "FinalizationRegistry",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "unescape",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
]);

/** Object static methods that mutate or introspect prototype/own-property
 * metadata — these reach across the realm boundary and defeat the audit's
 * literal-member checks. Only the pure data-shape helpers stay allowed. */
const OBJECT_REFLECTION_METHODS = new Set([
  "getPrototypeOf",
  "setPrototypeOf",
  "defineProperty",
  "defineProperties",
  "create",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "getOwnPropertyNames",
  "getOwnPropertySymbols",
  "freeze",
  "seal",
  "preventExtensions",
  "isFrozen",
  "isSealed",
  "isExtensible",
]);

/** Host bridge globals that can never be redeclared locally: a local
 * `const agent = ...` would both shadow the runtime and give the script a
 * stash point for host references under a name the audit treats as safe. */
const PROTECTED_GLOBALS = new Set([
  "agent",
  "parallel",
  "pipeline",
  "createTeam",
  "workflow",
  "verify",
  "judgePanel",
  "loopUntilDry",
  "completenessCheck",
  "retry",
  "gate",
  "checkpoint",
  "deliver",
  "log",
  "phase",
  "process",
  "budget",
  "console",
]);

/** Members that are always rejected when accessed literally. These are the
 * host-realm escape primitives; string-keyed reflection (`obj["constructor"]`)
 * is the same attack and is already rejected by the computed-member rule. */
const DANGEROUS_MEMBERS = new Set(["constructor", "prototype", "__proto__"]);

export type WorkflowScriptAuditViolation = {
  /** Short machine-stable rule id, e.g. "computed-member-access". */
  rule: string;
  /** Human-facing detail with the offending construct. */
  message: string;
  /** 1-based source line when the parser provided one. */
  line?: number;
};

export type WorkflowScriptGateDecision =
  | { action: "allow"; via: "static-audit" | "not-required" }
  | { action: "block"; reason: string; violations: WorkflowScriptAuditViolation[] };

type AnyNode = { type: string; start: number; end: number; loc?: { start: { line: number } }; [key: string]: any };

/** Cap the report size; the scan still covers the whole file so the model
 * sees the shape of what to fix, but reason text stays small. */
const MAX_REPORTED_VIOLATIONS = 8;

/** Hard byte cap on what the gate will even parse. Larger inputs are rejected
 * without parsing so a multi-MB model response cannot stall the session in a
 * synchronous acorn pass. The runner's own 10 MB limit stays as the outer
 * boundary; this is the gate's cheaper early exit. */
const GATE_MAX_SCRIPT_BYTES = 1_000_000;

const NON_CHILD_KEYS = new Set([
  "type",
  "start",
  "end",
  "loc",
  "range",
  "parent",
  "__parent",
  "__parentKey",
  "leadingComments",
  "trailingComments",
]);

function childKeys(node: AnyNode): string[] {
  return Object.keys(node).filter((key) => !NON_CHILD_KEYS.has(key));
}

function childrenOf(node: AnyNode, key: string): AnyNode[] {
  const value = node[key];
  if (Array.isArray(value)) {
    const out: AnyNode[] = [];
    for (const child of value) {
      if (child && typeof child === "object" && typeof child.type === "string") out.push(child as AnyNode);
    }
    return out;
  }
  if (value && typeof value === "object" && typeof value.type === "string") return [value as AnyNode];
  return [];
}

/** Names introduced by a binding pattern. */
function patternNames(pattern: AnyNode | null | undefined, out: string[] = []): string[] {
  if (!pattern) return out;
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "RestElement":
      patternNames(pattern.argument, out);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, out);
      break;
    case "ArrayPattern":
      for (const element of pattern.elements ?? []) patternNames(element, out);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties ?? []) {
        if (!property) continue;
        if (property.type === "RestElement") patternNames(property.argument, out);
        else patternNames(property.value, out);
      }
      break;
    default:
      break;
  }
  return out;
}

/**
 * Lexical scope chain. Each frame is the set of names bound in that scope;
 * lookups walk outward. Function/class declarations hoist within their frame,
 * so pass 1 registers them before pass 2 evaluates references. `var` bindings
 * hoist to the nearest function/module frame (approximated here by the module
 * frame, which is correct for the top-level shapes the runner accepts).
 */
type Scope = { names: Set<string>; parent: Scope | null };

function createScope(parent: Scope | null): Scope {
  return { names: new Set(), parent };
}

function scopeLookup(scope: Scope, name: string): boolean {
  let current: Scope | null = scope;
  while (current) {
    if (current.names.has(name)) return true;
    current = current.parent;
  }
  return false;
}

/** Register a binding pattern's names in the given scope. */
function bindPattern(scope: Scope, pattern: AnyNode | null | undefined): void {
  for (const name of patternNames(pattern)) scope.names.add(name);
}

/** Whether a node opens a new lexical scope for its body. Note: class
 * declarations/expressions do NOT open a scope for the class name itself
 * (the name is visible to following statements), only for the class body —
 * pass 1 handles that by registering the name in the enclosing scope before
 * descending into the body scope. */
function opensScope(node: AnyNode): boolean {
  switch (node.type) {
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "BlockStatement":
    case "ForStatement":
    case "ForOfStatement":
    case "CatchClause":
    case "StaticBlock":
      return true;
    default:
      return false;
  }
}

/** ForInStatement does NOT open a scope here — it is rejected outright in
 * pass 2, so its body's scoping is irrelevant. */

/**
 * Whether an Identifier occurrence reads a value, classified from the parent
 * slot recorded during the walk. Non-reference slots (declaration ids, member
 * property names, labels, import/export specifiers, binding patterns) are
 * excluded so the unknown-global rule only fires on genuine free references.
 *
 * Assignment/UpdateExpression targets (`x = 1`, `[x] = arr`, `({p: x} = o)`)
 * are references: they write through the resolved binding, so an unresolved
 * target must still be reported (strict-mode ReferenceError at runtime, and
 * a silent host-global write in sloppy mode).
 */
function isReferencePosition(node: AnyNode): boolean {
  const parent = node.__parent as AnyNode | undefined;
  const key = node.__parentKey as string | undefined;
  if (!parent || !key) return true;
  switch (parent.type) {
    case "MemberExpression":
    case "OptionalMemberExpression":
      return key === "object" || (key === "property" && parent.computed === true);
    case "Property":
    case "PropertyDefinition":
    case "MethodDefinition":
      if (key === "key") return parent.computed === true;
      return true;
    case "VariableDeclarator":
      return key !== "id";
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
    case "ClassDeclaration":
      // `id` is the declaration binding (registered in the enclosing scope
      // by pass 1); `superClass`/`body` are evaluated positions.
      return key !== "id";
    case "ClassExpression":
      // `id` binds only inside the class's own scope (registered by pass 1).
      return key !== "id";
    case "LabeledStatement":
    case "BreakStatement":
    case "ContinueStatement":
      return false;
    case "ImportSpecifier":
    case "ImportDefaultSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportSpecifier":
      return false;
    case "CatchClause":
      return key !== "param";
    case "ObjectPattern":
    case "ArrayPattern":
    case "RestElement":
      return false;
    case "MetaProperty":
      return false;
    default:
      // Assignment targets (`x = 1`, `[x] = arr`, `({p: x} = o)`) write
      // through the resolved binding, so an unresolved target must still be
      // reported (strict-mode ReferenceError at runtime, silent host-global
      // write in sloppy mode).
      return true;
  }
}

/** Whether `node` is an allowed indexed access: a local identifier bound to
 * an array literal, indexed by a numeric literal or a local identifier.
 * `arr[0]` / `verdicts[i]` pass; `args[key]` / `agent["x"]` / anything whose
 * base is not a locally-declared array stays rejected — the audit cannot
 * prove those containers are plain data. */
function isLocalIndexedAccess(node: AnyNode, scope: Scope): boolean {
  const object = node.object;
  if (!object || object.type !== "Identifier") return false;
  // Only a local binding, and only one pass 1 saw initialized from an array
  // literal, qualifies. Bridge globals (args, agent, ...) and whitelisted
  // built-ins are never in any local scope, so they cannot reach here.
  if (!scopeLookup(scope, object.name as string)) return false;
  if (!(node.__arrayLocals as Set<string> | undefined)?.has(object.name as string)) return false;
  const property = node.property;
  if (!property) return false;
  switch (property.type) {
    case "Literal":
      return typeof property.value === "number";
    case "Identifier":
      return scopeLookup(scope, property.name as string);
    default:
      return false;
  }
}

/**
 * Statically audit a workflow script. Returns the violation list; empty means
 * the script is inside the orchestration subset. Never throws on unparseable
 * input — parse errors are reported as a violation (the runner would reject
 * them anyway).
 */
export function auditWorkflowScript(script: string): WorkflowScriptAuditViolation[] {
  const violations: WorkflowScriptAuditViolation[] = [];
  const push = (rule: string, message: string, node?: AnyNode) => {
    if (violations.length >= MAX_REPORTED_VIOLATIONS) return;
    violations.push({ rule, message, line: node?.loc?.start?.line });
  };

  if (typeof script === "string" && script.length > GATE_MAX_SCRIPT_BYTES) {
    return [
      {
        rule: "script-too-large",
        message: `Script exceeds the audit's ${GATE_MAX_SCRIPT_BYTES}-character parse budget`,
      },
    ];
  }

  let ast: AnyNode;
  try {
    // Same parse surface as the runner's parseWorkflowScript: module source
    // with top-level await/return allowed (the runner later strips
    // `export const meta` and wraps the body in an async function).
    ast = parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      locations: true,
    }) as unknown as AnyNode;
  } catch (error) {
    return [
      {
        rule: "parse-error",
        message: `Script does not parse: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }

  // Pass 1: build the lexical scope tree and register bindings. Function and
  // class declarations hoist within their scope, so they are registered
  // before any reference is evaluated in pass 2. Each scope-opening node gets
  // a fresh child scope; everything else shares the enclosing scope.
  //
  // We store the scope each node belongs to on `__scope` so pass 2 can look
  // up the correct chain for any reference without re-deriving it. We also
  // record which local names were initialized from an array literal
  // (`__arrayLocals`) so the indexed-access carve-out only applies to plain
  // local arrays — never to bridge globals like `args`.
  const moduleScope = createScope(null);
  const arrayLocals = new Set<string>();
  {
    type Frame = { node: AnyNode; scope: Scope };
    const stack: Frame[] = [{ node: ast, scope: moduleScope }];
    while (stack.length) {
      const { node, scope } = stack.pop()!;
      node.__scope = scope;
      node.__arrayLocals = arrayLocals;

      switch (node.type) {
        case "VariableDeclaration": {
          for (const declaration of node.declarations ?? []) {
            bindPattern(scope, declaration.id);
            if (declaration.id?.type === "Identifier" && declaration.init?.type === "ArrayExpression") {
              arrayLocals.add(declaration.id.name as string);
            }
          }
          break;
        }
        case "FunctionDeclaration": {
          if (node.id) scope.names.add(node.id.name);
          // Function params live in the function's own scope, registered when
          // we descend into the function node below (it opens a new scope).
          break;
        }
        case "ClassDeclaration": {
          if (node.id) scope.names.add(node.id.name);
          // Class body opens its own scope; register the class name there too
          // so methods/computed keys can reference the class being defined.
          break;
        }
        case "FunctionExpression":
        case "ArrowFunctionExpression": {
          // Named function expressions bind their own name only inside their
          // own scope; params likewise. Registered on descent.
          break;
        }
        case "ClassExpression":
          break;
        case "CatchClause": {
          // Catch param is registered in the catch scope on descent.
          break;
        }
        case "ImportDeclaration": {
          // Static imports are rejected in pass 2; collecting the names here
          // avoids a second wave of "unknown global" noise on the same code.
          for (const specifier of node.specifiers ?? []) {
            if (specifier.local?.name) scope.names.add(specifier.local.name);
          }
          break;
        }
        default:
          break;
      }

      for (const key of childKeys(node)) {
        for (const child of childrenOf(node, key)) {
          const childScope = opensScope(child) ? createScope(scope) : scope;
          // Register bindings that belong to the NEW child scope before
          // descending: function/arrow params, function-expression name,
          // catch param. Class declaration/expression names were already
          // registered in the OUTER scope when the class node itself was
          // visited (they are visible to following statements), so they are
          // NOT re-registered here.
          if (childScope !== scope) {
            if (child.type === "FunctionExpression" && child.id) {
              childScope.names.add(child.id.name);
            }
            if (
              child.type === "FunctionDeclaration" ||
              child.type === "FunctionExpression" ||
              child.type === "ArrowFunctionExpression"
            ) {
              for (const param of child.params ?? []) bindPattern(childScope, param);
            }
            if (child.type === "CatchClause") bindPattern(childScope, child.param);
          }
          stack.push({ node: child, scope: childScope });
        }
      }
    }
  }

  // Pass 2: enforce the subset. Parent links are attached as we descend so
  // Identifier reference classification can inspect its slot; scope lookups
  // use the `__scope` recorded in pass 1.
  {
    const stack: AnyNode[] = [ast];
    while (stack.length) {
      const node = stack.pop()!;

      switch (node.type) {
        case "ImportDeclaration":
          push("import-declaration", "`import` is not allowed; workflows use injected globals, not modules", node);
          break;
        case "ImportExpression":
          push("dynamic-import", "dynamic `import()` is not allowed", node);
          break;
        case "ExportAllDeclaration":
          push("export-all", "`export *` is not allowed; export only `const meta`", node);
          break;
        case "ForInStatement":
          push(
            "for-in",
            "`for...in` is not allowed (string-key enumeration can reach prototype mutators the audit cannot see)",
            node,
          );
          break;
        case "MemberExpression":
        case "OptionalMemberExpression": {
          const scope = (node.__scope as Scope | undefined) ?? moduleScope;
          if (node.computed) {
            if (!isLocalIndexedAccess(node, scope)) {
              push(
                "computed-member-access",
                "computed member access `obj[expr]` is not allowed (string-keyed access can reach `constructor`/`__proto__`); use a literal property name, or a numeric/loop-variable index on a local array",
                node,
              );
            }
          } else if (node.property?.type === "Identifier" && DANGEROUS_MEMBERS.has(node.property.name as string)) {
            push(
              "dangerous-member",
              `\`.${node.property.name}\` member access is not allowed (host-realm escape primitive)`,
              node,
            );
          } else if (
            // `Object.getPrototypeOf` referenced as a VALUE (not just called)
            // is the same cross-realm primitive; reject the member read so an
            // alias (`const g = Object.getPrototypeOf; g(x)`) cannot smuggle
            // it past the call-site check.
            node.object?.type === "Identifier" &&
            node.object.name === "Object" &&
            node.property?.type === "Identifier" &&
            OBJECT_REFLECTION_METHODS.has(node.property.name as string)
          ) {
            push(
              "object-reflection",
              `\`Object.${node.property.name}\` is not allowed (cross-realm prototype/own-property introspection)`,
              node,
            );
          }
          break;
        }
        case "Property": {
          if (node.computed) {
            push("computed-property-key", "computed property keys are not allowed", node);
          } else {
            const key = node.key;
            const name =
              key?.type === "Identifier" ? key.name : key?.type === "Literal" ? String(key.value) : undefined;
            if (name === "__proto__") push("proto-key", "`__proto__` property keys are not allowed", node);
          }
          break;
        }
        case "PropertyDefinition": {
          // Class field named `constructor` is legal and shadowed by the
          // method; only `__proto__` / `prototype` field names are dangerous.
          if (node.computed) {
            push("computed-property-key", "computed property keys are not allowed", node);
          } else {
            const key = node.key;
            const name =
              key?.type === "Identifier" ? key.name : key?.type === "Literal" ? String(key.value) : undefined;
            if (name === "__proto__" || name === "prototype") {
              push("proto-key", `\`${name}\` class field names are not allowed`, node);
            }
          }
          break;
        }
        case "MethodDefinition": {
          // Class `constructor` methods are normal; static blocks and
          // `__proto__`/`prototype` methods are not.
          if (node.computed) {
            push("computed-property-key", "computed property keys are not allowed", node);
          } else {
            const key = node.key;
            const name =
              key?.type === "Identifier" ? key.name : key?.type === "Literal" ? String(key.value) : undefined;
            if (name === "__proto__" || name === "prototype") {
              push("proto-key", `\`${name}\` method names are not allowed`, node);
            }
          }
          break;
        }
        case "CallExpression":
        case "OptionalCallExpression":
        case "NewExpression": {
          const callee = node.callee;
          if (callee?.type === "Identifier") {
            if (callee.name === "eval") {
              push("eval", "`eval()` is not allowed", node);
            } else if (
              callee.name === "Function" ||
              callee.name === "GeneratorFunction" ||
              callee.name === "AsyncFunction"
            ) {
              push(
                "function-constructor",
                `\`${node.type === "NewExpression" ? "new " : ""}${callee.name}()\` is not allowed (dynamic code execution)`,
                node,
              );
            }
          } else if (
            (callee?.type === "MemberExpression" || callee?.type === "OptionalMemberExpression") &&
            !callee.computed &&
            callee.object?.type === "Identifier" &&
            callee.object.name === "Object" &&
            callee.property?.type === "Identifier" &&
            OBJECT_REFLECTION_METHODS.has(callee.property.name as string)
          ) {
            push(
              "object-reflection",
              `\`Object.${callee.property.name}\` is not allowed (cross-realm prototype/own-property introspection)`,
              node,
            );
          }
          break;
        }
        case "Identifier": {
          if (isReferencePosition(node)) {
            const name = node.name as string;
            const scope = (node.__scope as Scope | undefined) ?? moduleScope;
            if (!scopeLookup(scope, name) && !WORKFLOW_GLOBALS.has(name) && !SAFE_BUILTINS.has(name)) {
              push(
                "unknown-global",
                `\`${name}\` is not a declared local, an injected workflow global, or a safe built-in`,
                node,
              );
            }
          }
          break;
        }
        case "VariableDeclaration":
          for (const declaration of node.declarations ?? []) {
            for (const name of patternNames(declaration.id)) {
              if (PROTECTED_GLOBALS.has(name)) {
                push("shadowed-bridge-global", `\`${name}\` is a runtime bridge global and cannot be redeclared`, node);
              }
            }
          }
          break;
        case "FunctionDeclaration":
        case "ClassDeclaration":
          if (node.id && PROTECTED_GLOBALS.has(node.id.name)) {
            push(
              "shadowed-bridge-global",
              `\`${node.id.name}\` is a runtime bridge global and cannot be redeclared`,
              node,
            );
          }
          break;
        // Function/arrow params and catch params may shadow a bridge global
        // inside their own scope (the prelude's protection is top-level
        // only); shadowing the name locally is how a script would stash a
        // host reference under an audit-trusted name.
        case "FunctionExpression":
        case "ArrowFunctionExpression": {
          if (node.type === "FunctionExpression" && node.id && PROTECTED_GLOBALS.has(node.id.name)) {
            push(
              "shadowed-bridge-global",
              `\`${node.id.name}\` is a runtime bridge global and cannot be redeclared`,
              node,
            );
          }
          for (const param of node.params ?? []) {
            for (const name of patternNames(param)) {
              if (PROTECTED_GLOBALS.has(name)) {
                push(
                  "shadowed-bridge-global",
                  `\`${name}\` is a runtime bridge global and cannot be used as a parameter name`,
                  node,
                );
              }
            }
          }
          break;
        }
        case "CatchClause":
          for (const name of patternNames(node.param)) {
            if (PROTECTED_GLOBALS.has(name)) {
              push(
                "shadowed-bridge-global",
                `\`${name}\` is a runtime bridge global and cannot be used as a catch binding`,
                node,
              );
            }
          }
          break;
        default:
          break;
      }

      for (const key of childKeys(node)) {
        for (const child of childrenOf(node, key)) {
          child.__parent = node;
          child.__parentKey = key;
          // Scope was already assigned in pass 1; nothing to recompute.
          stack.push(child);
        }
      }
    }
  }

  return violations;
}

/**
 * Gate a tool call's custom script through the static audit. Synchronous and
 * side-effect free; the caller turns a block decision into a tool error.
 */
export function decideWorkflowScriptGate(script: string | undefined): WorkflowScriptGateDecision {
  if (typeof script !== "string" || script.trim().length === 0) {
    return { action: "allow", via: "not-required" };
  }
  const violations = auditWorkflowScript(script);
  if (violations.length === 0) return { action: "allow", via: "static-audit" };
  const listed = violations.map((v) => `  - ${v.line !== undefined ? `line ${v.line}: ` : ""}${v.message}`).join("\n");
  return {
    action: "block",
    violations,
    reason:
      `Workflow script rejected by static audit (${violations.length} issue${violations.length === 1 ? "" : "s"}). ` +
      `Scripts run with user permissions and node:vm is not a security sandbox, so only the declarative ` +
      `orchestration subset is accepted. Fix the script or use a built-in \`preset\`:\n${listed}`,
  };
}
