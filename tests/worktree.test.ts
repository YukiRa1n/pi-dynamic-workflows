import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createWorktree as createWorktreeLive,
  reapOrphanedWorktrees,
  removeWorktree,
  removeWorktreeDetailed,
} from "../src/worktree.js";

const REAL_GIT = (() => {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const paths = execFileSync(command, ["git"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  return paths.find((path) => process.platform !== "win32" || path.toLowerCase().endsWith(".exe")) ?? paths[0];
})();

async function withGitRace(
  mode:
    | "replace-sidecar-before-remove"
    | "recreate-canonical-after-branch-claim"
    | "fail-owner-config"
    | "break-sidecar"
    | "fail-branch-delete"
    | "replace-reclaim-marker-with-directory",
  environment: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  assert.ok(REAL_GIT, "tests require a real git executable");
  const wrapper = mkdtempSync(join(tmpdir(), "pi-wt-git-race-"));
  const script = join(wrapper, "git-race.mjs");
  writeFileSync(
    script,
    `import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const realGit = process.env.PI_REAL_GIT;
const invoke = (next) => spawnSync(realGit, next, { stdio: "inherit", windowsHide: true });
const repoIndex = args.indexOf("-C");
const repo = repoIndex >= 0 ? args[repoIndex + 1] : process.cwd();
const mode = process.env.PI_WT_RACE_MODE;

if (mode === "fail-owner-config" && args.includes("config") && args.some((arg) => arg.includes("pi-worktree-owner"))) {
  process.exit(1);
}

if (mode === "fail-branch-delete" && args.includes("branch") && args.includes("-D")) {
  process.exit(1);
}

if (
  mode === "replace-reclaim-marker-with-directory" &&
  args.includes("config") &&
  args.includes("--get") &&
  args.some((arg) => arg.includes("pi-worktree-owner"))
) {
  const result = invoke(args);
  const marker = process.env.PI_WT_RECLAIM_MARKER;
  rmSync(marker, { force: true });
  mkdirSync(marker, { recursive: true });
  process.exit(result.status ?? 1);
}

if (mode === "break-sidecar" && args.includes("worktree") && args.includes("add")) {
  const result = invoke(args);
  if (result.status === 0) {
    const addIndex = args.indexOf("add");
    const worktreePath = args[addIndex + 3];
    mkdirSync(worktreePath + "/.pi-worktree-owner.json", { recursive: true });
  }
  process.exit(result.status ?? 1);
}

if (mode === "replace-sidecar-before-remove" && args.includes("worktree") && args.includes("remove")) {
  const original = process.env.PI_WT_ORIGINAL_PATH;
  mkdirSync(original, { recursive: true });
  writeFileSync(
    original + "/.pi-worktree-owner.json",
    JSON.stringify({ ownerToken: process.env.PI_WT_REPLACEMENT_OWNER, branch: process.env.PI_WT_ORIGINAL_BRANCH }),
  );
}

if (
  mode === "recreate-canonical-after-branch-claim" &&
  args.includes("branch") &&
  args.includes("-m") &&
  args[args.indexOf("-m") + 1] === process.env.PI_WT_ORIGINAL_BRANCH
) {
  const result = invoke(args);
  if (result.status === 0) {
    invoke(["-C", repo, "branch", process.env.PI_WT_ORIGINAL_BRANCH, "HEAD"]);
    invoke([
      "-C",
      repo,
      "config",
      "branch." + process.env.PI_WT_ORIGINAL_BRANCH + ".pi-worktree-owner",
      process.env.PI_WT_REPLACEMENT_OWNER,
    ]);
  }
  process.exit(result.status ?? 1);
}

const result = invoke(args);
process.exit(result.status ?? 1);
`,
  );
  const original = {
    launcher: process.env.PI_WORKFLOW_GIT_LAUNCHER,
    values: new Map(Object.keys(environment).map((key) => [key, process.env[key]])),
  };
  process.env.PI_WORKFLOW_GIT_LAUNCHER = script;
  process.env.PI_REAL_GIT = REAL_GIT;
  process.env.PI_WT_RACE_MODE = mode;
  for (const [key, value] of Object.entries(environment)) process.env[key] = value;
  try {
    await run();
  } finally {
    if (original.launcher === undefined) delete process.env.PI_WORKFLOW_GIT_LAUNCHER;
    else process.env.PI_WORKFLOW_GIT_LAUNCHER = original.launcher;
    delete process.env.PI_REAL_GIT;
    delete process.env.PI_WT_RACE_MODE;
    for (const [key, value] of original.values) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(wrapper, { recursive: true, force: true });
  }
}

function expectedClaimPath(repo: string, wt: { branch?: string; cwd: string }): string {
  const name = `${wt.branch}:${wt.cwd}`;
  const readable =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 10);
  const id = `${readable.slice(0, 21)}-${digest}`.slice(0, 32);
  return join(repo, ".pi", "worktrees", ".claims", `${id}.claim`);
}

function expectedWorktreePath(repo: string, name: string): string {
  const readable =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 10);
  const id = `${readable.slice(0, 21)}-${digest}`.slice(0, 32);
  return join(repo, ".pi", "worktrees", id);
}

