import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import "./test-process.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const list = args.includes("--list");
const selectors = args.filter((arg) => arg !== "--list");
const available = readdirSync(resolve(root, "tests"))
  .filter((name) => name.endsWith(".test.ts"))
  .sort();
let selected = [];

if (selectors.length === 1 && selectors[0] === "--all") {
  selected = available;
} else {
  for (const selector of selectors) {
    const name = selector.replaceAll("\\", "/").replace(/^tests\//, "");
    const matches = available.includes(name) ? [name] : available.filter((file) => file.startsWith(name));
    if (!name || name.includes("/") || matches.length === 0) {
      console.error(`No test files match: ${selector}`);
      process.exit(2);
    }
    selected.push(...matches);
  }
  selected = [...new Set(selected)];
}

if (selected.length === 0) {
  console.error("Usage: npm run test:focus -- <test filename or prefix> [more prefixes] [--list]");
  console.error("Example: npm run test:focus -- workflow-steering");
  process.exit(2);
}

if (list) {
  console.log(selected.map((name) => `tests/${name}`).join("\n"));
} else {
  console.log(`Running ${selected.length} test file(s), serially.`);
  const child = spawn(
    process.execPath,
    [
      "--v8-pool-size=2",
      "--import",
      new URL("./test-process.mjs", import.meta.url).href,
      "--import",
      "tsx",
      "--test",
      "--test-reporter=spec",
      "--experimental-test-isolation=none",
      ...selected.map((name) => `tests/${name}`),
    ],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  const interrupt = (signal) => child.kill(signal);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    process.exitCode = code ?? 1;
  });
}
