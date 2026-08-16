/**
 * Per-agent git worktree isolation. When an agent requests `isolation: "worktree"`,
 * it runs in a throwaway worktree on its own branch so parallel agents can edit the
 * same files without conflict. Results are NOT auto-merged — the path is surfaced for
 * the caller to inspect. Falls back to a logged no-op when isolation isn't possible.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
/** Git is an external cooperative resource. A stuck lock, hook, credential
 * helper, or network filesystem must not retain a Workflow promise forever. */
export const GIT_OPERATION_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const OWNER_FILE = ".pi-worktree-owner.json";
const CLAIMS_DIR = ".claims";
const RECLAIM_MARKER_SUFFIX = ".reclaim.json";
const CLAIM_STALE_AFTER_MS = 5 * 60_000;

type ReclaimMarker = {
  ownerToken: string;
  pid: number;
  createdAt: string;
  repoRoot: string;
  branch: string;
  path: string;
  state: "creating" | "metadata-failed" | "cleanup";
  reason?: string;
};

function execGit(args: string[]) {
  const launcher = process.env.PI_WORKFLOW_GIT_LAUNCHER?.trim();
  return exec(launcher ? process.execPath : "git", launcher ? [launcher, ...args] : args, {
    timeout: GIT_OPERATION_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: GIT_OUTPUT_LIMIT_BYTES,
    windowsHide: true,
  });
}

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
  /** Owner token written beside isolated worktree metadata. */
  ownerToken?: string;
}

export interface WorktreeRemovalResult {
  /** The owned checkout is gone, so no live execution can retain this directory. */
  checkoutRemoved: boolean;
  /** Checkout, branch, and durable reclaim marker were all removed. */
  complete: boolean;
}

