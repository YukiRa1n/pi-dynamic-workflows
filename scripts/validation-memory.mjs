import { execFileSync } from "node:child_process";
import { freemem } from "node:os";
import { join } from "node:path";

const GiB = 1024 ** 3;

export function memoryPressureReason({ freePhysical, committed, limit }) {
  if (!Number.isFinite(freePhysical) || freePhysical < 2 * GiB) {
    return "Less than 2 GiB of physical memory is available.";
  }
  if (committed !== undefined || limit !== undefined) {
    if (!Number.isFinite(committed) || !Number.isFinite(limit) || committed < 0 || limit <= 0) {
      return "The Windows commit-memory counters are unavailable.";
    }
    if (limit - committed < 4 * GiB || committed / limit >= 0.8) {
      return `Windows committed memory is ${(committed / GiB).toFixed(1)}/${(limit / GiB).toFixed(1)} GiB; require at least 4 GiB free and less than 80% used.`;
    }
  }
  return undefined;
}

/** Admission only: another application can still allocate memory after this check. */
export function assertValidationMemory() {
  let sample = { freePhysical: freemem() };
  let reason = memoryPressureReason(sample);
  if (!reason && process.platform === "win32") {
    try {
      const executable = join(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      const output = execFileSync(
        executable,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$ErrorActionPreference='Stop'; Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory | Select-Object AvailableMBytes,CommittedBytes,CommitLimit | ConvertTo-Json -Compress",
        ],
        { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 16_384 },
      );
      const counters = JSON.parse(output.replace(/^\uFEFF/, "").trim());
      sample = {
        freePhysical: Number(counters.AvailableMBytes) * 1024 ** 2,
        committed: Number(counters.CommittedBytes),
        limit: Number(counters.CommitLimit),
      };
      reason = memoryPressureReason(sample);
    } catch {
      reason = "Could not verify Windows commit-memory headroom.";
    }
  }
  if (reason)
    throw new Error(`${reason} Validation was not started. Wait for other heavy tasks to finish, then retry.`);
}
