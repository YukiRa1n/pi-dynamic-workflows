/**
 * Workflow run state persistence for pause/resume support.
 */
import { join } from "node:path";
import { ensureDir as ensureDirFs, listJsonFilesSafe, resolvePersistenceFs, unlinkIfExistsSafe, writeJsonAtomicWithBackup, } from "./fs-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";
/** Raised when a durable record has changed since the caller read it. */
export class PersistenceRevisionConflict extends Error {
    constructor(runId, expected, actual) {
        super(`Persistence revision conflict for ${runId}: expected ${expected ?? "absent"}, found ${actual ?? "absent"}`);
        this.name = "PersistenceRevisionConflict";
    }
}
/**
 * Retention policy for terminal (completed/failed/aborted) runs kept on
 * disk. Bounded so a long-lived project directory can't accumulate an
 * unbounded number of run files (each polled/listed on every list() call).
 * A run in "running" or "paused" status is NEVER counted against this cap
 * or evicted by it — only genuinely finished runs age out, oldest (by
 * updatedAt) first, once the terminal-run count exceeds the cap. 300 is
 * generous enough to cover weeks of typical usage while keeping list()'s
 * per-call directory scan bounded.
 */
export const DEFAULT_MAX_TERMINAL_RUNS_ON_DISK = 300;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "aborted"]);
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Validate IDs before they reach any filesystem or in-memory run boundary. */
export function assertSafeRunId(runId) {
    if (typeof runId !== "string" ||
        runId.length === 0 ||
        runId.length > 200 ||
        runId === "." ||
        runId === ".." ||
        !SAFE_RUN_ID.test(runId)) {
        throw new Error(`Invalid run ID: ${JSON.stringify(runId)}`);
    }
}
/**
 * `list()` does a full readdirSync + per-file readFileSync + JSON.parse of the
 * entire lifetime run history. It is called on essentially every progress tick
 * (task-panel re-render → WorkflowManager.listRuns()/listAllRuns()), so an
 * unbounded number of ticks each re-walked and re-parsed every run file on
 * disk. Cache the computed list for a short TTL — long enough to absorb a
 * burst of same-tick reads, short enough that a read from a DIFFERENT process
 * (or a mutation this instance doesn't own) still shows up quickly. Mirrors
 * the ~1s settings-read TTL cache in task-panel.ts.
 */
