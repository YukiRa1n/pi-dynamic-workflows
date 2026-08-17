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
 *   `constructor`/mutators that literal checks cannot see.
 * - Global names: free references must resolve to a local binding, an
 *   injected workflow global, or a safe vm-realm built-in (Function/eval are
 *   NOT in the built-in set).
 *
 * Known limits (documented, not hidden): a script inside this subset can
 * still waste tokens through agent() fan-out (bounded by run resource
 * limits) or burn event-loop time from an async continuation (bounded by the
 * run wall-clock timeout). Those are resource-governance problems, not
 * sandbox escapes, and are enforced by the manager's existing ceilings.
 */
/** Injected workflow runtime globals (mirrors the capability contract's
 * runtimeGlobal list — keep in sync). */
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
    "meta",
]);
/** vm-realm built-ins that cannot reach host state. Function, eval,
 * GeneratorFunction and AsyncFunction are deliberately absent (dynamic code
 * execution). Date/Math are present; their nondeterministic entry points are
 * neutered in-realm by DETERMINISM_PRELUDE and rejected by the runner's own
 * findNondeterminism pass. */
const SAFE_BUILTINS = new Set([
    "globalThis",
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
    "JSON",
    "Map",
    "Math",
    "Number",
    "Promise",
    "Proxy",
    "Reflect",
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
    "queueMicrotask",
    "structuredClone",
    "atob",
    "btoa",
    "TextEncoder",
    "TextDecoder",
    "URL",
    "URLSearchParams",
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
/** Cap the report size; the scan still covers the whole file so the model
 * sees the shape of what to fix, but reason text stays small. */
const MAX_REPORTED_VIOLATIONS = 8;
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
function childKeys(node) {
    return Object.keys(node).filter((key) => !NON_CHILD_KEYS.has(key));
}
function childrenOf(node, key) {
    const value = node[key];
    if (Array.isArray(value)) {
        const out = [];
        for (const child of value) {
            if (child && typeof child === "object" && typeof child.type === "string")
                out.push(child);
        }
        return out;
    }
    if (value && typeof value === "object" && typeof value.type === "string")
        return [value];
    return [];
}
/** Names introduced by a binding pattern. */
function patternNames(pattern, out = []) {
    if (!pattern)
        return out;
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
            for (const element of pattern.elements ?? [])
                patternNames(element, out);
            break;
        case "ObjectPattern":
            for (const property of pattern.properties ?? []) {
                if (!property)
                    continue;
                if (property.type === "RestElement")
                    patternNames(property.argument, out);
                else
                    patternNames(property.value, out);
            }
            break;
        default:
            break;
    }
    return out;
}
/**
 * Whether an Identifier occurrence reads a value, classified from the parent
 * slot recorded during the walk. Non-reference slots (declaration ids, member
 * property names, labels, import/export specifiers, binding patterns) are
 * excluded so the unknown-global rule only fires on genuine free references.
 */
function isReferencePosition(node) {
    const parent = node.__parent;
    const key = node.__parentKey;
    if (!parent || !key)
        return true;
    switch (parent.type) {
        case "MemberExpression":
        case "OptionalMemberExpression":
            return key === "object" || (key === "property" && parent.computed === true);
        case "Property":
        case "PropertyDefinition":
        case "MethodDefinition":
            if (key === "key")
                return parent.computed === true;
            return true;
        case "VariableDeclarator":
            return key !== "id";
        case "FunctionDeclaration":
        case "FunctionExpression":
        case "ArrowFunctionExpression":
        case "ClassDeclaration":
        case "ClassExpression":
            return key !== "id" && key !== "params";
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
        case "AssignmentPattern":
            return key === "right";
        case "MetaProperty":
            return false;
        default:
            return true;
    }
}
/**
 * Statically audit a workflow script. Returns the violation list; empty means
 * the script is inside the orchestration subset. Never throws on unparseable
 * input — parse errors are reported as a violation (the runner would reject
 * them anyway).
 */
export function auditWorkflowScript(script) {
    const violations = [];
    const push = (rule, message, node) => {
        if (violations.length >= MAX_REPORTED_VIOLATIONS)
            return;
        violations.push({ rule, message, line: node?.loc?.start?.line });
    };
    let ast;
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
        });
    }
    catch (error) {
        return [
            {
                rule: "parse-error",
                message: `Script does not parse: ${error instanceof Error ? error.message : String(error)}`,
            },
        ];
    }
    // Pass 1: collect every local binding (function/class declarations hoist,
    // so this must be a full pre-pass before reference checks).
    const localBindings = new Set();
    {
        const stack = [ast];
        while (stack.length) {
            const node = stack.pop();
            switch (node.type) {
                case "VariableDeclaration":
                    for (const declaration of node.declarations ?? []) {
                        for (const name of patternNames(declaration.id))
                            localBindings.add(name);
                    }
                    break;
                case "FunctionDeclaration":
                    if (node.id)
                        localBindings.add(node.id.name);
                    for (const param of node.params ?? []) {
                        for (const name of patternNames(param))
                            localBindings.add(name);
                    }
                    break;
                case "FunctionExpression":
                case "ArrowFunctionExpression":
                    if (node.type === "FunctionExpression" && node.id)
                        localBindings.add(node.id.name);
                    for (const param of node.params ?? []) {
                        for (const name of patternNames(param))
                            localBindings.add(name);
                    }
                    break;
                case "ClassDeclaration":
                case "ClassExpression":
                    if (node.id)
                        localBindings.add(node.id.name);
                    break;
                case "CatchClause":
                    for (const name of patternNames(node.param))
                        localBindings.add(name);
                    break;
                case "ImportDeclaration":
                    // Static imports are rejected in pass 2; collecting the names here
                    // avoids a second wave of "unknown global" noise on the same code.
                    for (const specifier of node.specifiers ?? []) {
                        if (specifier.local?.name)
                            localBindings.add(specifier.local.name);
                    }
                    break;
                default:
                    break;
            }
            for (const key of childKeys(node)) {
                for (const child of childrenOf(node, key))
                    stack.push(child);
            }
        }
    }
    // Pass 2: enforce the subset. Parent links are attached as we descend so
    // Identifier reference classification can inspect its slot.
    {
        const stack = [ast];
        while (stack.length) {
            const node = stack.pop();
            switch (node.type) {
                case "WithStatement":
                    push("with-statement", "`with` is not allowed (scope ambiguity defeats the audit)", node);
                    break;
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
                    push("for-in", "`for...in` is not allowed (string-key enumeration can reach prototype mutators the audit cannot see)", node);
                    break;
                case "MemberExpression":
                case "OptionalMemberExpression":
                    if (node.computed) {
                        push("computed-member-access", "computed member access `obj[expr]` is not allowed (string-keyed access can reach `constructor`/`__proto__`); use a literal property name", node);
                    }
                    else if (node.property?.type === "Identifier" && node.property.name === "__proto__") {
                        push("proto-access", "`__proto__` access is not allowed", node);
                    }
                    break;
                case "Property":
                case "PropertyDefinition":
                case "MethodDefinition": {
                    if (node.computed) {
                        push("computed-property-key", "computed property keys are not allowed", node);
                    }
                    else {
                        const key = node.key;
                        const name = key?.type === "Identifier" ? key.name : key?.type === "Literal" ? String(key.value) : undefined;
                        if (name === "__proto__")
                            push("proto-key", "`__proto__` property keys are not allowed", node);
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
                        }
                        else if (callee.name === "Function" ||
                            callee.name === "GeneratorFunction" ||
                            callee.name === "AsyncFunction") {
                            push("function-constructor", `\`${node.type === "NewExpression" ? "new " : ""}${callee.name}()\` is not allowed (dynamic code execution)`, node);
                        }
                    }
                    break;
                }
                case "Identifier": {
                    if (isReferencePosition(node)) {
                        const name = node.name;
                        if (!localBindings.has(name) && !WORKFLOW_GLOBALS.has(name) && !SAFE_BUILTINS.has(name)) {
                            push("unknown-global", `\`${name}\` is not a declared local, an injected workflow global, or a safe built-in`, node);
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
                        push("shadowed-bridge-global", `\`${node.id.name}\` is a runtime bridge global and cannot be redeclared`, node);
                    }
                    break;
                default:
                    break;
            }
            for (const key of childKeys(node)) {
                for (const child of childrenOf(node, key)) {
                    child.__parent = node;
                    child.__parentKey = key;
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
export function decideWorkflowScriptGate(script) {
    if (typeof script !== "string" || script.trim().length === 0) {
        return { action: "allow", via: "not-required" };
    }
    const violations = auditWorkflowScript(script);
    if (violations.length === 0)
        return { action: "allow", via: "static-audit" };
    const listed = violations.map((v) => `  - ${v.line !== undefined ? `line ${v.line}: ` : ""}${v.message}`).join("\n");
    return {
        action: "block",
        violations,
        reason: `Workflow script rejected by static audit (${violations.length} issue${violations.length === 1 ? "" : "s"}). ` +
            `Scripts run with user permissions and node:vm is not a security sandbox, so only the declarative ` +
            `orchestration subset is accepted. Fix the script or use a built-in \`preset\`:\n${listed}`,
    };
}
