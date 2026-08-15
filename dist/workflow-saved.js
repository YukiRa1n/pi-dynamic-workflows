/**
 * Save and load reusable workflow commands.
 */
import { join } from "node:path";
import { ensureDir as ensureDirFs, listJsonFilesSafe, readJsonWithBackupRecovery, resolvePersistenceFs, unlinkIfExistsSafe, writeJsonAtomicWithBackup, } from "./fs-persistence.js";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";
/**
 * Names are eventually used as `${name}.json` on both POSIX and Windows.
 * Keep the accepted language deliberately narrower than either filesystem's
 * filename language: Windows alternate data streams (`:`), device names, and
 * names whose trailing dot/space is silently stripped must not be accepted on
 * one host and become a different record on another.
 */
export function isSafeSavedWorkflowName(name) {
    if (typeof name !== "string" ||
        name.length === 0 ||
        name.length > 128 ||
        name.trim() !== name ||
        name === "." ||
        name === "..") {
        return false;
    }
    // Reject path separators, NUL/control characters, ADS/drive qualifiers,
    // and characters that Windows cannot represent in a filename.  The extra
    // Windows checks are intentional even on POSIX so a saved name is portable.
    if (/[\\/\0\u0000-\u001f<>:"|?*]/.test(name) || /[. ]$/.test(name))
        return false;
    // Windows interprets the first path component before a dot as a device
    // name, and trims trailing dots/spaces before doing so.  Check that Windows
    // spelling even on POSIX: `CON .json`, `NUL.txt`, and `COM¹.log` must not
    // become a different record when the package is moved to Windows.  The
    // superscript forms are also reserved device suffixes on Windows.
    const windowsDevice = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9]|lpt[1-9]|com[¹²³]|lpt[¹²³])$/i;
    const windowsBase = name.split(/[.]/, 1)[0].replace(/[. ]+$/g, "");
    return windowsBase.length > 0 && !windowsDevice.test(windowsBase);
}
export function assertSafeSavedWorkflowName(name) {
    if (!isSafeSavedWorkflowName(name)) {
        throw new Error("Saved workflow name must be a non-empty portable filename without separators, ADS/device names, or trailing dots/spaces.");
    }
}
export function createWorkflowStorage(cwd, fsOverride) {
    const fs = resolvePersistenceFs(fsOverride);
    const paths = workflowProjectPaths(cwd);
    const projectDir = paths.savedDir;
    const legacyProjectDir = paths.legacySavedDir;
    const userDir = workflowUserSavedDir();
    const ensureDir = (dir) => ensureDirFs(fs, dir);
    const workflowPath = (name, location) => {
        assertSafeSavedWorkflowName(name);
        const dir = location === "project" ? projectDir : userDir;
        return join(dir, `${name}.json`);
    };
    const legacyProjectWorkflowPath = (name) => {
        assertSafeSavedWorkflowName(name);
        return join(legacyProjectDir, `${name}.json`);
    };
    // Same atomic-write-with-backup + corrupt-file recovery contract as
    // run-persistence.ts (see fs-persistence.ts) — a saved workflow is a
    // user-authored artifact just as worth protecting from a crash mid-write
    // or a truncated file as a run's resumable state is.
    const loadFromFile = (path, location) => {
        const data = readJsonWithBackupRecovery(fs, path);
        if (!data || typeof data !== "object" || !isSafeSavedWorkflowName(data.name ?? "")) {
            return null;
        }
        return {
            ...data,
            location,
            path,
        };
    };
    return {
        save(workflow, location = "project") {
            assertSafeSavedWorkflowName(workflow.name);
            const dir = location === "project" ? projectDir : userDir;
            ensureDir(dir);
            const path = workflowPath(workflow.name, location);
            const saved = {
                ...workflow,
                location,
                path,
                savedAt: new Date().toISOString(),
            };
            writeJsonAtomicWithBackup(fs, path, saved);
            return saved;
        },
        load(name) {
            if (!isSafeSavedWorkflowName(name))
                return null;
            // Project takes precedence over user
            const projectPath = workflowPath(name, "project");
            const project = loadFromFile(projectPath, "project");
            if (project)
                return project;
            const legacyProject = loadFromFile(legacyProjectWorkflowPath(name), "project");
            if (legacyProject)
                return legacyProject;
            const userPath = workflowPath(name, "user");
            return loadFromFile(userPath, "user");
        },
        list() {
            const workflows = [];
            const seen = new Set();
            const addDir = (dir, location) => {
                // A missing or unreadable directory (not yet created, deleted
                // mid-race, permission-denied) degrades to "no files" here — same
                // guard run-persistence.ts's list() uses — rather than throwing and
                // taking down the whole listing over one bad storage location.
                for (const file of listJsonFilesSafe(fs, dir)) {
                    const wf = loadFromFile(join(dir, file), location);
                    if (wf && !seen.has(wf.name)) {
                        seen.add(wf.name);
                        workflows.push(wf);
                    }
                }
            };
            // Priority order mirrors load(): project > legacy project > user.
            addDir(projectDir, "project");
            addDir(legacyProjectDir, "project");
            addDir(userDir, "user");
            return workflows.sort((a, b) => a.name.localeCompare(b.name));
        },
        delete(name, location) {
            if (!isSafeSavedWorkflowName(name))
                return false;
            const locations = location ? [location] : ["project", "user"];
            let deleted = false;
            for (const loc of locations) {
                const path = workflowPath(name, loc);
                // Clean up the .bak sidecar too, mirroring run-persistence.ts's delete()
                // (sidecar cleanup does not by itself count as "deleted the workflow").
                unlinkIfExistsSafe(fs, `${path}.bak`);
                if (unlinkIfExistsSafe(fs, path)) {
                    deleted = true;
                }
                if (loc === "project") {
                    const legacyPath = legacyProjectWorkflowPath(name);
                    unlinkIfExistsSafe(fs, `${legacyPath}.bak`);
                    if (unlinkIfExistsSafe(fs, legacyPath)) {
                        deleted = true;
                    }
                }
            }
            return deleted;
        },
    };
}