function expectedReclaimMarkerPath(repo: string, branch: string, ownerToken: string): string {
  const name = `${branch}:${ownerToken}`;
  const readable =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "agent";
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 10);
  const id = `${readable.slice(0, 21)}-${digest}`.slice(0, 32);
  return join(repo, ".pi", "worktrees", ".claims", `${id}.reclaim.json`);
}

// ── Existing tests (unchanged) ──

test("createWorktree no-ops (not isolated) outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-nogit-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.match(wt.reason ?? "", /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorktree isolates in a git repo, then removeWorktree cleans up", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-9-0-edit");
    assert.equal(wt.isolated, true);
    assert.ok(wt.cwd !== repo && existsSync(wt.cwd), "worktree dir exists");
    assert.ok(existsSync(join(wt.cwd, "file.txt")), "worktree has a checkout");

    // Editing inside the worktree must not touch the base tree.
    writeFileSync(join(wt.cwd, "file.txt"), "changed in worktree\n");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.equal(branches.trim(), "", "branch deleted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree leaves an owner-fenced reclaim marker when branch deletion fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-branch-reclaim-"));
  const git = (...args: string[]) => execFileSync(REAL_GIT, ["-C", repo, ...args], { stdio: "pipe" });
  let worktree: Awaited<ReturnType<typeof createWorktreeLive>> | undefined;
  let markerPath = "";
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    await withGitRace("fail-branch-delete", {}, async () => {
      worktree = await createWorktreeLive(repo, "branch-delete-reclaim");
      assert.equal(worktree.isolated, true);
      assert.deepEqual(await removeWorktreeDetailed(worktree), {
        checkoutRemoved: true,
        complete: false,
      });
      assert.equal(existsSync(worktree.cwd), false, "the checkout was removed before branch deletion failed");
      assert.notEqual(
        git("branch", "--list", worktree.branch ?? "")
          .toString("utf8")
          .trim(),
        "",
      );

      const claims = join(repo, ".pi", "worktrees", ".claims");
      const markers = readdirSync(claims).filter((name) => name.endsWith(".reclaim.json"));
      assert.equal(markers.length, 1, "branch cleanup must leave one durable reclaim marker");
      markerPath = join(claims, markers[0]);
      const marker = JSON.parse(readFileSync(markerPath, "utf8")) as { ownerToken?: string; state?: string };
      assert.equal(marker.ownerToken, worktree.ownerToken);
      assert.equal(marker.state, "cleanup");
    });

    // Simulate the owner process having exited before startup reaping.
    const staleMarker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    staleMarker.pid = 2_147_483_647;
    writeFileSync(markerPath, JSON.stringify(staleMarker), "utf8");
    const staleAt = new Date(Date.now() - 10 * 60_000);
    utimesSync(markerPath, staleAt, staleAt);

    assert.equal(await reapOrphanedWorktrees(repo), 1, "startup reaping retries the owner-fenced branch cleanup");
    assert.equal(
      git("branch", "--list", worktree?.branch ?? "")
        .toString("utf8")
        .trim(),
      "",
    );
    assert.equal(existsSync(markerPath), false, "the marker is removed only after the branch is gone");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("startup reaping never removes a healthy worktree when stale marker unlink fails", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-marker-unlink-"));
  const git = (...args: string[]) => execFileSync(REAL_GIT, ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const worktree = await createWorktreeLive(repo, "healthy-marker-unlink");
    assert.equal(worktree.isolated, true);
    assert.ok(worktree.branch && worktree.ownerToken);
    const markerPath = expectedReclaimMarkerPath(repo, worktree.branch, worktree.ownerToken);
    mkdirSync(join(repo, ".pi", "worktrees", ".claims"), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({
        ownerToken: worktree.ownerToken,
        pid: 2_147_483_647,
        createdAt: new Date().toISOString(),
        repoRoot: repo,
        branch: worktree.branch,
        path: worktree.cwd,
        state: "creating",
      }),
      "utf8",
    );
    const staleAt = new Date(Date.now() - 10 * 60_000);
    utimesSync(markerPath, staleAt, staleAt);

    await withGitRace("replace-reclaim-marker-with-directory", { PI_WT_RECLAIM_MARKER: markerPath }, async () => {
      assert.equal(await reapOrphanedWorktrees(repo), 0, "failed marker cleanup is retained for a later retry");
    });

    assert.equal(existsSync(worktree.cwd), true, "healthy checkout is preserved");
    assert.notEqual(git("branch", "--list", worktree.branch).toString("utf8").trim(), "", "branch is preserved");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── NEW TESTS ──

test("startup reaping removes missing workflow worktree metadata and its branch", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-reap-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const wt = await createWorktreeLive(repo, "orphaned-run");
    assert.equal(wt.isolated, true);
    rmSync(wt.cwd, { recursive: true, force: true });
    const reaped = await reapOrphanedWorktrees(repo);
    assert.equal(reaped, 1);
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.equal(branches.trim(), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree falls back when git fails (non-git directory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-noexec-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");

    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.ok(wt.reason, "should provide a fallback reason when git fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when worktree directory is already missing", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-missing-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-missing-dir");
    assert.equal(wt.isolated, true);

    // Remove the worktree directory so git worktree remove --force fails
    rmSync(wt.cwd, { recursive: true, force: true });
    assert.ok(!existsSync(wt.cwd), "worktree dir removed manually before removeWorktree");

    // removeWorktree must not throw despite git commands failing
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree avoids a legacy unsuffixed branch collision with its deterministic hash suffix", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-conflict-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    // Pre-create the branch that createWorktree will try to create.
    // slug("conflict-branch") → "conflict-branch"
    const name = "conflict-branch";
    git("branch", "pi/wf/conflict-branch");

    // The current branch name carries a deterministic hash suffix, so the old
    // unsuffixed branch cannot collide and isolation still succeeds.
    const wt = await createWorktreeLive(repo, name);
    assert.equal(wt.isolated, true);
    assert.notEqual(wt.cwd, repo);
    assert.match(wt.branch ?? "", /^pi\/wf\/conflict-branch-[a-f0-9]+$/);
    await removeWorktree(wt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when git operations fail (corrupted metadata)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-failrm-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-fail-rm");
    assert.equal(wt.isolated, true);

    // Remove worktree dir so git worktree remove fails
    rmSync(wt.cwd, { recursive: true, force: true });

    // Corrupt git worktree metadata so git worktree remove --force also fails
    const branchSuffix = wt.branch?.replace("pi/wf/", "") ?? "";
    const worktreeMeta = join(repo, ".git", "worktrees", branchSuffix);
    if (existsSync(worktreeMeta)) {
      writeFileSync(join(worktreeMeta, "gitdir"), "/nonexistent/path\n");
    }

    // Both git operations should fail silently — no throw from removeWorktree
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree rolls back the checkout when branch ownership metadata cannot be written", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-metadata-rollback-"));
  const git = (...args: string[]) => execFileSync(REAL_GIT, ["-C", repo, ...args], { stdio: "pipe" });
  let created: { isolated: boolean; cwd: string; branch?: string } | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    await withGitRace("fail-owner-config", {}, async () => {
      created = await createWorktreeLive(repo, "metadata-rollback");
    });

    assert.equal(created?.isolated, false, "metadata failure must not report an isolated checkout");
    assert.ok(created?.branch);
    assert.equal(
      existsSync(expectedWorktreePath(repo, "metadata-rollback")),
      false,
      "rollback removes the just-created worktree",
    );
    assert.equal(
      git("branch", "--list", created?.branch ?? "")
        .toString("utf8")
        .trim(),
      "",
      "rollback removes the branch",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree leaves a reclaim marker when sidecar metadata is not owner-verifiable", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-metadata-marker-"));
  const git = (...args: string[]) => execFileSync(REAL_GIT, ["-C", repo, ...args], { stdio: "pipe" });
  let created: { isolated: boolean; cwd: string; branch?: string } | undefined;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    await withGitRace("break-sidecar", {}, async () => {
      created = await createWorktreeLive(repo, "metadata-reclaim-marker");
    });

    assert.equal(created?.isolated, false);
    assert.ok(created?.branch);
    assert.equal(
      existsSync(expectedWorktreePath(repo, "metadata-reclaim-marker")),
      true,
      "ambiguous metadata failure preserves the artifact",
    );
    const claims = join(repo, ".pi", "worktrees", ".claims");
    assert.ok(
      readdirSync(claims).some((name) => name.endsWith(".reclaim.json")),
      "a durable reclaim marker remains for a later owner-fenced cleanup",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree reclaims a stale cleanup claim after the previous owner died", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-stale-claim-"));
  const git = (...args: string[]) => execFileSync(REAL_GIT, ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const wt = await createWorktreeLive(repo, "stale-claim");
    assert.equal(wt.isolated, true);

    const claim = expectedClaimPath(repo, wt);
    mkdirSync(join(repo, ".pi", "worktrees", ".claims"), { recursive: true });
    writeFileSync(claim, JSON.stringify({ ownerToken: "dead-owner", pid: 2_147_483_647 }), "utf8");
    const staleAt = new Date(Date.now() - 10 * 60_000);
    utimesSync(claim, staleAt, staleAt);

    assert.equal(await removeWorktree(wt), true, "a dead owner's stale claim must not strand cleanup");
    assert.equal(existsSync(claim), false, "the recovered claim is released after cleanup");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree never deletes a replacement created at the canonical path", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-sidecar-race-"));
  const git = (...args: string[]) => execFileSync(REAL_GIT, ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const wt = await createWorktreeLive(repo, "replacement-sidecar-race");
    assert.equal(wt.isolated, true);
    const replacementOwner = "replacement-sidecar-owner";

    await withGitRace(
      "replace-sidecar-before-remove",
      {
        PI_WT_ORIGINAL_PATH: wt.cwd,
        PI_WT_ORIGINAL_BRANCH: wt.branch ?? "",
        PI_WT_REPLACEMENT_OWNER: replacementOwner,
      },
      async () => {
        assert.equal(await removeWorktree(wt), true);
      },
    );

    assert.equal(existsSync(wt.cwd), true, "the replacement canonical directory must survive old-owner cleanup");
    const metadata = JSON.parse(readFileSync(join(wt.cwd, ".pi-worktree-owner.json"), "utf8"));
    assert.equal(metadata.ownerToken, replacementOwner);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("orphan reaping deletes only its claimed branch when the canonical branch is recreated", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-branch-race-"));
  const git = (...args: string[]) => execFileSync(REAL_GIT, ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const wt = await createWorktreeLive(repo, "replacement-branch-race");
    assert.equal(wt.isolated, true);
    rmSync(wt.cwd, { recursive: true, force: true });
    const replacementOwner = "replacement-branch-owner";

    await withGitRace(
      "recreate-canonical-after-branch-claim",
      {
        PI_WT_ORIGINAL_PATH: wt.cwd,
        PI_WT_ORIGINAL_BRANCH: wt.branch ?? "",
        PI_WT_REPLACEMENT_OWNER: replacementOwner,
      },
      async () => {
        assert.equal(await reapOrphanedWorktrees(repo), 1);
      },
    );

    const branches = git("branch", "--list", wt.branch ?? "")
      .toString("utf8")
      .trim();
    assert.notEqual(branches, "", "the concurrently recreated canonical branch must survive reaping");
    const marker = git("config", "--get", `branch.${wt.branch}.pi-worktree-owner`).toString("utf8").trim();
    assert.equal(marker, replacementOwner);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
