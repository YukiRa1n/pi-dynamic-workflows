/**
 * Workflow run state persistence for pause/resume support.
 */

import { join } from "node:path";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import {
  ensureDir as ensureDirFs,
  listJsonFilesSafe,
  type PersistenceFsLayer,
  resolvePersistenceFs,
  unlinkIfExistsSafe,
  writeJsonAtomicWithBackup,
} from "./fs-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "aborted";

export interface PersistedAgentState {
  id: number;
  /** Runtime call identity (`${runId}:${callIndex}`), used to rehydrate journaled results. */
  callId?: string;
  label: string;
  phase?: string;
  prompt: string;
  status: "queued" | "running" | "done" | "error" | "skipped";
  result?: unknown;
  /** Compact result written by releases before full agent results were retained. */
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  startedAt?: string;
  endedAt?: string;
  /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
  tokens?: number;
  /** Per-agent token usage breakdown, when the provider reported one. */
  tokenUsage?: AgentUsage;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
}

export interface PersistedRunState {
  runId: string;
  workflowName: string;
  script: string;
  args?: unknown;
  /** The pi session this run belongs to. Runs persist on disk across sessions but
   * the navigator shows only the current session's runs (undefined = legacy/global). */
  sessionId?: string;
  status: RunStatus;
  /** Durable record version. It increases on every successful save. */
  revision?: number;
  /** Why a paused run is paused (e.g. "usage_limit" when a provider quota was hit). */
  pauseReason?: string;
  /** Provider reset hint for a usage-limit pause, e.g. "Resets in ~3h" (verbatim). */
  resetHint?: string;
  phases: string[];
  currentPhase?: string;
  agents: PersistedAgentState[];
  logs: string[];
  result?: unknown;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  /**
   * Cached agent/checkpoint results for resume, keyed by deterministic call
   * index. `runId` namespaces `index` (a nested workflow() call restarts its
   * own callSeq at 0) — absent on journals persisted before that namespacing
   * existed; see JournalEntry.runId in workflow.ts for the resume-time
   * legacy-degradation behavior. `storeDelta` is this call's SharedStore
   * write delta, replayed additively on resume.
   */
  journal?: Array<{
    index: number;
    runId?: string;
    hash: string;
    result: unknown;
    storeDelta?: Record<string, unknown>;
  }>;
  /**
   * Opt-out of auto-resume for this run (default true, i.e. eligible unless
   * explicitly set to false via ExecOptions.autoResume). Set once at run start
   * and carried through resumes; see UsageLimitScheduler.
   */
  autoResume?: boolean;
  /**
   * The run's resolved hard token budget, fixed at start (per-run value, else
   * the manager default at the time). Resume re-applies THIS value — never the
   * current default — so an explicit no-budget (`null`) or custom cap survives
   * a pause/resume cycle. Absent on legacy runs (resumed unbudgeted).
   */
  tokenBudget?: number | null;
  /**
   * Named toolset tag (WorkflowManagerOptions.toolsets). ToolDefinitions are
   * functions and can't be serialized, so this tag is how a resumed run (e.g.
   * /deep-research with web tools) re-resolves the tool set it started with.
   */
  toolset?: string;
  /**
   * The run's resolved cap on total agents, fixed at start (per-run value,
   * else undefined so runWorkflow applies its own MAX_AGENTS_PER_RUN default).
   * Resume re-applies THIS value — never the manager's current default — same
   * rationale as tokenBudget. Absent on legacy runs (resumed with no cap
   * carried forward, i.e. runWorkflow's own default applies).
   */
  maxAgents?: number;
  /**
   * The run's resolved per-agent timeout, fixed at start (per-run value, else
   * the manager default at the time). Absent on legacy runs — unlike
   * tokenBudget, a legacy run's real timeout was never "no timeout" by
   * omission; it was always the manager's default (pre-A1 resume always fell
   * back to it), so resume applies the manager's CURRENT default for such
   * runs rather than null, preserving both the run's original semantics and
   * pre-fix resume behavior.
   */
  agentTimeoutMs?: number | null;
  /**
   * The run's resolved concurrency, fixed at start (per-run value, else the
   * manager's concurrency at the time). Same rationale as tokenBudget.
   */
  concurrency?: number;
  /**
   * The run's resolved agent-retry count, fixed at start (per-run value, else
   * the manager default at the time). Same rationale as tokenBudget.
   */
  agentRetries?: number;
  /**
   * Auto-resume attempt counter for the current usage_limit pause-cycle, owned
   * and persisted by UsageLimitScheduler (best-effort). Absent/0 means no
   * auto-resume attempt has been recorded yet.
   */
  autoResumeAttempts?: number;
}

