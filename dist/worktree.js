/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged — the path is surfaced for
 * the caller to inspect. Falls back to a logged no-op when isolation isn't possible.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
function slug(name) {
    const readable = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "agent";
    // Keep a deterministic hash suffix: truncating only the readable prefix made
    // distinct long run/call identities collide in the same worktree path.
    const digest = createHash("sha256").update(name).digest("hex").slice(0, 10);
    return `${readable.slice(0, 21)}-${digest}`.slice(0, 32);
}
/**
 * Create an isolated worktree under `<repoRoot>/.pi/worktrees/<name>` on branch
 * `pi/wf/<name>`. The `name` must be deterministic (derived from runId + call index,
 * never wall-clock) so resume keys stay stable. Returns a no-op Worktree on any failure.
 */
export async function createWorktree(baseCwd, name) {
    const id = slug(name);
    let repoRoot;
    try {
        const { stdout } = await exec("git", ["-C", baseCwd, "rev-parse", "--show-toplevel"]);
        repoRoot = stdout.trim();
    }
    catch {
        return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
    }
    const path = join(repoRoot, ".pi", "worktrees", id);
    const branch = `pi/wf/${id}`;
    try {
        await exec("git", ["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"]);
        return { isolated: true, cwd: path, branch, repoRoot };
    }
    catch (error) {
        return { isolated: false, cwd: baseCwd, reason: error instanceof Error ? error.message : String(error) };
    }
}
/** Remove a worktree and its branch. Best-effort; safe to call on a no-op Worktree. */
export async function removeWorktree(wt) {
    if (!wt.isolated || !wt.repoRoot)
        return;
    try {
        await exec("git", ["-C", wt.repoRoot, "worktree", "remove", "--force", wt.cwd]);
    }
    catch {
        // already gone / locked — fall through
    }
    if (wt.branch) {
        try {
            await exec("git", ["-C", wt.repoRoot, "branch", "-D", wt.branch]);
        }
        catch {
            // branch already deleted
        }
    }
}
