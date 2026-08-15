/**
 * Workflow logger with file persistence.
 */
export interface WorkflowLogger {
    log(message: string): void;
    error(message: string): void;
    warn(message: string): void;
    getLogs(): string[];
    persist(): string | null;
}
export interface WorkflowLoggerOptions {
    /** Run ID for persistence. */
    runId?: string;
    /** Working directory for file paths. */
    cwd?: string;
    /** Whether to persist logs to disk. */
    persist?: boolean;
    /** Callback for each log entry. */
    onLog?: (message: string) => void;
}
export declare function createWorkflowLogger(options?: WorkflowLoggerOptions): WorkflowLogger;
