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
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
export declare function defaultPersistenceFs(): PersistenceFsLayer;
/** Merge a partial test override on top of the real node:fs implementations. */
export declare function resolvePersistenceFs(overrides?: Partial<PersistenceFsLayer>): PersistenceFsLayer;
/** Ensure `dir` exists (recursive mkdir), idempotent. */
export declare function ensureDir(fs: PersistenceFsLayer, dir: string): void;
export declare function writeJsonAtomicWithBackup(fs: PersistenceFsLayer, path: string, data: unknown): void;
/**
 * Read JSON from `path`, falling back to `path.bak` if the primary is
 * missing or fails to parse. Returns null if neither candidate parses.
 */
export declare function readJsonWithBackupRecovery<T>(fs: PersistenceFsLayer, path: string): T | null;
/**
 * List `.json` record files in `dir`. A missing directory (never created
 * yet) or an unreadable one (deleted between the existsSync check and
 * readdirSync, permission-denied, etc.) both degrade to an empty list
 * rather than throwing — callers (run listings, saved-workflow listings)
 * must never crash a navigator/listing because one storage location is
 * temporarily inaccessible.
 */
export declare function listJsonFilesSafe(fs: PersistenceFsLayer, dir: string): string[];
/** Best-effort unlink; ignores missing-file/permission errors, reports whether it deleted anything. */
export declare function unlinkIfExistsSafe(fs: PersistenceFsLayer, path: string): boolean;
