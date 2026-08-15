/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged — the path is surfaced for
 * the caller to inspect. Falls back to a logged no-op when isolation isn't possible.
 */
export interface Worktree {
    /** True when a real worktree was created; false means "ran in the shared tree". */
    isolated: boolean;
    /** cwd the agent should run in (worktree path when isolated, else the base cwd). */
    cwd: string;
    branch?: string;
    /** Repo root the worktree was added to (for teardown). */
    repoRoot?: string;
    /** Why isolation was skipped, when isolated === false. */
    reason?: string;
}
/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. The `name` must be deterministic (derived from runId + call index,
 * never wall-clock) so resume keys stay stable. Returns a no-op Worktree on any failure.
 */
export declare function createWorktree(baseCwd: string, name: string): Promise<Worktree>;
/** Reap provably orphaned workflow worktrees at startup. */
export declare function reapOrphanedWorktrees(repoRoot: string): Promise<number>;
/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export declare function removeWorktree(wt: Worktree): Promise<void>;
