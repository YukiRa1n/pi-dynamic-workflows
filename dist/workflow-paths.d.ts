/**
 * Filesystem layout for pi-dynamic-workflows state.
 *
 * New writes live under the user's workflow home so projects do not get
 * scattered `.pi/workflows` directories. Project-scoped state is still isolated
 * by a stable cwd-derived namespace.
 */
export declare const WORKFLOW_HOME_RELATIVE_DIR = ".pi/workflows";
export declare const WORKFLOW_PROJECTS_SUBDIR = "projects";
export interface WorkflowProjectPaths {
    key: string;
    rootDir: string;
    runsDir: string;
    savedDir: string;
    settingsPath: string;
    legacyRunsDir: string;
    legacySavedDir: string;
}
export declare function workflowHomeDir(): string;
export declare function workflowUserSavedDir(): string;
export declare function workflowProjectKey(cwd: string): string;
export declare function workflowProjectPaths(cwd: string): WorkflowProjectPaths;
