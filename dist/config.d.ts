/**
 * Configuration constants for pi-dynamic-workflows.
 */
/** Maximum number of agents allowed per workflow run. */
export declare const MAX_AGENTS_PER_RUN = 1000;
/** Default timeout for a single agent in milliseconds. null means no hard timeout. */
export declare const DEFAULT_AGENT_TIMEOUT_MS: any;
/** Maximum concurrent agents (matches Claude Code limit). */
export declare const MAX_CONCURRENCY = 16;
/** Maximum automatic retry attempts after a recoverable agent failure. */
export declare const MAX_AGENT_RETRIES = 3;
/** Default token budget if none specified. */
export declare const DEFAULT_TOKEN_BUDGET: any;
/** Legacy project-relative directory for persisted workflow run state. New writes use workflowProjectPaths(). */
export declare const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";
/** Legacy project-relative directory for saved workflow commands. New writes use workflowProjectPaths(). */
export declare const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";
/** User-level saved workflows directory. */
export declare const USER_WORKFLOW_SAVED_DIR = "~/.pi/workflows/saved";
/** User-level model tiers config file, relative to the home directory. */
export declare const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";
/** User-level workflow extension settings file, relative to the home directory. */
export declare const WORKFLOW_SETTINGS_FILE = ".pi/workflows/settings.json";
/** Default keyword that arms workflows mode from interactive input. */
export declare const DEFAULT_KEYWORD_TRIGGER_WORD = "workflow";
/** Normalize a user-configured keyword trigger word. */
export declare function normalizeKeywordTriggerWord(value: unknown): string | undefined;
/**
 * Named workflow subagent definitions directory. Resolved project-relative
 * (cwd/.pi/agents), plus user-level at `~/.pi/agent/agents/` (the primary
 * location, via `getAgentDir()` in agent-registry.ts) with the legacy
 * `~/.pi/agents/` (this constant, home-relative) scanned as a deprecated
 * fallback. Project entries win on name collision, then the primary user
 * location, then the legacy one. Each `*.md` file is an agent definition
 * (frontmatter + body prompt).
 */
export declare const AGENTS_DIR = ".pi/agents";
