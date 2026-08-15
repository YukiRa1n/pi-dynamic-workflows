/**
 * Shared registry of the 5 curated built-in workflow patterns
 * (`deep-research`, `adversarial-review`, `code-review`, `multi-perspective`,
 * `codebase-audit`).
 *
 * This is the single place that turns a pattern's name + caller-supplied args
 * into a runnable script (and, where a pattern needs it, an exec context such
 * as web tools). Both entry points a model or user can reach a built-in
 * through — the `/deep-research`-style slash commands (builtin-commands.ts)
 * and the `workflow` tool's `name` input (workflow-tool.ts) — resolve through
 * this one registry, so the two paths can never drift apart and the
 * per-pattern generator scripts are written exactly once.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { WorkflowStorage } from "./workflow-saved.js";
/** Default perspective set used when a caller gives fewer than two. */
export declare const DEFAULT_MULTI_PERSPECTIVES: readonly string[];
/** A resolved, ready-to-run script plus the exec context it needs (if any). */
export interface BuiltinWorkflowInvocation {
    script: string;
    tools?: ToolDefinition[];
    toolset?: string;
}
export interface BuiltinWorkflowDescriptor {
    /** Also the slash-command name (without the leading `/`). */
    name: string;
    description: string;
    /** Build the script (and exec context) for one invocation; throws on invalid `args`. */
    resolve(cwd: string, args: unknown): BuiltinWorkflowInvocation;
}
/** The 5 curated built-in workflow patterns, keyed by their stable name. */
export declare const BUILTIN_WORKFLOWS: readonly BuiltinWorkflowDescriptor[];
/** Stable list of built-in workflow pattern names, in registry order. */
export declare const BUILTIN_WORKFLOW_NAMES: readonly string[];
export declare function findBuiltinWorkflow(name: string): BuiltinWorkflowDescriptor | undefined;
/**
 * Resolve a name to a runnable invocation, checking project/user saved
 * workflows first and falling back to the built-in patterns — the same
 * precedence `workflow-saved.ts` already uses internally (project > user), one
 * level up: saved workflows (of either scope) beat a built-in of the same name.
 */
export declare function resolveWorkflowInvocation(name: string, args: unknown, ctx: {
    storage: WorkflowStorage;
    cwd: string;
}): BuiltinWorkflowInvocation | undefined;
