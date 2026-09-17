import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const COMPACTION_QUEUE_PATCH_SENTINEL = "pi-dynamic-workflows:lossless-compaction-queue-v1";

const UNMINIFIED_START = "async flushCompactionQueue(options) {";
const MINIFIED_START = "async flushCompactionQueue(options){";
const NEXT_METHOD = "flushPendingBashComponents()";

const unminifiedMethod = `async flushCompactionQueue(options) {
        /* ${COMPACTION_QUEUE_PATCH_SENTINEL} */
        if (this.compactionQueuedMessages.length === 0) {
            return;
        }
        const queuedMessages = [...this.compactionQueuedMessages];
        this.compactionQueuedMessages = [];
        this.updatePendingMessagesDisplay();
        let nextMessageIndex = 0;
        const restoreQueue = (error) => {
            const undispatchedMessages = queuedMessages.slice(nextMessageIndex);
            this.compactionQueuedMessages = [...undispatchedMessages, ...this.compactionQueuedMessages];
            this.updatePendingMessagesDisplay();
            this.showError(\`Failed to send queued message\${undispatchedMessages.length > 1 ? "s" : ""}: \${error instanceof Error ? error.message : String(error)}\`);
        };
        const promptUntilAccepted = (message, streamingBehavior) => new Promise((resolve, reject) => {
            let accepted = false;
            void this.session
                .prompt(message.text, {
                streamingBehavior,
                preflightResult: (success) => {
                    if (success) {
                        accepted = true;
                        resolve();
                    }
                },
            })
                .catch((error) => {
                if (!accepted) {
                    reject(error);
                }
            });
        });
        try {
            if (options?.willRetry) {
                for (const message of queuedMessages) {
                    if (this.isExtensionCommand(message.text)) {
                        await promptUntilAccepted(message);
                    }
                    else if (message.mode === "followUp") {
                        await this.session.followUp(message.text);
                    }
                    else {
                        await this.session.steer(message.text);
                    }
                    nextMessageIndex += 1;
                }
                this.updatePendingMessagesDisplay();
                return;
            }
            const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
            if (firstPromptIndex === -1) {
                for (const message of queuedMessages) {
                    await promptUntilAccepted(message);
                    nextMessageIndex += 1;
                }
                return;
            }
            for (const message of queuedMessages.slice(0, firstPromptIndex)) {
                await promptUntilAccepted(message);
                nextMessageIndex += 1;
            }
            const firstPrompt = queuedMessages[firstPromptIndex];
            await promptUntilAccepted(firstPrompt, firstPrompt.mode);
            nextMessageIndex += 1;
            for (const message of queuedMessages.slice(firstPromptIndex + 1)) {
                if (this.isExtensionCommand(message.text)) {
                    await promptUntilAccepted(message);
                }
                else if (message.mode === "followUp") {
                    await this.session.followUp(message.text);
                }
                else {
                    await this.session.steer(message.text);
                }
                nextMessageIndex += 1;
            }
            this.updatePendingMessagesDisplay();
        }
        catch (error) {
            restoreQueue(error);
        }
    }
    /** Move pending bash components from pending area to chat */
    `;

const bundledMethod = `async flushCompactionQueue(options){/* ${COMPACTION_QUEUE_PATCH_SENTINEL} */if(this.compactionQueuedMessages.length===0)return;let queuedMessages=[...this.compactionQueuedMessages];this.compactionQueuedMessages=[],this.updatePendingMessagesDisplay();let nextMessageIndex=0,restoreQueue=error=>{let undispatchedMessages=queuedMessages.slice(nextMessageIndex);this.compactionQueuedMessages=[...undispatchedMessages,...this.compactionQueuedMessages],this.updatePendingMessagesDisplay(),this.showError(\`Failed to send queued message\${undispatchedMessages.length>1?"s":""}: \${error instanceof Error?error.message:String(error)}\`)},promptUntilAccepted=(message,streamingBehavior)=>new Promise((resolve,reject)=>{let accepted=!1;void this.session.prompt(message.text,{streamingBehavior,preflightResult:success=>{success&&(accepted=!0,resolve())}}).catch(error=>{accepted||reject(error)})});try{if(options?.willRetry){for(let message of queuedMessages)this.isExtensionCommand(message.text)?await promptUntilAccepted(message):message.mode==="followUp"?await this.session.followUp(message.text):await this.session.steer(message.text),nextMessageIndex+=1;this.updatePendingMessagesDisplay();return}let firstPromptIndex=queuedMessages.findIndex(message=>!this.isExtensionCommand(message.text));if(firstPromptIndex===-1){for(let message of queuedMessages)await promptUntilAccepted(message),nextMessageIndex+=1;return}for(let message of queuedMessages.slice(0,firstPromptIndex))await promptUntilAccepted(message),nextMessageIndex+=1;let firstPrompt=queuedMessages[firstPromptIndex];await promptUntilAccepted(firstPrompt,firstPrompt.mode),nextMessageIndex+=1;for(let message of queuedMessages.slice(firstPromptIndex+1))this.isExtensionCommand(message.text)?await promptUntilAccepted(message):message.mode==="followUp"?await this.session.followUp(message.text):await this.session.steer(message.text),nextMessageIndex+=1;this.updatePendingMessagesDisplay()}catch(error){restoreQueue(error)}}`;

