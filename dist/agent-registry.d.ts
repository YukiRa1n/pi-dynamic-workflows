/**
 * Named workflow subagent definitions ("agentType" registry).
 *
 * A workflow script can route an agent() call to a reusable, named definition:
 *
 *   agent("audit this dir", { agentType: "security-auditor" })
 *
 * Definitions live as Markdown files under `.pi/agents/*.md` (project, cwd-relative)
 * and `~/.pi/agent/agents/*.md` (user — `getAgentDir() + "agents"`, honoring the
 * `PI_CODING_AGENT_DIR` override), matching pi-coding-agent's own built-in agent
 * discovery convention. The legacy `~/.pi/agents/*.md` location is still scanned as
 * a deprecated fallback (with a one-time warning) so users who followed this repo's
 * earlier docs are not silently broken; the new location wins on a name collision.
 * Frontmatter binds the subagent's tools, model, and a body prompt; project
 * definitions win over both user-level locations on a name collision. This mirrors
 * Claude Code's `.claude/agents` registry: agentType is a real binding of
 * tools+model+system-prompt, not a prose hint.
 *
 * Bound today: `tools` (allowlist), `disallowedTools` (denylist), `model`,
 * and the markdown body (`prompt`). Parsed-but-ignored for now (documented): `mcp`, `skills`, `background`.
 * Wired: `isolation` ("worktree") → createWorktree() in workflow.ts.
 */
export interface AgentDefinition {
    /** Stable identity used as the `agentType` value. */
    name: string;
    /** One-line summary (for discoverability in the tool guideline). */
    description?: string;
    /** Allowlist of coding-tool names the subagent may use. Undefined = all. */
    tools?: string[];
    /** Denylist of coding-tool names, applied after the allowlist. */
    disallowedTools?: string[];
    /** Model spec (`provider/modelId` or bare id) for this subagent. */
    model?: string;
    /** Isolation mode. When "worktree", agents using this type run in a git worktree. */
    isolation?: "worktree";
    /** Markdown body, prepended to the subagent's task as role guidance. */
    prompt: string;
    /** Where the definition was loaded from (project wins over user). */
    source: "project" | "user";
}
export type AgentRegistry = Map<string, AgentDefinition>;
/**
 * Parse one agent-definition markdown file. Returns null only when there is no
 * usable content (no name derivable and an empty body).
 */
export declare function parseAgentDefinition(content: string, source: "project" | "user", fileName: string): AgentDefinition | null;
/**
 * Load the agent registry once for a run. Scans the project dir, then the
 * user dir, then — as a deprecated fallback — the legacy user dir; the FIRST
 * definition for a name wins (project > user > legacy user, then filename
 * order), so a name collision is resolved deterministically and silently.
 *
 * When a definition is only found at the legacy location (not shadowed by
 * the new user dir), a single deprecation warning is logged for this call
 * telling the user to move their files — not one warning per legacy file.
 *
 * `opts` overrides the scanned directories (used by tests).
 */
export declare function loadAgentRegistry(cwd: string, opts?: {
    projectDir?: string;
    userDir?: string;
    legacyUserDir?: string;
}): AgentRegistry;
/** Resolve an agentType name to its definition, or undefined if not registered. */
export declare function resolveAgentType(name: string | undefined, registry: AgentRegistry): AgentDefinition | undefined;
/**
 * Apply a definition's tool policy to a tool list: keep only allowlisted names
 * (when an allowlist is given), then drop any denylisted names. Generic over any
 * object with a `name` so it is unit-testable without real ToolDefinitions.
 */
export declare function applyToolPolicy<T extends {
    name: string;
}>(tools: T[], allow?: string[], deny?: string[]): T[];
/**
 * A stable identity string for a resolved definition, folded into the resume
 * call-hash so editing an agent `.md` invalidates that call's cached result.
 */
export declare function agentDefinitionKey(def: AgentDefinition | undefined): string | null;
/** List registered agent types for discoverability in the tool guideline. */
export declare function listAgentTypes(registry: AgentRegistry): Array<{
    name: string;
    description?: string;
}>;
