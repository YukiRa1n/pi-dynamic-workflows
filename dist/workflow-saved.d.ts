/**
 * Save and load reusable workflow commands.
 */
import { type PersistenceFsLayer } from "./fs-persistence.js";
export interface SavedWorkflow {
    /** Command name (filename without extension). */
    name: string;
    /** Human-readable description. */
    description: string;
    /** The workflow script. */
    script: string;
    /** Optional parameter schema for parameterized workflows. */
    parameters?: Record<string, {
        type: string;
        description?: string;
        required?: boolean;
        default?: unknown;
    }>;
    /** Where this workflow is saved. */
    location: "project" | "user";
    /** Full file path. */
    path: string;
    /** When it was saved. */
    savedAt: string;
}
export interface WorkflowStorage {
    /** Save a workflow. */
    save(workflow: Omit<SavedWorkflow, "path" | "savedAt">, location?: "project" | "user"): SavedWorkflow;
    /** Load a workflow by name. */
    load(name: string): SavedWorkflow | null;
    /** List all saved workflows. */
    list(): SavedWorkflow[];
    /** Delete a saved workflow. */
    delete(name: string, location?: "project" | "user"): boolean;
}
/**
 * Names are eventually used as `${name}.json` on both POSIX and Windows.
 * Keep the accepted language deliberately narrower than either filesystem's
 * filename language: Windows alternate data streams (`:`), device names, and
 * names whose trailing dot/space is silently stripped must not be accepted on
 * one host and become a different record on another.
 */
export declare function isSafeSavedWorkflowName(name: string): boolean;
export declare function assertSafeSavedWorkflowName(name: string): void;
export declare function createWorkflowStorage(cwd: string, fsOverride?: Partial<PersistenceFsLayer>): WorkflowStorage;
