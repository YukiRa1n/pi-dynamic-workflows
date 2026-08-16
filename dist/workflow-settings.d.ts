/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */
export interface WorkflowSettings {
    /** Opaque persisted revision, exposed only so callers can opt into CAS saves. */
    revision?: number;
    keywordTriggerEnabled?: boolean;
    /** Literal keyword that arms workflows mode from interactive input. */
    keywordTriggerWord?: string;
    defaultAgentTimeoutMs?: number | null;
    /**
     * Default hard token budget applied to runs that don't pass their own
     * `tokenBudget` (#68). null explicitly means "no budget" (useful in a
     * project override to cancel a global budget); omitted also means no budget.
     */
    defaultTokenBudget?: number | null;
    /** Default max concurrent agents per run. Clamped to the runtime maximum. */
    defaultConcurrency?: number;
    /** Default retry attempts after recoverable agent failures. */
    defaultAgentRetries?: number;
    /** Bottom task-panel display mode: "compact" (default, one line per run) | "detailed". */
    progressPanelMode?: "compact" | "detailed";
    /** Max agents shown per phase in detailed progress mode (default 8). */
    progressPanelMaxAgents?: number;
    /**
     * Persist each workflow subagent transcript as a real pi session file under
     * the standard sessions directory (~/.pi/agent/sessions/<encoded-cwd>/),
     * keyed by the project cwd. Default false: subagent sessions stay in-memory
     * and only the compacted history embedded in the run JSON survives.
     */
    persistAgentSessions?: boolean;
    /**
     * Provider-visible terminal-result projection budget. The exact structured
     * result remains in the persisted run/pager and is linked from the delivery.
     */
    deliveredResultMaxChars?: number;
    /**
     * Extra tool names to deny in workflow subagent sessions, on top of the
     * built-in workflow-family defaults (#107). Use it to block
     * other recursive-orchestration tools you have installed (e.g. a pi-subagents
     * tool) so a subagent can't fan out through them.
     */
    excludeSubagentTools?: string[];
}
export interface WorkflowSettingsStore {
    load(): WorkflowSettings;
    save(settings: WorkflowSettings): void;
}
export interface WorkflowSettingsOptions {
    /** Explicit settings path, primarily for tests and migrations. */
    settingsPath?: string;
    /** Project cwd whose project-level settings should override global settings. */
    cwd?: string;
    /** Explicit project settings path, primarily for tests. */
    projectSettingsPath?: string;
    /** Save destination when using saveWorkflowSettings with cwd. Default: global. */
    scope?: "global" | "project";
    /** Reject the write if the persisted revision has changed since it was read. */
    expectedRevision?: number;
}
/** Path to the user-level workflow settings JSON file (~/.pi/workflows/settings.json). */
export declare function getWorkflowSettingsPath(): string;
/** Path to this project's optional workflow settings override. */
export declare function getWorkflowProjectSettingsPath(cwd: string): string;
/** Load settings from disk. Missing, corrupt, or invalid files resolve to {}. */
export declare function loadWorkflowSettings(settingsPathOrOptions?: string | WorkflowSettingsOptions): WorkflowSettings;
/** Merge known settings into the user-level settings file. */
export declare function saveWorkflowSettings(settings: WorkflowSettings, settingsPathOrOptions?: string | WorkflowSettingsOptions): void;
/** Save a global preference and update an existing project override if one is present. */
export declare function saveWorkflowSettingsForCwd(settings: WorkflowSettings, cwd: string): void;
