/**
 * Workflow logger with file persistence.
 */
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertSafeRunId } from "./run-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";
export function createWorkflowLogger(options = {}) {
    const logs = [];
    const persistLogs = options.persist ?? true;
    const cwd = options.cwd ?? process.cwd();
    const runId = options.runId ?? `run-${Date.now()}`;
    assertSafeRunId(runId);
    const runsDir = workflowProjectPaths(cwd).runsDir;
    let logFile = null;
    // Number of this logger's entries already published. persist() is allowed to
    // be called repeatedly; only the suffix is appended each time.
    let persistedLogCount = 0;
    const assertSafeLogFile = () => {
        if (!logFile)
            return;
        try {
            if (lstatSync(logFile).isSymbolicLink())
                throw new Error("workflow log path is a symbolic link");
        }
        catch (err) {
            if (err.code !== "ENOENT")
                throw err;
        }
    };
    const write = (level, message) => {
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] [${level}] ${message}`;
        logs.push(entry);
        options.onLog?.(message);
        if (persistLogs && logFile) {
            try {
                assertSafeLogFile();
                appendFileSync(logFile, `${entry}\n`);
                // The live append already published this entry; persist() must not
                // append it a second time.
                persistedLogCount = logs.length;
            }
            catch {
                // Silent fail for log persistence; persist() can retry the suffix.
            }
        }
    };
    const logger = {
        log(message) {
            write("INFO", message);
        },
        error(message) {
            write("ERROR", message);
        },
        warn(message) {
            write("WARN", message);
        },
        getLogs() {
            return [...logs];
        },
        persist() {
            if (!persistLogs)
                return null;
            try {
                mkdirSync(runsDir, { recursive: true });
                logFile = join(runsDir, `${runId}.log`);
                assertSafeLogFile();
                // A resumed execution must not clobber pre-pause history, and repeated
                // persist() calls must not append this logger's prefix again.
                let existing = "";
                try {
                    existing = readFileSync(logFile, "utf-8");
                }
                catch {
                    existing = ""; // no prior log for this run
                }
                const pending = logs.slice(persistedLogCount);
                if (pending.length > 0) {
                    const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
                    // Append rather than rewriting the whole file: another logger
                    // instance may have published entries after the read above. This
                    // preserves concurrent entries (at worst a retry duplicates a
                    // suffix, which is preferable to clobbering the log).
                    appendFileSync(logFile, `${prefix}${pending.join("\n")}\n`);
                    persistedLogCount = logs.length;
                }
                else if (!existing) {
                    writeFileSync(logFile, "");
                }
                return logFile;
            }
            catch {
                return null;
            }
        },
    };
    // Initialize log file if persisting
    if (persistLogs) {
        try {
            mkdirSync(runsDir, { recursive: true });
            logFile = join(runsDir, `${runId}.log`);
        }
        catch {
            // Silent fail
        }
    }
    return logger;
}
