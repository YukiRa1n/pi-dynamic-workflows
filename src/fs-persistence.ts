/**
 * Shared filesystem primitives for JSON-backed persistence.
 *
 * Both run-persistence.ts (workflow runs) and workflow-saved.ts (saved
 * workflow commands) persist plain-JSON records to per-record files under a
 * project/user directory, and both need the same three guarantees:
 *
 *  1. Atomic writes with a recovery backup — a crash mid-write must never
 *     corrupt the live file, and a later-discovered-truncated primary must
 *     still be recoverable from the last good write.
 *  2. Corrupt-file recovery on read — a truncated/corrupt primary falls back
 *     to its `.bak` sidecar instead of losing the record.
 *  3. A missing or unreadable directory degrades to "no files" rather than
 *     throwing — a listing must never crash because one storage location is
 *     temporarily inaccessible (not yet created, deleted mid-race, EACCES).
 *
 * This module is the single implementation of all three; run-persistence.ts
 * and workflow-saved.ts both call into it rather than maintaining parallel
 * copies.
 */

import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

/** Filesystem operations used by JSON persistence. Exposed for testing. */
export type PersistenceFsLayer = {
  existsSync: typeof existsSync;
  /** Optional for compatibility with older injected test layers. */
  linkSync?: typeof linkSync;
  mkdirSync: typeof mkdirSync;
  readdirSync: typeof readdirSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

/** The real node:fs implementations. */
export function defaultPersistenceFs(): PersistenceFsLayer {
  return {
    existsSync,
    linkSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    unlinkSync,
    writeFileSync,
  };
}

/** Merge a partial test override on top of the real node:fs implementations. */
export function resolvePersistenceFs(overrides?: Partial<PersistenceFsLayer>): PersistenceFsLayer {
  const base = defaultPersistenceFs();
  return overrides ? { ...base, ...overrides } : base;
}

/** Ensure `dir` exists (recursive mkdir), idempotent. */
export function ensureDir(fs: PersistenceFsLayer, dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Atomically write JSON to `path`: tmp-write + rename (atomic on the same
 * filesystem, so a crash mid-write can't corrupt the live file), then
 * best-effort refresh a `.bak` sidecar from the just-written good state —
 * the recovery fallback readJsonWithBackupRecovery() uses if the primary is
 * later found truncated (e.g. a rename that itself got interrupted by a
 * power loss on a filesystem/OS combination where rename isn't fully atomic).
 */
function writeTextAtomic(fs: PersistenceFsLayer, path: string, text: string): void {
  // Never share a fixed temporary name: concurrent writers must not be able to
  // publish one another's partially-written record.  The final rename is the
  // only publication point and is atomic on the target filesystem.
  const unique = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const tmpPath = `${path}.${unique}.tmp`;
  try {
    fs.writeFileSync(tmpPath, text, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    fs.renameSync(tmpPath, path);
  } finally {
    // A failed write/rename must not leave attacker-confusable or unbounded tmp
    // files behind. Ignore cleanup failure; the original error still wins.
    unlinkIfExistsSafe(fs, tmpPath);
  }
}

export function writeJsonAtomicWithBackup(
  fs: PersistenceFsLayer,
  path: string,
  data: unknown,
  maxBytes?: number,
): void {
  // Persistence must retain native JSON semantics. The display-oriented
  // safeStringify() replaces undefined/functions/symbols with marker strings;
  // using it here turns optional fields into invalid durable values and makes a
  // freshly-written record fail its own schema/CAS readback. Let JSON.stringify
  // omit object-valued undefined (and map array holes to null), and fail loudly
  // for cycles/BigInt rather than publishing a non-replayable approximation.
  const json = JSON.stringify(data, null, 2);
  if (json === undefined) throw new TypeError("Persistence value is not JSON-serializable");
  if (maxBytes !== undefined && Buffer.byteLength(json, "utf8") > maxBytes) {
    const error = new Error(`Persistence record exceeds its ${maxBytes}-byte limit`);
    (error as { code?: string }).code = "PERSISTENCE_SIZE_LIMIT";
    throw error;
  }
  writeTextAtomic(fs, path, json);
  try {
    // The backup is also published atomically.  A direct write here could make
    // recovery choose a truncated sidecar after a crash.
    writeTextAtomic(fs, `${path}.bak`, json);
  } catch {
    // Backup is best-effort; the primary write already succeeded.
  }
}

/**
 * Read JSON from `path`, falling back to `path.bak` if the primary is
 * missing or fails to parse. Returns null if neither candidate parses.
 */
export function readJsonWithBackupRecovery<T>(fs: PersistenceFsLayer, path: string): T | null {
  for (const candidate of [path, `${path}.bak`]) {
    try {
      if (!fs.existsSync(candidate)) continue;
      return JSON.parse(fs.readFileSync(candidate, "utf-8")) as T;
    } catch {
      // Corrupt candidate -> fall through to the next candidate.
    }
  }
  return null;
}

/**
 * List `.json` record files in `dir`. A missing directory (never created
 * yet) or an unreadable one (deleted between the existsSync check and
 * readdirSync, permission-denied, etc.) both degrade to an empty list
 * rather than throwing — callers (run listings, saved-workflow listings)
 * must never crash a navigator/listing because one storage location is
 * temporarily inaccessible.
 */
export function listJsonFilesSafe(fs: PersistenceFsLayer, dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

/** Best-effort unlink; ignores missing-file/permission errors, reports whether it deleted anything. */
export function unlinkIfExistsSafe(fs: PersistenceFsLayer, path: string): boolean {
  try {
    if (fs.existsSync(path)) {
      fs.unlinkSync(path);
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}