export interface RunPersistence {
  /**
   * Save current run state. If expectedRevision is supplied, the write is a
   * durable compare-and-swap and throws when the record has advanced. A
   * supplied state.revision is likewise treated as the caller's fence. The
   * state object is updated with the committed revision for callers that need
   * to carry the fence forward.
   */
  save(state: PersistedRunState, expectedRevision?: number, lease?: RunLease): void;
  /** Load a persisted run by ID. */
  load(runId: string): PersistedRunState | null;
  /** List all persisted runs. */
  list(): PersistedRunState[];
  /** Delete a persisted run, optionally fenced by its current revision. */
  delete(runId: string, expectedRevision?: number, lease?: RunLease): boolean;
  /**
   * Acquire an exclusive cross-process lease for a run. Returns null when another
   * live process owns the run; demonstrably stale, valid lock files are removed
   * and retried. Unreadable locks are treated as occupied conservatively.
   */
  acquireRunLease(runId: string): RunLease | null;
  /** Release a lease previously returned by acquireRunLease(). */
  releaseRunLease(lease: RunLease): void;
  /** Get runs directory path. */
  getRunsDir(): string;
}

export interface RunLease {
  runId: string;
  token: string;
}

/** Raised when a durable record has changed since the caller read it. */
export class PersistenceRevisionConflict extends Error {
  constructor(runId: string, expected: number | undefined, actual: number | undefined) {
    super(`Persistence revision conflict for ${runId}: expected ${expected ?? "absent"}, found ${actual ?? "absent"}`);
    this.name = "PersistenceRevisionConflict";
  }
}

interface LockFile {
  runId: string;
  runPath: string;
  pid: number;
  startedAt: string;
  token: string;
}

/**
 * Filesystem operations used by run persistence.
 * Exposed for testing – pass overrides to inject mock implementations.
 * (Alias of the shared PersistenceFsLayer — see fs-persistence.ts.)
 */
export type FsLayer = PersistenceFsLayer;

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

const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Validate IDs before they reach any filesystem or in-memory run boundary. */
export function assertSafeRunId(runId: string): void {
  if (
    typeof runId !== "string" ||
    runId.length === 0 ||
    runId.length > 200 ||
    runId === "." ||
    runId === ".." ||
    !SAFE_RUN_ID.test(runId)
  ) {
    throw new Error(`Invalid run ID: ${JSON.stringify(runId)}`);
  }
}