const LIST_CACHE_TTL_MS = 300;
export function createRunPersistence(cwd, fsOverride, options) {
    const fs = resolvePersistenceFs(fsOverride);
    // A partial in-memory FsLayer gets the real defaults merged in. Do not call
    // that real linkSync against a mocked filesystem unless the override opted
    // into it explicitly; retain the exclusive-create compatibility fallback.
    const canUseAtomicLink = !fsOverride || fsOverride.linkSync !== undefined;
    const _existsSync = fs.existsSync;
    const _readFileSync = fs.readFileSync;
    const _statSync = fs.statSync;
    const _unlinkSync = fs.unlinkSync;
    const _writeFileSync = fs.writeFileSync;
    const maxTerminalRunsOnDisk = options?.maxTerminalRunsOnDisk ?? DEFAULT_MAX_TERMINAL_RUNS_ON_DISK;
    const paths = workflowProjectPaths(cwd);
    const runsDir = paths.runsDir;
    const legacyRunsDir = paths.legacyRunsDir;
    const ensureDir = () => ensureDirFs(fs, runsDir);
    const runPath = (dir, runId) => join(dir, `${runId}.json`);
    const primaryRunPath = (runId) => runPath(runsDir, runId);
    const legacyRunPath = (runId) => runPath(legacyRunsDir, runId);
    const lockPath = (dir, runId) => join(dir, `${runId}.lock`);
    const primaryLockPath = (runId) => lockPath(runsDir, runId);
    const legacyLockPath = (runId) => lockPath(legacyRunsDir, runId);
    const candidateRunPaths = (runId) => [primaryRunPath(runId), legacyRunPath(runId)];
    const validateState = (value, expectedRunId) => {
        const isRecord = (item) => item !== null && typeof item === "object" && !Array.isArray(item);
        const isText = (item, max = 1_000_000) => typeof item === "string" && item.length <= max;
        const isFiniteCount = (item) => typeof item === "number" && Number.isFinite(item) && item >= 0;
        const state = value;
        if (!isRecord(value) || !isText(state.workflowName, 10_000) || !isText(state.script, 10_000_000))
            return null;
        try {
            assertSafeRunId(state.runId);
        }
        catch {
            return null;
        }
        if (expectedRunId !== undefined && state.runId !== expectedRunId)
            return null;
        const statuses = new Set(["pending", "running", "paused", "completed", "failed", "aborted"]);
        if (typeof state.status !== "string" || !statuses.has(state.status))
            return null;
        if (state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 1))
            return null;
        if (!isText(state.startedAt, 200) || !isText(state.updatedAt, 200))
            return null;
        if (state.completedAt !== undefined && !isText(state.completedAt, 200))
            return null;
        if (!Array.isArray(state.phases) || state.phases.length > 10_000 || state.phases.some((p) => !isText(p, 10_000)))
            return null;
        if (!Array.isArray(state.logs) || state.logs.length > 100_000 || state.logs.some((entry) => !isText(entry, 1_000_000)))
            return null;
        if (!Array.isArray(state.agents) || state.agents.length > 100_000)
            return null;
        const agentStatuses = new Set(["queued", "running", "done", "error", "skipped"]);
        for (const agent of state.agents) {
            if (!isRecord(agent) || !Number.isSafeInteger(agent.id) || agent.id < 0)
                return null;
            if (!isText(agent.label, 10_000) || !isText(agent.prompt, 1_000_000) || typeof agent.status !== "string" || !agentStatuses.has(agent.status))
                return null;
            if (agent.callId !== undefined && !isText(agent.callId, 1_000))
                return null;
            if (agent.phase !== undefined && !isText(agent.phase, 10_000))
                return null;
            if (agent.resultPreview !== undefined && !isText(agent.resultPreview, 1_000_000))
                return null;
            if (agent.error !== undefined && !isText(agent.error, 1_000_000))
                return null;
            if (agent.tokens !== undefined && !isFiniteCount(agent.tokens))
                return null;
            if (agent.history !== undefined && (!Array.isArray(agent.history) || agent.history.length > 100_000 || agent.history.some((entry) => !isRecord(entry))))
                return null;
            if (agent.tokenUsage !== undefined && !isRecord(agent.tokenUsage))
                return null;
        }
        if (state.tokenUsage !== undefined) {
            if (!isRecord(state.tokenUsage))
                return null;
            for (const key of ["input", "output", "total", "cost", "cacheRead", "cacheWrite"]) {
                const amount = state.tokenUsage[key];
                if (amount !== undefined && !isFiniteCount(amount))
                    return null;
            }
        }
        if (state.journal !== undefined) {
            if (!Array.isArray(state.journal) || state.journal.length > 100_000)
                return null;
            for (const entry of state.journal) {
                if (!isRecord(entry) || !Number.isSafeInteger(entry.index) || entry.index < 0 || !isText(entry.hash, 1_000))
                    return null;
                if (entry.runId !== undefined && !isText(entry.runId, 300))
                    return null;
                if (entry.storeDelta !== undefined && !isRecord(entry.storeDelta))
                    return null;
            }
        }
        for (const key of ["maxAgents", "concurrency", "agentRetries", "autoResumeAttempts"]) {
            const amount = state[key];
            if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0))
                return null;
        }
        if (state.agentTimeoutMs !== undefined && state.agentTimeoutMs !== null && !isFiniteCount(state.agentTimeoutMs))
            return null;
        if (state.tokenBudget !== undefined && state.tokenBudget !== null && !isFiniteCount(state.tokenBudget))
            return null;
        return state;
    };
    // Try semantic validation on both primary and backup. A parseable but
    // structurally invalid primary must not mask a valid backup record.
    const readStateAt = (path, expectedRunId) => {
        for (const candidate of [path, `${path}.bak`]) {
            try {
                const parsed = JSON.parse(_readFileSync(candidate, "utf-8"));
                const valid = validateState(parsed, expectedRunId);
                if (valid)
                    return valid;
            }
            catch {
                // Continue to the backup candidate.
            }
        }
        return null;
    };
    const pidIsAlive = (pid) => {
        if (!Number.isInteger(pid) || pid <= 0)
            return false;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (err) {
            if (err.code === "EPERM")
                return true;
            return false;
        }
    };
    // Strict run-ID grammar (LP-005 / SB-003): run IDs are interpolated into
    // filesystem paths (`${runId}.json` / `.lock` / `.log`), so separators, dot
    // segments, absolute paths, NUL, and Windows drive qualifiers must be
    // rejected at every persistence boundary. Generated IDs fit this shape.
    /**
     * A lock that cannot be parsed is deliberately represented as null, but its
     * existence is handled by callers as "occupied". Removing an unreadable lock
     * is unsafe: it may be a live owner's partially published file.
     */
    const readLockAt = (path, expectedRunId, expectedPath) => {
        try {
            const value = JSON.parse(_readFileSync(path, "utf-8"));
            if (typeof value.runId !== "string" ||
                typeof value.runPath !== "string" ||
                !Number.isInteger(value.pid) ||
                value.pid <= 0 ||
                typeof value.startedAt !== "string" ||
                typeof value.token !== "string" ||
                value.token.length < 1)
                return null;
            assertSafeRunId(value.runId);
            if (expectedRunId !== undefined && value.runId !== expectedRunId)
                return null;
            if (expectedPath !== undefined && value.runPath !== expectedPath)
                return null;
            return value;
        }
        catch {
            return null;
        }
    };
    const readLock = (runId) => readLockAt(primaryLockPath(runId), runId, primaryRunPath(runId));
    // list() cache: recomputed lazily, invalidated synchronously by every
    // mutation this instance performs (save()/delete()) so a stale read can
    // never outlive a mutation this process made. A read from another process
    // (or a direct fs write bypassing this instance) is picked up once the TTL
    // elapses, same as before this cache existed on the next un-cached call.
    let listCache;
    let listCacheAt = 0;
    const invalidateListCache = () => {
        listCache = undefined;
    };
    // Per-file mtime+size+ino cache, keyed by absolute path: even once the
    // TTL-level listCache above expires (the active panel polls roughly every
    // 300ms, i.e. faster than or comparable to the TTL), most run files on
    // disk haven't changed since the last recompute. Re-stat is cheap; re-read
    // + re-JSON.parse is not, and scales with total lifetime run history, not
    // with what actually changed. A file whose (mtimeMs, size, ino) all match
    // what we last parsed is reused as-is instead of being re-read; entries
    // for files that vanished between recomputes are pruned so this cache
    // can't grow unbounded independent of what's actually on disk.
    //
    // ino is load-bearing, not redundant with mtime+size: save() writes via
    // tmp-write + rename (writeJsonAtomicWithBackup), and a rename onto an
    // existing path allocates a NEW inode for the replacement file. Two
    // consecutive saves landing in the same mtime tick (400ms-throttled
    // progress persists vs. 1-2s mtime granularity on HFS+/many network
    // mounts/some Docker volume drivers is entirely realistic) with
    // coincidentally equal byte length (e.g. "paused" and "failed" are the
    // same length) would otherwise be indistinguishable from "unchanged" by
    // (mtimeMs, size) alone — serving stale, previously-cached content
    // forever until something ELSE about the file changes. The inode always
    // changes on such a rename, so adding it closes that hole for free.
    const fileStateCache = new Map();
    const removeStaleLegacyLock = (runId) => {
        const lock = legacyLockPath(runId);
        if (!_existsSync(lock))
            return true;
        const existing = readLockAt(lock, runId, legacyRunPath(runId));
        // Unreadable/invalid locks are treated as occupied. A conservative leak is
        // safer than deleting another process's lock after a partial publication.
        if (!existing)
            return false;
        if (pidIsAlive(existing.pid))
            return false;
        try {
            _unlinkSync(lock);
        }
        catch {
            return false;
        }
        return true;
    };
    const acquireRunLease = (runId) => {
        assertSafeRunId(runId);
        ensureDir();
        const path = primaryRunPath(runId);
        const lock = primaryLockPath(runId);
        if (!removeStaleLegacyLock(runId))
            return null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
            const payload = { runId, runPath: path, pid: process.pid, startedAt: new Date().toISOString(), token };
            const tmp = `${lock}.${token}.tmp`;
            try {
                _writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
                if (canUseAtomicLink && fs.linkSync) {
                    // link(2) publishes without replacing an existing lock.
                    fs.linkSync(tmp, lock);
                    _unlinkSync(tmp);
                }
                else {
                    // Older injected FsLayers do not expose linkSync. Keep the legacy
                    // exclusive-create fallback rather than breaking that test API.
                    _writeFileSync(lock, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
                    _unlinkSync(tmp);
                }
                return { runId, token };
            }
            catch (err) {
                try {
                    if (_existsSync(tmp))
                        _unlinkSync(tmp);
                }
                catch {
                    // best effort cleanup
                }
                const code = err.code;
                if (code !== "EEXIST")
                    throw err;
                if (_existsSync(lock)) {
                    const existing = readLock(runId);
                    if (!existing)
                        return null;
                    if (pidIsAlive(existing.pid))
                        return null;
                    try {
                        _unlinkSync(lock);
                    }
                    catch {
                        return null;
                    }
                }
            }
        }
        return null;
    };
    const releaseRunLease = (lease) => {
        assertSafeRunId(lease.runId);
        try {
            const existing = readLock(lease.runId);
            if (existing?.token === lease.token)
                _unlinkSync(primaryLockPath(lease.runId));
        }
        catch {
            // Best-effort cleanup only.
        }
    };
    let deleteRunFiles;
    const deleteRun = (runId, expectedRevision, lease) => {
        assertSafeRunId(runId);
        if (lease && lease.runId !== runId)
            throw new Error("Lease/run ID mismatch");
        let ownedLease = lease;
        if (ownedLease) {
            // A caller-supplied lease is a capability, not proof of current
            // ownership. Re-read the lock before deleting so a stale token cannot
            // remove a newer owner's run after a lease handoff.
            const currentLock = readLock(runId);
            if (!currentLock || currentLock.token !== ownedLease.token)
                return false;
        }
        else {
            ownedLease = acquireRunLease(runId);
        }
        if (!ownedLease)
            return false;
        try {
            const current = readStateAt(primaryRunPath(runId), runId) ?? readStateAt(legacyRunPath(runId), runId);
            if (expectedRevision !== undefined && current?.revision !== expectedRevision)
                return false;
            const deleted = deleteRunFiles(runId, ownedLease);
            invalidateListCache();
            return deleted;
        }
        finally {
            if (ownedLease && ownedLease !== lease)
                releaseRunLease(ownedLease);
        }
    };
    const computeList = () => {
        const byRunId = new Map();
        const seenPaths = new Set();
        for (const dir of [runsDir, legacyRunsDir]) {
            for (const file of listJsonFilesSafe(fs, dir)) {
                const fileRunId = file.slice(0, -".json".length);
                try {
                    assertSafeRunId(fileRunId);
                }
                catch {
                    continue;
                }
                const path = join(dir, file);
                seenPaths.add(path);
                try {
                    const stat = _statSync(path);
                    const cached = fileStateCache.get(path);
                    // Reuse the last parse when the file is byte-identical (same
                    // mtime + size + inode) to what produced it — the dominant case
                    // on every poll tick once a run goes terminal and stops changing.
                    // ino is what actually rules out a false "unchanged" match on a
                    // coarse-mtime filesystem (see the field doc comment above).
                    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size && cached.ino === stat.ino) {
                        if (!byRunId.has(cached.state.runId))
                            byRunId.set(cached.state.runId, cached.state);
                        continue;
                    }
                    const state = readStateAt(path, fileRunId);
                    if (!state)
                        continue;
                    fileStateCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, state });
                    if (!byRunId.has(state.runId))
                        byRunId.set(state.runId, state);
                }
                catch {
                    // LP-004: the primary is corrupt/truncated, but a valid .bak from the
                    // previous save may still recover the run — load() already does this,
                    // so list()/startup recovery/retention must agree with it.
                    try {
                        const state = readStateAt(path, fileRunId);
                        if (state && !byRunId.has(state.runId)) {
                            byRunId.set(state.runId, state);
                            // The stat/read failure path has no reliable file signature;
                            // retain the recovered value for this listing only.
                            continue;
                        }
                    }
                    catch {
                        // fall through to prune below
                    }
                    fileStateCache.delete(path);
                }
            }
        }
        // Prune cache entries for files that no longer exist (deleted runs) so
        // this map's size tracks what's actually on disk, not lifetime history.
        for (const path of fileStateCache.keys()) {
            if (!seenPaths.has(path))
                fileStateCache.delete(path);
        }
        return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    };
    // Bound the number of terminal (completed/failed/aborted) runs kept on
    // disk (see DEFAULT_MAX_TERMINAL_RUNS_ON_DISK) — called after every save()
    // whose state is terminal, since that's the only time the terminal count
    // can grow. Running/paused runs are never candidates: they're filtered out
    // before the cap is even considered.
    const enforceRetention = () => {
        const terminal = computeList()
            .filter((r) => TERMINAL_RUN_STATUSES.has(r.status))
            .sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
        const excess = terminal.length - maxTerminalRunsOnDisk;
        if (excess <= 0)
            return;
        for (const run of terminal.slice(0, excess)) {
            // RETENTION-TOCTOU: existence-checking a lock and unlinking a record are
            // not a lease. Acquire the candidate's lease, re-read it, and delete only
            // if the same terminal revision is still present. A live/unreadable lock
            // simply makes this candidate ineligible for this pass.
            let lease = null;
            try {
                lease = acquireRunLease(run.runId);
                if (!lease)
                    continue;
                const fresh = readStateAt(primaryRunPath(run.runId), run.runId) ?? readStateAt(legacyRunPath(run.runId), run.runId);
                if (!fresh || !TERMINAL_RUN_STATUSES.has(fresh.status) || fresh.revision !== run.revision)
                    continue;
                if (deleteRun(run.runId, fresh.revision, lease)) {
                    lease = null; // delete() consumes the lock when it succeeds
                }
            }
            catch {
                // Retention is best-effort; never let one raced/corrupt candidate abort save.
            }
            finally {
                if (lease)
                    releaseRunLease(lease);
            }
        }
        invalidateListCache();
    };
    deleteRunFiles = (runId, lease) => {
        let deleted = false;
        for (const path of candidateRunPaths(runId)) {
            const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
            // Best-effort cleanup of the sidecar files alongside the primary.
            for (const sidecar of [`${path}.bak`, `${path}.tmp`, join(dir, `${runId}.log`)]) {
                unlinkIfExistsSafe(fs, sidecar);
                fileStateCache.delete(sidecar);
            }
            const lock = lockPath(dir, runId);
            // Never unlink a lock that no longer carries the lease used for this
            // deletion; another process may have acquired it between verification
            // and publication cleanup.
            if (!lease || readLockAt(lock, runId, path)?.token === lease.token) {
                unlinkIfExistsSafe(fs, lock);
                fileStateCache.delete(lock);
            }
            // Atomic writers use unique `<run>.json.<token>.tmp` names. Remove only
            // this run's abandoned temporaries; never sweep unrelated records.
            try {
                for (const file of fs.readdirSync(dir)) {
                    if (file.startsWith(`${runId}.json.`) && file.endsWith(".tmp")) {
                        const tmp = join(dir, file);
                        unlinkIfExistsSafe(fs, tmp);
                        fileStateCache.delete(tmp);
                    }
                }
            }
            catch {
                // Retention/deletion remains best-effort if the directory disappears.
            }
            if (unlinkIfExistsSafe(fs, path))
                deleted = true;
            fileStateCache.delete(path);
        }
        return deleted;
    };
    return {
        save(state, expectedRevision, lease) {
            assertSafeRunId(state.runId);
            if (lease && lease.runId !== state.runId)
                throw new Error("Lease/run ID mismatch");
            ensureDir();
            let ownedLease = lease;
            if (!ownedLease) {
                ownedLease = acquireRunLease(state.runId);
                if (!ownedLease)
                    throw new Error(`Could not acquire persistence lease for ${state.runId}`);
            }
            else {
                const held = readLock(state.runId);
                if (!held || held.token !== ownedLease.token)
                    throw new Error(`Persistence lease is not held for ${state.runId}`);
            }
            try {
                const current = readStateAt(primaryRunPath(state.runId), state.runId) ?? readStateAt(legacyRunPath(state.runId), state.runId);
                const actualRevision = current?.revision;
                const fence = expectedRevision !== undefined ? expectedRevision : state.revision;
                if (fence !== undefined && fence !== actualRevision) {
                    throw new PersistenceRevisionConflict(state.runId, fence, actualRevision);
                }
                const nextRevision = (actualRevision ?? 0) + 1;
                const nextUpdatedAt = new Date().toISOString();
                // Accept legacy/programmatic callers that predate mandatory script and
                // timestamps, but publish a record that passes our own schema immediately.
                if (typeof state.script !== "string")
                    state.script = "";
                if (!state.startedAt)
                    state.startedAt = nextUpdatedAt;
                const path = primaryRunPath(state.runId);
                // Publish a copy first. Mutating the caller's revision before an I/O
                // failure would make its next retry fence against a revision that was
                // never committed durably.
                writeJsonAtomicWithBackup(fs, path, { ...state, revision: nextRevision, updatedAt: nextUpdatedAt });
                state.revision = nextRevision;
                state.updatedAt = nextUpdatedAt;
                invalidateListCache();
                if (TERMINAL_RUN_STATUSES.has(state.status))
                    enforceRetention();
            }
            finally {
                if (ownedLease && ownedLease !== lease)
                    releaseRunLease(ownedLease);
            }
        },
        load(runId) {
            assertSafeRunId(runId);
            for (const path of candidateRunPaths(runId)) {
                const state = readStateAt(path, runId);
                if (state)
                    return state;
            }
            return null;
        },
        list() {
            const now = Date.now();
            // Return a fresh array on every call (a cheap ref-copy) so a caller that
            // sorts/reverses/mutates the result in place can't corrupt the cache — the
            // pre-cache code re-parsed into a new array each call, preserve that.
            if (listCache && now - listCacheAt < LIST_CACHE_TTL_MS) {
                return [...listCache];
            }
            const result = computeList();
            listCache = result;
            listCacheAt = now;
            return [...result];
        },
        delete(runId, expectedRevision, lease) {
            return deleteRun(runId, expectedRevision, lease);
        },
        acquireRunLease(runId) {
            return acquireRunLease(runId);
        },
        releaseRunLease(lease) {
            releaseRunLease(lease);
        },
        getRunsDir() {
            return runsDir;
        },
    };
}
/**
 * Generate a unique run ID.
 */
export function generateRunId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `${timestamp}-${random}`;
}
