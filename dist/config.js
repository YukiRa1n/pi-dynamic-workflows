/**
 * Configuration constants for pi-dynamic-workflows.
 */
/** Maximum number of agents allowed per workflow run. */
export const MAX_AGENTS_PER_RUN = 1000;
/** Maximum number of items materialized by one parallel()/pipeline() fan-out. */
export const MAX_FANOUT_ITEMS = 10_000;
/** Maximum log entries retained by one workflow run. */
export const MAX_WORKFLOW_LOG_ENTRIES = 10_000;
/** Maximum UTF-8 bytes retained by one workflow run's logs. */
export const MAX_WORKFLOW_LOG_BYTES = 2 * 1024 * 1024;
/** Maximum UTF-8 bytes admitted to one provider-facing agent prompt. */
export const MAX_AGENT_PROMPT_BYTES = 512 * 1024;
/** Maximum complete JSON bytes published for one durable workflow record. */
export const MAX_DURABLE_RUN_BYTES = 16 * 1024 * 1024;
/** Default in-memory paused-run retention; persisted paused runs remain resumable. */
export const DEFAULT_MAX_PAUSED_RUNS_IN_MEMORY = 20;
/** Maximum members/tasks/messages retained by one workflow team by default. */
export const DEFAULT_MAX_TEAM_MEMBERS = 100;
/** Run-wide Agent Team state ceilings. */
export const MAX_TEAMS_PER_RUN = 32;
export const MAX_TEAM_MEMBERS_PER_RUN = 1000;
export const MAX_TEAM_TASKS_PER_RUN = 4000;
export const MAX_TEAM_MESSAGES_PER_RUN = 8192;
/** Manager-wide pending user-message high-water marks. */
export const MAX_PENDING_MESSAGES = 1024;
export const MAX_PENDING_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Non-evicting paused durable high-water marks; explicit prune is required. */
export const DEFAULT_MAX_PAUSED_RUNS_ON_DISK = 10_000;
export const DEFAULT_MAX_PAUSED_BYTES_ON_DISK = 1024 * 1024 * 1024;
export const DEFAULT_MAX_TEAM_TASKS = 2_000;
export const DEFAULT_MAX_TEAM_MESSAGES = 4_096;
/** SharedStore resource ceilings. Values are rejected before they enter the store. */
export const MAX_SHARED_STORE_KEYS = 2_048;
export const MAX_SHARED_STORE_KEY_BYTES = 4 * 1024;
export const MAX_SHARED_STORE_VALUE_BYTES = 256 * 1024;
export const MAX_SHARED_STORE_TOTAL_BYTES = 4 * 1024 * 1024;
/** Default timeout for a single agent in milliseconds. null means no per-agent hard timeout. */
export const DEFAULT_AGENT_TIMEOUT_MS = null;
/** Finite logical wall-clock deadline for one workflow frame (30 minutes). */
export const DEFAULT_WORKFLOW_TIMEOUT_MS = 30 * 60 * 1000;
/** Maximum accepted workflow/agent deadline (24 hours). */
export const MAX_WORKFLOW_TIMEOUT_MS = 24 * 60 * 60 * 1000;
/** Maximum time spent draining cooperative provider attempts after logical close. */
export const WORKFLOW_DRAIN_GRACE_MS = 5_000;
/** Maximum uninterrupted synchronous VM execution before yielding/aborting. */
export const VM_EXECUTION_TIMEOUT_MS = 1_000;
/** Maximum concurrent agents (matches Claude Code limit). */
export const MAX_CONCURRENCY = 16;
/** Maximum automatic retry attempts after a recoverable agent failure. */
export const MAX_AGENT_RETRIES = 3;
/** Default token budget if none specified. */
export const DEFAULT_TOKEN_BUDGET = null;
/** Legacy project-relative directory for persisted workflow run state. New writes use workflowProjectPaths(). */
export const WORKFLOW_RUNS_DIR = ".pi/workflows/runs";
/** Legacy project-relative directory for saved workflow commands. New writes use workflowProjectPaths(). */
export const WORKFLOW_SAVED_DIR = ".pi/workflows/saved";
/** User-level saved workflows directory. */
export const USER_WORKFLOW_SAVED_DIR = "~/.pi/workflows/saved";
/** User-level model tiers config file, relative to the home directory. */
export const MODEL_TIERS_FILE = ".pi/workflows/model-tiers.json";
/** User-level workflow extension settings file, relative to the home directory. */
export const WORKFLOW_SETTINGS_FILE = ".pi/workflows/settings.json";
/** Default keyword that arms workflows mode from interactive input. */
export const DEFAULT_KEYWORD_TRIGGER_WORD = "workflow";
/** Normalize a user-configured keyword trigger word. */
export function normalizeKeywordTriggerWord(value) {
    if (typeof value !== "string")
        return undefined;
    const word = value.trim();
    if (!word || word.startsWith("/") || /\s/.test(word))
        return undefined;
    return word;
}
/**
 * Named workflow subagent definitions directory. Resolved project-relative
 * (cwd/.pi/agents), plus user-level at `~/.pi/agent/agents/` (the primary
 * location, via `getAgentDir()` in agent-registry.ts) with the legacy
 * `~/.pi/agents/` (this constant, home-relative) scanned as a deprecated
 * fallback. Project entries win on name collision, then the primary user
 * location, then the legacy one. Each `*.md` file is an agent definition
 * (frontmatter + body prompt).
 */
export const AGENTS_DIR = ".pi/agents";