export interface RunPersistenceOptions {
  /** Override DEFAULT_MAX_TERMINAL_RUNS_ON_DISK (tests; advanced tuning). */
  maxTerminalRunsOnDisk?: number;
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

export function createRunPersistence(
  cwd: string,
  fsOverride?: Partial<FsLayer>,
  options?: RunPersistenceOptions,
): RunPersistence {
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

  const runPath = (dir: string, runId: string) => join(dir, `${runId}.json`);
  const primaryRunPath = (runId: string) => runPath(runsDir, runId);
  const legacyRunPath = (runId: string) => runPath(legacyRunsDir, runId);
  const lockPath = (dir: string, runId: string) => join(dir, `${runId}.lock`);
  const primaryLockPath = (runId: string) => lockPath(runsDir, runId);
  const legacyLockPath = (runId: string) => lockPath(legacyRunsDir, runId);
  const candidateRunPaths = (runId: string) => [primaryRunPath(runId), legacyRunPath(runId)];

  const validateState = (value: unknown, expectedRunId?: string): PersistedRunState | null => {
    const isRecord = (item: unknown): item is Record<string, unknown> =>
      item !== null && typeof item === "object" && !Array.isArray(item);
    const isText = (item: unknown, max = 1_000_000): item is string =>
      typeof item === "string" && item.length <= max;
    const isFiniteCount = (item: unknown): item is number =>
      typeof item === "number" && Number.isFinite(item) && item >= 0;
    const state = value as Partial<PersistedRunState>;
    if (!isRecord(value) || !isText(state.workflowName, 10_000) || !isText(state.script, 10_000_000)) return null;
    try {
      assertSafeRunId(state.runId as string);
    } catch {
      return null;
    }
    if (expectedRunId !== undefined && state.runId !== expectedRunId) return null;
    const statuses: ReadonlySet<string> = new Set(["pending", "running", "paused", "completed", "failed", "aborted"]);
    if (typeof state.status !== "string" || !statuses.has(state.status)) return null;
    if (state.revision !== undefined && (!Number.isSafeInteger(state.revision) || state.revision < 1)) return null;
    if (!isText(state.startedAt, 200) || !isText(state.updatedAt, 200)) return null;
    if (state.completedAt !== undefined && !isText(state.completedAt, 200)) return null;
    if (!Array.isArray(state.phases) || state.phases.length > 10_000 || state.phases.some((p) => !isText(p, 10_000))) return null;
    if (!Array.isArray(state.logs) || state.logs.length > 100_000 || state.logs.some((entry) => !isText(entry, 1_000_000))) return null;
    if (!Array.isArray(state.agents) || state.agents.length > 100_000) return null;
    const agentStatuses: ReadonlySet<string> = new Set(["queued", "running", "done", "error", "skipped"]);
    for (const agent of state.agents) {
      if (!isRecord(agent) || !Number.isSafeInteger(agent.id) || agent.id < 0) return null;
      if (!isText(agent.label, 10_000) || !isText(agent.prompt, 1_000_000) || typeof agent.status !== "string" || !agentStatuses.has(agent.status)) return null;
      if (agent.callId !== undefined && !isText(agent.callId, 1_000)) return null;
      if (agent.phase !== undefined && !isText(agent.phase, 10_000)) return null;
      if (agent.resultPreview !== undefined && !isText(agent.resultPreview, 1_000_000)) return null;
      if (agent.error !== undefined && !isText(agent.error, 1_000_000)) return null;
      if (agent.tokens !== undefined && !isFiniteCount(agent.tokens)) return null;
      if (agent.history !== undefined && (!Array.isArray(agent.history) || agent.history.length > 100_000 || agent.history.some((entry) => !isRecord(entry)))) return null;
      if (agent.tokenUsage !== undefined && !isRecord(agent.tokenUsage)) return null;
    }
    if (state.tokenUsage !== undefined) {
      if (!isRecord(state.tokenUsage)) return null;
      for (const key of ["input", "output", "total", "cost", "cacheRead", "cacheWrite"] as const) {
        const amount = state.tokenUsage[key];
        if (amount !== undefined && !isFiniteCount(amount)) return null;
      }
    }
    if (state.journal !== undefined) {
      if (!Array.isArray(state.journal) || state.journal.length > 100_000) return null;
      for (const entry of state.journal) {
        if (!isRecord(entry) || !Number.isSafeInteger(entry.index) || entry.index < 0 || !isText(entry.hash, 1_000)) return null;
        if (entry.runId !== undefined && !isText(entry.runId, 300)) return null;
        if (entry.storeDelta !== undefined && !isRecord(entry.storeDelta)) return null;
      }
    }
    for (const key of ["maxAgents", "concurrency", "agentRetries", "autoResumeAttempts"] as const) {
      const amount = state[key];
      if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) return null;
    }
    if (state.agentTimeoutMs !== undefined && state.agentTimeoutMs !== null && !isFiniteCount(state.agentTimeoutMs)) return null;
    if (state.tokenBudget !== undefined && state.tokenBudget !== null && !isFiniteCount(state.tokenBudget)) return null;
    return state as PersistedRunState;
  };

  // Try semantic validation on both primary and backup. A parseable but
  // structurally invalid primary must not mask a valid backup record.
  const readStateAt = (path: string, expectedRunId?: string): PersistedRunState | null => {
    for (const candidate of [path, `${path}.bak`]) {
      try {
        const parsed = JSON.parse(_readFileSync(candidate, "utf-8")) as unknown;
        const valid = validateState(parsed, expectedRunId);
        if (valid) return valid;
      } catch {
        // Continue to the backup candidate.
      }
    }
    return null;
  };

