/**
 * Configuration constants for pi-dynamic-workflows.
 */
/** Maximum number of agents allowed per workflow run. */
export declare const MAX_AGENTS_PER_RUN = 1000;
/** Maximum number of items materialized by one parallel()/pipeline() fan-out. */
export declare const MAX_FANOUT_ITEMS = 10000;
/** Maximum log entries retained by one workflow run. */
export declare const MAX_WORKFLOW_LOG_ENTRIES = 10000;
/** Maximum UTF-8 bytes retained by one workflow run's logs. */
export declare const MAX_WORKFLOW_LOG_BYTES: number;
/** Maximum UTF-8 bytes admitted to one provider-facing agent prompt. */
export declare const MAX_AGENT_PROMPT_BYTES: number;
/** Maximum complete JSON bytes published for one durable workflow record. */
export declare const MAX_DURABLE_RUN_BYTES: number;
/** Default in-memory paused-run retention; persisted paused runs remain resumable. */
export declare const DEFAULT_MAX_PAUSED_RUNS_IN_MEMORY = 20;
/** Maximum members/tasks/messages retained by one workflow team by default. */
export declare const DEFAULT_MAX_TEAM_MEMBERS = 100;
/** Run-wide Agent Team state ceilings. */
export declare const MAX_TEAMS_PER_RUN = 32;
export declare const MAX_TEAM_MEMBERS_PER_RUN = 1000;
export declare const MAX_TEAM_TASKS_PER_RUN = 4000;
export declare const MAX_TEAM_MESSAGES_PER_RUN = 8192;
/** Manager-wide pending user-message high-water marks. */
export declare const MAX_PENDING_MESSAGES = 1024;
export declare const MAX_PENDING_MESSAGE_BYTES: number;
/** Non-evicting paused durable high-water marks; explicit prune is required. */
export declare const DEFAULT_MAX_PAUSED_RUNS_ON_DISK = 10000;
export declare const DEFAULT_MAX_PAUSED_BYTES_ON_DISK: number;
export declare const DEFAULT_MAX_TEAM_TASKS = 2000;
export declare const DEFAULT_MAX_TEAM_MESSAGES = 4096;
/** SharedStore resource ceilings. Values are rejected before they enter the store. */
export declare const MAX_SHARED_STORE_KEYS = 2048;
export declare const MAX_SHARED_STORE_KEY_BYTES: number;
export declare const MAX_SHARED_STORE_VALUE_BYTES: number;
export declare const MAX_SHARED_STORE_TOTAL_BYTES: number;
/** Default timeout for a single agent in milliseconds. null means no per-agent hard timeout. */
export declare const DEFAULT_AGENT_TIMEOUT_MS: null;
/** Finite logical wall-clock deadline for one workflow frame (30 minutes). */
export declare const DEFAULT_WORKFLOW_TIMEOUT_MS: number;
/** Maximum accepted workflow/agent deadline (24 hours). */
export declare const MAX_WORKFLOW_TIMEOUT_MS: number;
/** Maximum time spent draining cooperative provider attempts after logical close. */
export declare const WORKFLOW_DRAIN_GRACE_MS = 5000;
/** Maximum uninterrupted synchronous VM execution before yielding/aborting. */
export declare const VM_EXECUTION_TIMEOUT_MS = 1000;
/** Maximum concurrent agents (matches Claude Code limit). */
export declare const MAX_CONCURRENCY = 16;
/** Maximum automatic retry attempts after a recoverable agent failure. */
export declare const MAX_AGENT_RETRIES = 3;
/** Default token budget if none specified. */
export declare const DEFAULT_TOKEN_BUDGET: null;
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
