import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { parseNpmPackFilePaths } from "../../src/workflow-release-gate.js";

let cached: string[] | undefined;

/** One immutable package snapshot per test process; tests mutate only copies. */
export function publishableFiles(): string[] {
  if (!cached) {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const output = execSync(`${npmCommand} pack --dry-run --json --ignore-scripts`, {
      cwd: resolve(import.meta.dirname, "../.."),
      encoding: "utf8",
      windowsHide: true,
    });
    cached = parseNpmPackFilePaths(output);
  }
  return [...cached];
}