function locateFlushMethod(input) {
  const unminifiedStart = input.indexOf(UNMINIFIED_START);
  const bundledStart = input.indexOf(MINIFIED_START);
  const start = unminifiedStart >= 0 ? unminifiedStart : bundledStart;
  if (start < 0) throw new Error("Unsupported Pi host: flushCompactionQueue() was not found");
  if (input.indexOf(UNMINIFIED_START, start + 1) >= 0 || input.indexOf(MINIFIED_START, start + 1) >= 0) {
    throw new Error("Unsupported Pi host: multiple flushCompactionQueue() methods were found");
  }
  const nextMethod = input.indexOf(NEXT_METHOD, start);
  if (nextMethod < 0) throw new Error("Unsupported Pi host: flushCompactionQueue() boundary was not found");
  let end = nextMethod;
  if (unminifiedStart >= 0) {
    const comment = input.lastIndexOf("    /** Move pending bash components", nextMethod);
    if (comment > start) end = comment;
  }
  return { start, end, bundled: bundledStart >= 0 && bundledStart === start };
}

function assertVulnerableMethod(method) {
  const compact = method.replaceAll(/\s+/g, "");
  const anchors = [
    "this.session.clearQueue()",
    "this.compactionQueuedMessages=queuedMessages",
    "promptPromise=this.session.prompt(firstPrompt.text",
  ];
  const missing = anchors.filter((anchor) => !compact.includes(anchor));
  if (
    !compact.includes(".catch((error)=>{restoreQueue(error);})") &&
    !compact.includes(".catch(error=>{restoreQueue(error)})")
  ) {
    missing.push("prompt rejection rollback");
  }
  if (missing.length > 0) {
    throw new Error(`Unsupported Pi host: vulnerable method anchors changed (${missing.join(", ")})`);
  }
}

function assertPatchedMethod(method) {
  const compact = method.replaceAll(/\s+/g, "");
  const anchors = [
    COMPACTION_QUEUE_PATCH_SENTINEL,
    "queuedMessages.slice(nextMessageIndex)",
    "this.compactionQueuedMessages=[...undispatchedMessages,...this.compactionQueuedMessages]",
    "preflightResult:",
  ];
  const missing = anchors.filter((anchor) => !compact.includes(anchor));
  if (missing.length > 0 || compact.includes("this.session.clearQueue()")) {
    throw new Error(`Invalid Pi compaction patch (${missing.join(", ") || "queue clearing remains"})`);
  }
}

export function inspectPiCompactionSource(input) {
  try {
    const { start, end } = locateFlushMethod(input);
    const method = input.slice(start, end);
    if (method.includes(COMPACTION_QUEUE_PATCH_SENTINEL)) {
      assertPatchedMethod(method);
      return "patched";
    }
    assertVulnerableMethod(method);
    return "vulnerable";
  } catch {
    return "unsupported";
  }
}

export function patchPiCompactionSource(input) {
  if (input.includes(COMPACTION_QUEUE_PATCH_SENTINEL)) {
    const { start, end } = locateFlushMethod(input);
    assertPatchedMethod(input.slice(start, end));
    return { status: "already-patched", output: input };
  }
  const { start, end, bundled } = locateFlushMethod(input);
  assertVulnerableMethod(input.slice(start, end));
  const replacement = bundled ? bundledMethod : unminifiedMethod;
  return { status: "patched", output: input.slice(0, start) + replacement + input.slice(end) };
}

function walkJavaScriptFiles(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkJavaScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files;
}