  const pidIsAlive = (pid: number): boolean => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === "EPERM") return true;
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
  const readLockAt = (path: string, expectedRunId?: string, expectedPath?: string): LockFile | null => {
    try {
      const value = JSON.parse(_readFileSync(path, "utf-8")) as Partial<LockFile>;
      if (
        typeof value.runId !== "string" ||
        typeof value.runPath !== "string" ||
        !Number.isInteger(value.pid) ||
        (value.pid as number) <= 0 ||
        typeof value.startedAt !== "string" ||
        typeof value.token !== "string" ||
        value.token.length < 1
      )
        return null;
      assertSafeRunId(value.runId);
      if (expectedRunId !== undefined && value.runId !== expectedRunId) return null;
      if (expectedPath !== undefined && value.runPath !== expectedPath) return null;
      return value as LockFile;
    } catch {
      return null;
    }
  };

  const readLock = (runId: string): LockFile | null =>
    readLockAt(primaryLockPath(runId), runId, primaryRunPath(runId));

  // list() cache: recomputed lazily, invalidated synchronously by every
  // mutation this instance performs (save()/delete()) so a stale read can
  // never outlive a mutation this process made. A read from another process
  // (or a direct fs write bypassing this instance) is picked up once the TTL
  // elapses, same as before this cache existed on the next un-cached call.
  let listCache: PersistedRunState[] | undefined;
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
  const fileStateCache = new Map<string, { mtimeMs: number; size: number; ino: number; state: PersistedRunState }>();

  const removeStaleLegacyLock = (runId: string): boolean => {
    const lock = legacyLockPath(runId);
    if (!_existsSync(lock)) return true;
    const existing = readLockAt(lock, runId, legacyRunPath(runId));
    // Unreadable/invalid locks are treated as occupied. A conservative leak is
    // safer than deleting another process's lock after a partial publication.
    if (!existing) return false;
    if (pidIsAlive(existing.pid)) return false;
    try {
      _unlinkSync(lock);
    } catch {
      return false;
    }
    return true;
  };

  const acquireRunLease = (runId: string): RunLease | null => {
    assertSafeRunId(runId);
    ensureDir();
    const path = primaryRunPath(runId);
    const lock = primaryLockPath(runId);
    if (!removeStaleLegacyLock(runId)) return null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const payload: LockFile = { runId, runPath: path, pid: process.pid, startedAt: new Date().toISOString(), token };
      const tmp = `${lock}.${token}.tmp`;
      try {
        _writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
        if (canUseAtomicLink && fs.linkSync) {
          // link(2) publishes without replacing an existing lock.
          fs.linkSync(tmp, lock);
          _unlinkSync(tmp);
        } else {
          // Older injected FsLayers do not expose linkSync. Keep the legacy
          // exclusive-create fallback rather than breaking that test API.
          _writeFileSync(lock, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600, flag: "wx" });
          _unlinkSync(tmp);
        }
        return { runId, token };
      } catch (err) {
        try {
          if (_existsSync(tmp)) _unlinkSync(tmp);
        } catch {
          // best effort cleanup
        }
        const code = (err as { code?: string }).code;
        if (code !== "EEXIST") throw err;
        if (_existsSync(lock)) {
          const existing = readLock(runId);
          if (!existing) return null;
          if (pidIsAlive(existing.pid)) return null;
          try {
            _unlinkSync(lock);
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  };

  const releaseRunLease = (lease: RunLease): void => {
    assertSafeRunId(lease.runId);
    try {
      const existing = readLock(lease.runId);
      if (existing?.token === lease.token) _unlinkSync(primaryLockPath(lease.runId));
    } catch {
      // Best-effort cleanup only.
    }
  };

  let deleteRunFiles: (runId: string, lease?: RunLease) => boolean;
  const deleteRun = (runId: string, expectedRevision?: number, lease?: RunLease): boolean => {
    assertSafeRunId(runId);
    if (lease && lease.runId !== runId) throw new Error("Lease/run ID mismatch");
    let ownedLease: RunLease | null | undefined = lease;
    if (ownedLease) {
      // A caller-supplied lease is a capability, not proof of current
      // ownership. Re-read the lock before deleting so a stale token cannot
      // remove a newer owner's run after a lease handoff.
      const currentLock = readLock(runId);
      if (!currentLock || currentLock.token !== ownedLease.token) return false;
    } else {
      ownedLease = acquireRunLease(runId);
    }
    if (!ownedLease) return false;
    try {
      const current = readStateAt(primaryRunPath(runId), runId) ?? readStateAt(legacyRunPath(runId), runId);
      if (expectedRevision !== undefined && current?.revision !== expectedRevision) return false;
      const deleted = deleteRunFiles(runId, ownedLease);
      invalidateListCache();
      return deleted;
    } finally {
      if (ownedLease && ownedLease !== lease) releaseRunLease(ownedLease);
    }
  };

  const computeList = (): PersistedRunState[] => {
    const byRunId = new Map<string, PersistedRunState>();
    const seenPaths = new Set<string>();
    for (const dir of [runsDir, legacyRunsDir]) {
      for (const file of listJsonFilesSafe(fs, dir)) {
        const fileRunId = file.slice(0, -".json".length);
        try {
          assertSafeRunId(fileRunId);
        } catch {
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
            if (!byRunId.has(cached.state.runId)) byRunId.set(cached.state.runId, cached.state);
            continue;
          }
          const state = readStateAt(path, fileRunId);
          if (!state) continue;
          fileStateCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, state });
          if (!byRunId.has(state.runId)) byRunId.set(state.runId, state);
        } catch {
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
          } catch {
            // fall through to prune below
          }
          fileStateCache.delete(path);
        }
      }
    }
    // Prune cache entries for files that no longer exist (deleted runs) so
    // this map's size tracks what's actually on disk, not lifetime history.
    for (const path of fileStateCache.keys()) {
      if (!seenPaths.has(path)) fileStateCache.delete(path);
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
    if (excess <= 0) return;
    for (const run of terminal.slice(0, excess)) {
      // RETENTION-TOCTOU: existence-checking a lock and unlinking a record are
      // not a lease. Acquire the candidate's lease, re-read it, and delete only
      // if the same terminal revision is still present. A live/unreadable lock
      // simply makes this candidate ineligible for this pass.
      let lease: RunLease | null = null;
      try {
        lease = acquireRunLease(run.runId);
        if (!lease) continue;
        const fresh = readStateAt(primaryRunPath(run.runId), run.runId) ?? readStateAt(legacyRunPath(run.runId), run.runId);
        if (!fresh || !TERMINAL_RUN_STATUSES.has(fresh.status) || fresh.revision !== run.revision) continue;
        if (deleteRun(run.runId, fresh.revision, lease)) {
          lease = null; // delete() consumes the lock when it succeeds
        }
      } catch {
        // Retention is best-effort; never let one raced/corrupt candidate abort save.
      } finally {
        if (lease) releaseRunLease(lease);
      }
    }
    invalidateListCache();
  };

  deleteRunFiles = (runId: string, lease?: RunLease): boolean => {
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
      } catch {
        // Retention/deletion remains best-effort if the directory disappears.
      }
      if (unlinkIfExistsSafe(fs, path)) deleted = true;
      fileStateCache.delete(path);
    }
    return deleted;
  };

  return {
    save(state: PersistedRunState, expectedRevision?: number, lease?: RunLease) {
      assertSafeRunId(state.runId);
      if (lease && lease.runId !== state.runId) throw new Error("Lease/run ID mismatch");
      ensureDir();
      let ownedLease: RunLease | null | undefined = lease;
      if (!ownedLease) {
        ownedLease = acquireRunLease(state.runId);
        if (!ownedLease) throw new Error(`Could not acquire persistence lease for ${state.runId}`);
      } else {
        const held = readLock(state.runId);
        if (!held || held.token !== ownedLease.token) throw new Error(`Persistence lease is not held for ${state.runId}`);
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
        if (typeof state.script !== "string") state.script = "";
        if (!state.startedAt) state.startedAt = nextUpdatedAt;
        const path = primaryRunPath(state.runId);
        // Publish a copy first. Mutating the caller's revision before an I/O
        // failure would make its next retry fence against a revision that was
        // never committed durably.
        writeJsonAtomicWithBackup(fs, path, { ...state, revision: nextRevision, updatedAt: nextUpdatedAt });
        state.revision = nextRevision;
        state.updatedAt = nextUpdatedAt;
        invalidateListCache();
        if (TERMINAL_RUN_STATUSES.has(state.status)) enforceRetention();
      } finally {
        if (ownedLease && ownedLease !== lease) releaseRunLease(ownedLease);
      }
    },

    load(runId: string): PersistedRunState | null {
      assertSafeRunId(runId);
      for (const path of candidateRunPaths(runId)) {
        const state = readStateAt(path, runId);
        if (state) return state;
      }
      return null;
    },

    list(): PersistedRunState[] {
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

    delete(runId: string, expectedRevision?: number, lease?: RunLease): boolean {
      return deleteRun(runId, expectedRevision, lease);
    },

    acquireRunLease(runId: string): RunLease | null {
      return acquireRunLease(runId);
    },

    releaseRunLease(lease: RunLease): void {
      releaseRunLease(lease);
    },

    getRunsDir(): string {
      return runsDir;
    },
  };
}

/**
 * Generate a unique run ID.
 */
export function generateRunId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}