function slug(name: string): string {
  const readable =
    name
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
export async function createWorktree(baseCwd: string, name: string): Promise<Worktree> {
  const id = slug(name);
  let repoRoot: string;
  try {
    const { stdout } = await execGit(["-C", baseCwd, "rev-parse", "--show-toplevel"]);
    repoRoot = stdout.trim();
  } catch {
    return { isolated: false, cwd: baseCwd, reason: "not a git repository" };
  }

  // A crashed worker can leave a missing worktree directory and stale git
  // administrative entry. Reap only those provably missing entries; existing
  // directories are left untouched because another process may still own them.
  await reapOrphanedWorktrees(repoRoot);
  const path = join(repoRoot, ".pi", "worktrees", id);
  const branch = `pi/wf/${id}`;
  const ownerToken = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${id}`;
  const reclaimMarker = writeReclaimMarker({
    ownerToken,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    repoRoot,
    branch,
    path,
    state: "creating",
  });
  if (!reclaimMarker) {
    return {
      isolated: false,
      cwd: baseCwd,
      repoRoot,
      branch,
      reason: "could not create durable worktree reclaim marker",
    };
  }
  try {
    await execGit(["-C", repoRoot, "worktree", "add", "-b", branch, path, "HEAD"]);
    try {
      // Store the branch marker first. If the sidecar write fails, the branch
      // marker is still enough to prove ownership to the fenced rollback path.
      await execGit(["-C", repoRoot, "config", `branch.${branch}.pi-worktree-owner`, ownerToken]);
      writeFileSync(
        join(path, ".pi-worktree-owner.json"),
        JSON.stringify({ ownerToken, pid: process.pid, createdAt: new Date().toISOString(), branch, path }),
        { encoding: "utf8", flag: "wx" },
      );
    } catch (metadataError) {
      // Keep the marker when rollback cannot prove ownership. The next startup
      // can retry the same owner-fenced cleanup instead of stranding an
      // otherwise unreachable worktree.
      updateReclaimMarker(reclaimMarker, {
        state: "metadata-failed",
        reason: metadataError instanceof Error ? metadataError.message : String(metadataError),
      });
      const rolledBack = await removeWorktreeInternal(
        { isolated: true, cwd: path, branch, repoRoot, ownerToken },
        { allowMissingMetadata: true, allowMissingBranchMarker: true },
      );
      if (rolledBack.complete) removeReclaimMarker(reclaimMarker);
      return {
        isolated: false,
        cwd: baseCwd,
        repoRoot,
        branch,
        reason: `owner metadata failed: ${String(metadataError)}`,
      };
    }
    // A failed unlink is harmless: the marker carries the complete metadata
    // proof, and startup reaping will remove only the marker in that case.
    removeReclaimMarker(reclaimMarker);
    return { isolated: true, cwd: path, branch, repoRoot, ownerToken };
  } catch (error) {
    removeReclaimMarker(reclaimMarker);
    // A failed add has no completed owner metadata. Even when the precheck saw
    // an absent path/branch, another creator may have won the race. The marker
    // is removed because this invocation did not establish a checkout; preserve
    // any ambiguous Git artifacts for a later owner-verified cleanup pass.
    return { isolated: false, cwd: baseCwd, reason: error instanceof Error ? error.message : String(error) };
  }
}

function reclaimMarkerPath(repoRoot: string, branch: string, ownerToken: string): string {
  return join(repoRoot, ".pi", "worktrees", CLAIMS_DIR, `${slug(`${branch}:${ownerToken}`)}${RECLAIM_MARKER_SUFFIX}`);
}

function writeReclaimMarker(marker: ReclaimMarker): string | null {
  const markerPath = reclaimMarkerPath(marker.repoRoot, marker.branch, marker.ownerToken);
  try {
    mkdirSync(join(marker.repoRoot, ".pi", "worktrees", CLAIMS_DIR), { recursive: true });
    writeFileSync(markerPath, JSON.stringify(marker), { encoding: "utf8", flag: "wx" });
    return markerPath;
  } catch {
    return null;
  }
}

/**
 * Establish a durable owner-fenced cleanup intent before mutating the
 * worktree. A failed cleanup must remain discoverable on the next startup;
 * reusing an existing marker also makes retries idempotent.
 */
function ensureCleanupReclaimMarker(wt: Worktree): string | null {
  if (!wt.repoRoot || !wt.branch || !wt.ownerToken || !isManagedWorktreePath(wt.repoRoot, wt.cwd)) return null;
  const markerPath = reclaimMarkerPath(wt.repoRoot, wt.branch, wt.ownerToken);
  const matches = (marker: ReclaimMarker) =>
    marker.ownerToken === wt.ownerToken &&
    resolve(marker.repoRoot) === resolve(wt.repoRoot as string) &&
    marker.branch === wt.branch &&
    resolve(marker.path) === resolve(wt.cwd);
  const existing = readReclaimMarker(markerPath);
  if (existing) {
    if (!matches(existing)) return null;
    updateReclaimMarker(markerPath, { state: "cleanup" });
    const updated = readReclaimMarker(markerPath);
    return updated && updated.state === "cleanup" && matches(updated) ? markerPath : null;
  }
  const created = writeReclaimMarker({
    ownerToken: wt.ownerToken,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    repoRoot: wt.repoRoot,
    branch: wt.branch,
    path: wt.cwd,
    state: "cleanup",
  });
  if (!created) return null;
  const written = readReclaimMarker(created);
  return written && written.state === "cleanup" && matches(written) ? created : null;
}

function updateReclaimMarker(markerPath: string, update: Partial<Pick<ReclaimMarker, "state" | "reason">>): void {
  try {
    const current = JSON.parse(readFileSync(markerPath, "utf8")) as ReclaimMarker;
    writeFileSync(markerPath, JSON.stringify({ ...current, ...update }), "utf8");
  } catch {
    // The original marker remains the safer fallback if the diagnostic update
    // itself cannot be written.
  }
}

function removeReclaimMarker(markerPath: string): boolean {
  try {
    unlinkSync(markerPath);
    return true;
  } catch {
    return false;
  }
}

function readReclaimMarker(markerPath: string): ReclaimMarker | null {
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as Partial<ReclaimMarker>;
    if (
      typeof marker.ownerToken !== "string" ||
      !Number.isInteger(marker.pid) ||
      typeof marker.repoRoot !== "string" ||
      typeof marker.branch !== "string" ||
      typeof marker.path !== "string" ||
      (marker.state !== "creating" && marker.state !== "metadata-failed" && marker.state !== "cleanup")
    ) {
      return null;
    }
    return marker as ReclaimMarker;
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this user cannot signal it. It must
    // not be mistaken for a stale owner.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function markerIsStale(markerPath: string, marker: ReclaimMarker): boolean {
  if (processIsAlive(marker.pid)) return false;
  try {
    return Date.now() - statSync(markerPath).mtimeMs >= CLAIM_STALE_AFTER_MS;
  } catch {
    return false;
  }
}

function listReclaimMarkers(repoRoot: string): string[] {
  const claims = join(repoRoot, ".pi", "worktrees", CLAIMS_DIR);
  try {
    return readdirSync(claims)
      .filter((name) => name.endsWith(RECLAIM_MARKER_SUFFIX))
      .map((name) => join(claims, name));
  } catch {
    return [];
  }
}

async function reapReclaimMarkers(repoRoot: string): Promise<number> {
  let reaped = 0;
  for (const markerPath of listReclaimMarkers(repoRoot)) {
    const marker = readReclaimMarker(markerPath);
    if (!marker || resolve(marker.repoRoot) !== resolve(repoRoot) || !markerIsStale(markerPath, marker)) continue;
    if (!marker.branch.startsWith("pi/wf/") || !isManagedWorktreePath(repoRoot, marker.path)) continue;

    const candidate: Worktree = {
      isolated: true,
      cwd: resolve(marker.path),
      repoRoot,
      branch: marker.branch,
      ownerToken: marker.ownerToken,
    };
    const branchMarker = await branchOwner(repoRoot, marker.branch);
    const sidecarProof = sidecarOwnedBy(candidate.cwd, marker.ownerToken);

    // If creation completed and only marker unlink failed, never tear down a
    // healthy worktree. The two independent metadata proofs are authoritative;
    // the stale marker itself is the only artifact to reclaim.
    if (marker.state !== "cleanup" && branchMarker === marker.ownerToken && sidecarProof) {
      if (removeReclaimMarker(markerPath)) continue;
    }

    if (!(await isRegisteredWorktree(candidate))) {
      // A crash during `worktree add` can leave the branch without a registered
      // checkout. Delete it only with the marker's owner proof (or when it is
      // already gone), then discard the marker.
      if (
        !(await branchExists(repoRoot, marker.branch)) ||
        (await deleteOwnedBranch(repoRoot, marker.branch, marker.ownerToken, true))
      ) {
        if (removeReclaimMarker(markerPath)) reaped++;
      }
      continue;
    }

    const removed = await removeWorktreeInternal(candidate, {
      allowMissingMetadata: true,
      allowMissingBranchMarker: true,
    });
    if (removed.complete) {
      const remaining = readReclaimMarker(markerPath);
      if (!remaining) {
        reaped++;
      } else if (
        remaining.ownerToken === marker.ownerToken &&
        remaining.branch === marker.branch &&
        resolve(remaining.repoRoot) === resolve(repoRoot) &&
        resolve(remaining.path) === resolve(marker.path) &&
        removeReclaimMarker(markerPath)
      ) {
        reaped++;
      }
    }
  }
  return reaped;
}

/** Reap provably orphaned workflow worktrees at startup. */
export async function reapOrphanedWorktrees(repoRoot: string): Promise<number> {
  const worktreeRoot = resolve(join(repoRoot, ".pi", "worktrees"));
  let stdout: string;
  try {
    ({ stdout } = await execGit(["-C", repoRoot, "worktree", "list", "--porcelain"]));
  } catch {
    return 0;
  }
  const records = stdout.split(/\n(?=worktree )/g);
  let reaped = 0;
  for (const record of records) {
    const worktreeLine = record.match(/^worktree (.+)$/m);
    const branchLine = record.match(/^branch refs\/heads\/(pi\/wf\/.+)$/m);
    if (!worktreeLine || !branchLine) continue;
    const worktreePath = resolve(worktreeLine[1].trim());
    const rel = relative(worktreeRoot, worktreePath);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || existsSync(worktreePath)) continue;
    // Missing paths have no sidecar to prove ownership. The durable Git branch
    // marker written by createWorktree is the remaining ownership proof;
    // manual pi/wf branches are never reaped.
    let ownerToken: string;
    try {
      const marker = await execGit(["-C", repoRoot, "config", "--get", `branch.${branchLine[1]}.pi-worktree-owner`]);
      ownerToken = marker.stdout.trim();
      if (!ownerToken) continue;
    } catch {
      continue;
    }
    const candidate: Worktree = {
      isolated: true,
      cwd: worktreePath,
      repoRoot,
      branch: branchLine[1],
      ownerToken,
    };
    const claim = claimPath(repoRoot, candidate);
    try {
      if (!claim || !(await ownedByInvocation(candidate))) continue;
      // Re-read the marker after claiming; a new owner may have replaced it
      // since the startup scan.
      const fresh = await execGit(["-C", repoRoot, "config", "--get", `branch.${branchLine[1]}.pi-worktree-owner`]);
      if (fresh.stdout.trim() !== ownerToken) continue;
      await execGit(["-C", repoRoot, "worktree", "prune", "--expire", "now"]);
      // Rename the canonical branch into an owner-specific tombstone before
      // deleting it. A replacement creator can then use the canonical name
      // without the old cleanup ever deleting the replacement branch.
      if (await deleteOwnedBranch(repoRoot, branchLine[1], ownerToken)) reaped++;
    } catch {
      // A concurrent owner or corrupt metadata is left for a later pass.
    } finally {
      releaseClaim(claim);
    }
  }
  reaped += await reapReclaimMarkers(repoRoot);
  return reaped;
}

/** A short-lived invocation claim. It serializes cleanup attempts for the
 * exact path/branch without treating a stale precheck as ownership. */
function claimPath(repoRoot: string, wt: Worktree): string | null {
  if (!wt.branch || !wt.ownerToken) return null;
  const claims = join(repoRoot, ".pi", "worktrees", CLAIMS_DIR);
  const path = join(claims, `${slug(`${wt.branch}:${wt.cwd}`)}.claim`);
  let fd: number | undefined;
  let created = false;
  let committed = false;
  try {
    mkdirSync(claims, { recursive: true });
    try {
      fd = openSync(path, "wx");
    } catch {
      // A crashed cleanup can strand its short-lived claim. Reclaim only a
      // claim whose owner is demonstrably gone and whose record is old enough
      // that a slow git operation cannot be mistaken for a crash.
      if (!reclaimStaleClaim(path)) return null;
      fd = openSync(path, "wx");
    }
    created = true;
    writeFileSync(
      fd,
      JSON.stringify({ ownerToken: wt.ownerToken, pid: process.pid, createdAt: new Date().toISOString() }),
      "utf8",
    );
    committed = true;
    return path;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor may already be closed by an interrupted filesystem
        // operation; either way, never retain it across a cleanup attempt.
      }
    }
    if (created && !committed) {
      try {
        unlinkSync(path);
      } catch {
        // A concurrent stale-claim reaper may already have removed it.
      }
    }
  }
}

function reclaimStaleClaim(path: string): boolean {
  let metadata: { pid?: number };
  let mtimeMs: number;
  try {
    metadata = JSON.parse(readFileSync(path, "utf8")) as { pid?: number };
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (typeof metadata.pid === "number" && processIsAlive(metadata.pid)) return false;
  if (Date.now() - mtimeMs < CLAIM_STALE_AFTER_MS) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function releaseClaim(path: string | null): void {
  if (!path) return;
  try {
    unlinkSync(path);
  } catch {
    // Another cleanup invocation may have reclaimed the claim.
  }
}

function isManagedWorktreePath(repoRoot: string, path: string): boolean {
  const root = resolve(join(repoRoot, ".pi", "worktrees"));
  const rel = relative(root, resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sidecarOwnedBy(path: string, ownerToken: string): boolean {
  try {
    const metadata = JSON.parse(readFileSync(join(path, OWNER_FILE), "utf8")) as { ownerToken?: string };
    return metadata.ownerToken === ownerToken;
  } catch {
    return false;
  }
}

type DirectoryClaim = { original: string; claimed: string; moved: boolean };

/** Atomically move the directory object away from its canonical path. Any
 * replacement created after this rename remains at the original path and can
 * never be consumed by the old owner's git worktree remove. */
function claimWorktreeDirectory(wt: Worktree): DirectoryClaim | null {
  if (!wt.repoRoot || !wt.ownerToken || !isManagedWorktreePath(wt.repoRoot, wt.cwd)) return null;
  const claimed = `${wt.cwd}.pi-cleanup-${slug(wt.ownerToken)}`;
  if (existsSync(claimed)) return null;
  try {
    renameSync(wt.cwd, claimed);
    return { original: wt.cwd, claimed, moved: true };
  } catch {
    return null;
  }
}

async function restoreWorktreeDirectory(repoRoot: string, claim: DirectoryClaim): Promise<void> {
  if (!claim.moved || !existsSync(claim.claimed) || existsSync(claim.original)) return;
  try {
    renameSync(claim.claimed, claim.original);
    claim.moved = false;
    await execGit(["-C", repoRoot, "worktree", "repair", claim.original]);
  } catch {
    // Preserve the claimed directory when restoration cannot be proven safe.
  }
}

async function branchOwner(repoRoot: string, branch: string): Promise<string | null> {
  try {
    const marker = await execGit(["-C", repoRoot, "config", "--get", `branch.${branch}.pi-worktree-owner`]);
    return marker.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await execGit(["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function restoreClaimedBranch(repoRoot: string, claimedBranch: string, originalBranch: string): Promise<void> {
  if (!(await branchExists(repoRoot, claimedBranch)) || (await branchExists(repoRoot, originalBranch))) return;
  try {
    await execGit(["-C", repoRoot, "branch", "-m", claimedBranch, originalBranch]);
  } catch {
    // Preserve the owner-specific tombstone rather than risk overwriting a
    // concurrently recreated canonical branch.
  }
}

/** Move the branch name/config into an owner-specific tombstone, verify the
 * marker that moved with it, then delete only that tombstone. */
async function deleteOwnedBranch(
  repoRoot: string,
  branch: string,
  ownerToken: string,
  allowMissingMarker = false,
): Promise<boolean> {
  const originalOwner = await branchOwner(repoRoot, branch);
  if (originalOwner !== ownerToken && !(allowMissingMarker && originalOwner === null)) return false;
  if (!(await branchExists(repoRoot, branch))) return true;
  const claimedBranch = `pi/wf-cleanup/${slug(`${branch}:${ownerToken}`)}`;
  if (await branchExists(repoRoot, claimedBranch)) return false;
  try {
    await execGit(["-C", repoRoot, "branch", "-m", branch, claimedBranch]);
  } catch {
    return false;
  }
  const claimedOwner = await branchOwner(repoRoot, claimedBranch);
  if (claimedOwner !== ownerToken && !(allowMissingMarker && originalOwner === null && claimedOwner === null)) {
    await restoreClaimedBranch(repoRoot, claimedBranch, branch);
    return false;
  }
  try {
    await execGit(["-C", repoRoot, "branch", "-D", claimedBranch]);
  } catch {
    await restoreClaimedBranch(repoRoot, claimedBranch, branch);
    return false;
  }
  return !(await branchExists(repoRoot, claimedBranch));
}

async function isRegisteredWorktree(wt: Worktree): Promise<boolean> {
  if (!wt.repoRoot || !wt.branch) return false;
  try {
    const listed = await execGit(["-C", wt.repoRoot, "worktree", "list", "--porcelain"]);
    const normalized = (value: string) => value.replaceAll("\\", "/").toLowerCase();
    return (
      normalized(listed.stdout).includes(`worktree ${normalized(wt.cwd)}`) &&
      listed.stdout.includes(`branch refs/heads/${wt.branch}`)
    );
  } catch {
    return false;
  }
}

type OwnershipOptions = {
  allowMissingMetadata?: boolean;
  allowMissingBranchMarker?: boolean;
};

async function ownedByInvocation(wt: Worktree, options: OwnershipOptions = {}): Promise<boolean> {
  if (!wt.repoRoot || !wt.branch || !wt.ownerToken) return false;
  if (existsSync(wt.cwd)) {
    const sidecarPath = join(wt.cwd, OWNER_FILE);
    if (existsSync(sidecarPath)) {
      if (!sidecarOwnedBy(wt.cwd, wt.ownerToken)) return false;
    } else if (!options.allowMissingMetadata) {
      return false;
    }
  }
  const markerOwner = await branchOwner(wt.repoRoot, wt.branch);
  if (markerOwner !== wt.ownerToken && !(options.allowMissingBranchMarker && markerOwner === null)) return false;
  return isRegisteredWorktree(wt);
}

/** Remove a worktree and its branch. Best-effort and fail-closed on ownership races. */
export async function removeWorktree(wt: Worktree): Promise<boolean> {
  return (await removeWorktreeInternal(wt)).complete;
}

/**
 * Remove a worktree while distinguishing a released checkout from branch
 * cleanup that remains durably scheduled. Callers use this to release active
 * in-memory ownership without pretending a retained reclaim marker is complete.
 */
export async function removeWorktreeDetailed(wt: Worktree): Promise<WorktreeRemovalResult> {
  return removeWorktreeInternal(wt);
}

async function removeWorktreeInternal(wt: Worktree, options: OwnershipOptions = {}): Promise<WorktreeRemovalResult> {
  if (!wt.isolated || !wt.repoRoot) return { checkoutRemoved: true, complete: true };
  const branch = wt.branch;
  const claim = claimPath(wt.repoRoot, wt);
  if (!branch || !claim || !(await ownedByInvocation(wt, options))) {
    releaseClaim(claim);
    return { checkoutRemoved: false, complete: false };
  }
  let directoryClaim: DirectoryClaim | null = null;
  try {
    // A read/recheck cannot fence a replacement between stat and deletion.
    // Atomically move the directory object first, then validate the sidecar in
    // the moved object. Replacements at the canonical path are now independent.
    if (!(await ownedByInvocation(wt, options))) return { checkoutRemoved: false, complete: false };
    // Persist the cleanup intent before removing the checkout. If this cannot
    // be made durable, leave the worktree intact rather than creating an
    // unreachable branch after a later branch-delete failure.
    const cleanupMarker = ensureCleanupReclaimMarker(wt);
    if (!cleanupMarker) return { checkoutRemoved: false, complete: false };
    let worktreeRemoved = !existsSync(wt.cwd);
    if (!worktreeRemoved) {
      directoryClaim = claimWorktreeDirectory(wt);
      const claimedSidecarExists = directoryClaim ? existsSync(join(directoryClaim.claimed, OWNER_FILE)) : false;
      if (
        !directoryClaim ||
        (claimedSidecarExists && !sidecarOwnedBy(directoryClaim.claimed, wt.ownerToken as string)) ||
        (!claimedSidecarExists && !options.allowMissingMetadata)
      ) {
        if (directoryClaim) await restoreWorktreeDirectory(wt.repoRoot, directoryClaim);
        return { checkoutRemoved: false, complete: false };
      }
      const claimedWorktree = { ...wt, cwd: directoryClaim.claimed };
      try {
        await execGit(["-C", wt.repoRoot, "worktree", "repair", directoryClaim.claimed]);
        if (!(await ownedByInvocation(claimedWorktree, options))) {
          await restoreWorktreeDirectory(wt.repoRoot, directoryClaim);
          return { checkoutRemoved: false, complete: false };
        }
        await execGit(["-C", wt.repoRoot, "worktree", "remove", "--force", directoryClaim.claimed]);
      } catch {
        await restoreWorktreeDirectory(wt.repoRoot, directoryClaim);
        return { checkoutRemoved: false, complete: false };
      }
      worktreeRemoved = !existsSync(directoryClaim.claimed);
      if (worktreeRemoved) directoryClaim.moved = false;
    } else {
      // Prune only after the invocation claim and ownership proof; never use a
      // stale startup precheck as authority for a global prune.
      try {
        await execGit(["-C", wt.repoRoot, "worktree", "prune", "--expire", "now"]);
      } catch {
        return { checkoutRemoved: false, complete: false };
      }
      worktreeRemoved = !(await ownedByInvocation(wt, options));
    }
    if (!worktreeRemoved) return { checkoutRemoved: false, complete: false };
    const branchRemoved = await deleteOwnedBranch(
      wt.repoRoot,
      branch,
      wt.ownerToken as string,
      options.allowMissingBranchMarker,
    );
    if (branchRemoved) removeReclaimMarker(cleanupMarker);
    return { checkoutRemoved: true, complete: branchRemoved };
  } finally {
    if (directoryClaim?.moved) await restoreWorktreeDirectory(wt.repoRoot, directoryClaim);
    releaseClaim(claim);
  }
}
