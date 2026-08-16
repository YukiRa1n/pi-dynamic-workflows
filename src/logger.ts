/**
 * Workflow logger with file persistence.
 */

import { appendFileSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_WORKFLOW_LOG_BYTES, MAX_WORKFLOW_LOG_ENTRIES } from "./config.js";
import { assertSafeRunId } from "./run-persistence.js";
import { workflowProjectPaths } from "./workflow-paths.js";

export interface WorkflowLogger {
  log(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  getLogs(): string[];
  persist(): string | null;
}

export interface WorkflowLoggerOptions {
  /** Run ID for persistence. */
  runId?: string;
  /** Working directory for file paths. */
  cwd?: string;
  /** Whether to persist logs to disk. */
  persist?: boolean;
  /** Callback for each log entry. */
  onLog?: (message: string) => void;
  /** Optional stricter in-memory entry bound for tests/embedded consumers. */
  maxEntries?: number;
  /** Optional stricter in-memory UTF-8 byte bound for tests/embedded consumers. */
  maxBytes?: number;
}

export function createWorkflowLogger(options: WorkflowLoggerOptions = {}): WorkflowLogger {
  const logs: string[] = [];
  const persistLogs = options.persist ?? true;
  const cwd = options.cwd ?? process.cwd();
  const runId = options.runId ?? `run-${Date.now()}`;
  assertSafeRunId(runId);
  const runsDir = workflowProjectPaths(cwd).runsDir;
  let logFile: string | null = null;
  // Number of this logger's entries already published. persist() is allowed to
  // be called repeatedly; only the suffix is appended each time.
  let persistedLogCount = 0;
  let logBytes = 0;
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? MAX_WORKFLOW_LOG_ENTRIES, MAX_WORKFLOW_LOG_ENTRIES));
  const maxBytes = Math.max(1, Math.min(options.maxBytes ?? MAX_WORKFLOW_LOG_BYTES, MAX_WORKFLOW_LOG_BYTES));
  let limitMarkerWritten = false;

  const assertSafeLogFile = () => {
    if (!logFile) return;
    try {
      if (lstatSync(logFile).isSymbolicLink()) throw new Error("workflow log path is a symbolic link");
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
  };

  const appendBounded = (entry: string): boolean => {
    if (!logFile) return false;
    assertSafeLogFile();
    const suffix = `${entry}\n`;
    let existingBytes = 0;
    try {
      existingBytes = statSync(logFile).size;
    } catch {
      existingBytes = 0;
    }
    const prefix = existingBytes > 0 ? "\n" : "";
    const bytes = Buffer.byteLength(prefix + suffix, "utf8");
    if (existingBytes + bytes > maxBytes) return false;
    appendFileSync(logFile, prefix + suffix, { encoding: "utf-8", mode: 0o600 });
    return true;
  };

  const write = (level: string, message: string) => {
    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] [${level}] ${message}`;
    let bytes = Buffer.byteLength(entry, "utf8");
    let publishedMessage = message;
    if (logs.length >= maxEntries || logBytes + bytes > maxBytes) {
      if (limitMarkerWritten || logs.length >= maxEntries) return;
      entry = `[${timestamp}] [WARN] workflow logger resource limit reached; further entries omitted`;
      bytes = Buffer.byteLength(entry, "utf8");
      if (logBytes + bytes > maxBytes) return;
      limitMarkerWritten = true;
      publishedMessage = "workflow logger resource limit reached; further entries omitted";
    }
    logs.push(entry);
    logBytes += bytes;
    try {
      options.onLog?.(publishedMessage);
    } catch {
      // Logging observers are diagnostic only; they must never recursively turn
      // a provider/workflow outcome into a logger failure.
    }

    if (persistLogs && logFile) {
      try {
        if (appendBounded(entry)) {
          // The live append already published this entry; persist() must not
          // append it a second time.
          persistedLogCount = logs.length;
        }
      } catch {
        // Silent fail for log persistence; persist() can retry the suffix.
      }
    }
  };

  const logger: WorkflowLogger = {
    log(message: string) {
      write("INFO", message);
    },
    error(message: string) {
      write("ERROR", message);
    },
    warn(message: string) {
      write("WARN", message);
    },
    getLogs() {
      return [...logs];
    },
    persist() {
      if (!persistLogs) return null;
      try {
        mkdirSync(runsDir, { recursive: true, mode: 0o700 });
        logFile = join(runsDir, `${runId}.log`);
        assertSafeLogFile();
        // Use stat-based bounded suffix writes. Never read or rewrite the
        // existing run log: resumed/concurrent logger instances share this cap.
        const pending = logs.slice(persistedLogCount);
        for (const entry of pending) {
          if (!appendBounded(entry)) break;
          persistedLogCount++;
        }
        if (pending.length === 0) {
          try {
            if (statSync(logFile).size === 0) writeFileSync(logFile, "", { encoding: "utf-8", mode: 0o600 });
          } catch {
            /* retry later */
          }
        }
        return logFile;
      } catch {
        return null;
      }
    },
  };

  // Initialize log file if persisting
  if (persistLogs) {
    try {
      mkdirSync(runsDir, { recursive: true, mode: 0o700 });
      logFile = join(runsDir, `${runId}.log`);
    } catch {
      // Silent fail
    }
  }

  return logger;
}