export function discoverPiCompactionTargets(packageRoot) {
  const root = resolve(packageRoot);
  const packageJsonPath = join(root, "package.json");
  if (!existsSync(packageJsonPath)) throw new Error(`Pi package.json not found: ${packageJsonPath}`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (packageJson.name !== "@earendil-works/pi-coding-agent") {
    throw new Error(`Unexpected package at ${root}: ${packageJson.name ?? "unknown"}`);
  }
  if (!/^0\.(84|85)\./.test(String(packageJson.version))) {
    throw new Error(`Unsupported Pi version ${packageJson.version}; expected 0.84.x or 0.85.x`);
  }
  const agentSession = join(root, "dist", "core", "agent-session.js");
  if (!existsSync(agentSession) || !readFileSync(agentSession, "utf8").includes("preflightResult")) {
    throw new Error(`Pi ${packageJson.version} does not expose the required prompt preflight callback`);
  }
  const interactive = join(root, "dist", "modes", "interactive", "interactive-mode.js");
  const bundleChunks = walkJavaScriptFiles(join(root, "dist", "bundle", "chunks")).filter((file) => {
    const source = readFileSync(file, "utf8");
    return source.includes(UNMINIFIED_START) || source.includes(MINIFIED_START);
  });
  if (!existsSync(interactive)) throw new Error(`Pi interactive host not found: ${interactive}`);
  const expectsBundle = /^0\.85\./.test(String(packageJson.version));
  if (bundleChunks.length > 1 || (expectsBundle && bundleChunks.length !== 1)) {
    throw new Error(
      `Expected ${expectsBundle ? "exactly one" : "at most one"} bundled Pi compaction host, found ${bundleChunks.length}`,
    );
  }
  return [interactive, ...bundleChunks];
}

export function patchPiCompactionFiles(files, { check = false } = {}) {
  const plans = files.map((file) => {
    const path = resolve(file);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Pi host file not found: ${path}`);
    const input = readFileSync(path, "utf8");
    if (check) return { path, status: inspectPiCompactionSource(input), input, output: input };
    return { path, input, ...patchPiCompactionSource(input) };
  });
  if (check) return plans.map(({ path, status }) => ({ path, status }));

  const written = [];
  try {
    for (const plan of plans) {
      if (plan.status !== "patched") continue;
      const baseBackup = `${plan.path}.compaction-queue-original`;
      let backup = baseBackup;
      if (existsSync(baseBackup) && readFileSync(baseBackup, "utf8") !== plan.input) {
        const digest = createHash("sha256").update(plan.input).digest("hex").slice(0, 12);
        backup = `${baseBackup}.${digest}`;
        if (existsSync(backup) && readFileSync(backup, "utf8") !== plan.input) {
          throw new Error(`Backup hash collision for ${plan.path}`);
        }
      }
      if (!existsSync(backup)) copyFileSync(plan.path, backup);
      writeFileSync(plan.path, plan.output, "utf8");
      written.push({ path: plan.path, backup });
    }
  } catch (error) {
    for (const item of written.reverse()) copyFileSync(item.backup, item.path);
    throw error;
  }
  return plans.map(({ path, status }) => ({ path, status }));
}

function globalPiPackageRoot() {
  const globalRoot =
    process.platform === "win32"
      ? execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "npm root -g"], {
          encoding: "utf8",
          windowsHide: true,
        }).trim()
      : execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  return join(globalRoot, "@earendil-works", "pi-coding-agent");
}

function parseArguments(argv) {
  let check = false;
  let packageRoot;
  let useGlobal = false;
  const files = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--check") check = true;
    else if (arg === "--global") useGlobal = true;
    else if (arg === "--package-root") {
      packageRoot = argv[++index];
      if (!packageRoot) throw new Error("--package-root requires a path");
    } else files.push(arg);
  }
  const selectors = Number(useGlobal) + Number(Boolean(packageRoot)) + Number(files.length > 0);
  if (selectors !== 1) {
    throw new Error("Use exactly one target form: --global, --package-root <path>, or explicit host files");
  }
  if (useGlobal) packageRoot = globalPiPackageRoot();
  return { check, files: packageRoot ? discoverPiCompactionTargets(packageRoot) : files };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    const { check, files } = parseArguments(process.argv.slice(2));
    const results = patchPiCompactionFiles(files, { check });
    for (const result of results) console.log(`${result.status}: ${result.path}`);
    if (check && results.some(({ status }) => status !== "patched")) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
