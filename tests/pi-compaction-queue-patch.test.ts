import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  COMPACTION_QUEUE_PATCH_SENTINEL,
  discoverPiCompactionTargets,
  inspectPiCompactionSource,
  patchPiCompactionFiles,
  patchPiCompactionSource,
} from "../scripts/patch-pi-compaction-queue.mjs";

const vulnerableMethod = `async flushCompactionQueue(options){if(this.compactionQueuedMessages.length===0)return;let queuedMessages=[...this.compactionQueuedMessages];this.compactionQueuedMessages=[],this.updatePendingMessagesDisplay();let restoreQueue=error=>{this.session.clearQueue(),this.compactionQueuedMessages=queuedMessages,this.updatePendingMessagesDisplay(),this.showError(\`Failed to send queued message\${queuedMessages.length>1?"s":""}: \${error instanceof Error?error.message:String(error)}\`)};try{if(options?.willRetry){for(let message of queuedMessages)this.isExtensionCommand(message.text)?await this.session.prompt(message.text):message.mode==="followUp"?await this.session.followUp(message.text):await this.session.steer(message.text);this.updatePendingMessagesDisplay();return}let firstPromptIndex=queuedMessages.findIndex(message=>!this.isExtensionCommand(message.text));if(firstPromptIndex===-1){for(let message of queuedMessages)await this.session.prompt(message.text);return}let preCommands=queuedMessages.slice(0,firstPromptIndex),firstPrompt=queuedMessages[firstPromptIndex],rest=queuedMessages.slice(firstPromptIndex+1);for(let message of preCommands)await this.session.prompt(message.text);let promptPromise=this.session.prompt(firstPrompt.text,{streamingBehavior:firstPrompt.mode}).catch(error=>{restoreQueue(error)});for(let message of rest)this.isExtensionCommand(message.text)?await this.session.prompt(message.text):message.mode==="followUp"?await this.session.followUp(message.text):await this.session.steer(message.text);this.updatePendingMessagesDisplay()}catch(error){restoreQueue(error)}}`;

const vulnerableHostSource = `export class Host {
  isExtensionCommand(text) { return text.startsWith("/"); }
  ${vulnerableMethod}
  flushPendingBashComponents() {}
}`;

async function loadPatchedHost() {
  const { output } = patchPiCompactionSource(vulnerableHostSource);
  const url = `data:text/javascript;base64,${Buffer.from(output).toString("base64")}#${Math.random()}`;
  return (await import(url)).Host as new () => any;
}

test("patch waits for prompt admission instead of the accepted run's final outcome", async () => {
  const Host = await loadPatchedHost();
  const host = new Host();
  let rejectAcceptedRun!: (error: Error) => void;
  let clearCalls = 0;
  const followUps: string[] = [];
  const errors: string[] = [];
  host.compactionQueuedMessages = [
    { text: "A", mode: "steer" },
    { text: "B", mode: "followUp" },
  ];
  host.updatePendingMessagesDisplay = () => {};
  host.showError = (message: string) => errors.push(message);
  host.session = {
    clearQueue: () => {
      clearCalls += 1;
    },
    prompt: (_text: string, options: any) => {
      options.preflightResult(true);
      return new Promise<void>((_resolve, reject) => {
        rejectAcceptedRun = reject;
      });
    },
    followUp: async (text: string) => {
      followUps.push(text);
    },
    steer: async () => {},
  };

  await host.flushCompactionQueue({});
  assert.deepEqual(followUps, ["B"]);
  assert.deepEqual(host.compactionQueuedMessages, []);

  rejectAcceptedRun(new Error("late provider failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clearCalls, 0);
  assert.deepEqual(host.compactionQueuedMessages, []);
  assert.deepEqual(errors, []);
});

test("patch restores only the failed suffix ahead of concurrently queued input", async () => {
  const Host = await loadPatchedHost();
  const host = new Host();
  let clearCalls = 0;
  const followUps: string[] = [];
  const errors: string[] = [];
  host.compactionQueuedMessages = [
    { text: "A", mode: "steer" },
    { text: "B", mode: "followUp" },
    { text: "C", mode: "followUp" },
  ];
  host.updatePendingMessagesDisplay = () => {};
  host.showError = (message: string) => errors.push(message);
  host.session = {
    clearQueue: () => {
      clearCalls += 1;
    },
    prompt: async (_text: string, options: any) => {
      options.preflightResult(true);
    },
    followUp: async (text: string) => {
      followUps.push(text);
      if (text === "C") {
        host.compactionQueuedMessages.push({ text: "D", mode: "followUp" });
        throw new Error("dispatch failed");
      }
    },
    steer: async () => {},
  };

  await host.flushCompactionQueue({});
  assert.deepEqual(followUps, ["B", "C"]);
  assert.deepEqual(host.compactionQueuedMessages, [
    { text: "C", mode: "followUp" },
    { text: "D", mode: "followUp" },
  ]);
  assert.equal(clearCalls, 0);
  assert.equal(errors.length, 1);
});

test("file patch is fail-closed, backed up, and idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "pi-compaction-patch-"));
  const file = join(directory, "interactive-mode.js");
  try {
    writeFileSync(file, vulnerableHostSource);
    assert.equal(inspectPiCompactionSource(vulnerableHostSource), "vulnerable");
    assert.deepEqual(patchPiCompactionFiles([file]), [{ path: file, status: "patched" }]);
    const patched = readFileSync(file, "utf8");
    assert.match(patched, new RegExp(COMPACTION_QUEUE_PATCH_SENTINEL));
    assert.doesNotMatch(patched, /session\.clearQueue/);
    assert.equal(readFileSync(`${file}.compaction-queue-original`, "utf8"), vulnerableHostSource);
    assert.deepEqual(patchPiCompactionFiles([file]), [{ path: file, status: "already-patched" }]);
    assert.deepEqual(patchPiCompactionFiles([file], { check: true }), [{ path: file, status: "patched" }]);
    assert.throws(() => patchPiCompactionSource("class Host {}"), /flushCompactionQueue/);

    const upgradedFile = join(directory, "upgraded-interactive-mode.js");
    writeFileSync(upgradedFile, vulnerableHostSource);
    writeFileSync(`${upgradedFile}.compaction-queue-original`, "stale host backup");
    patchPiCompactionFiles([upgradedFile]);
    const digest = createHash("sha256").update(vulnerableHostSource).digest("hex").slice(0, 12);
    assert.equal(readFileSync(`${upgradedFile}.compaction-queue-original.${digest}`, "utf8"), vulnerableHostSource);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("package discovery requires supported preflight hosts and finds the CLI bundle", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-compaction-package-"));
  try {
    const interactive = join(root, "dist", "modes", "interactive", "interactive-mode.js");
    const agentSession = join(root, "dist", "core", "agent-session.js");
    const bundle = join(root, "dist", "bundle", "chunks", "chunk-host.js");
    mkdirSync(join(root, "dist", "modes", "interactive"), { recursive: true });
    mkdirSync(join(root, "dist", "core"), { recursive: true });
    mkdirSync(join(root, "dist", "bundle", "chunks"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.85.1" }),
    );
    writeFileSync(agentSession, "const preflightResult = true;");
    writeFileSync(interactive, vulnerableHostSource);
    writeFileSync(bundle, vulnerableHostSource);
    assert.deepEqual(discoverPiCompactionTargets(root), [interactive, bundle]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("patch recognizes every host used by the repository's installed Pi fixture", () => {
  const packageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
  const targets = discoverPiCompactionTargets(packageRoot);
  assert.ok(targets.length >= 1 && targets.length <= 2);
  for (const target of targets) {
    const source = readFileSync(target, "utf8");
    assert.notEqual(inspectPiCompactionSource(source), "unsupported", target);
    const { output } = patchPiCompactionSource(source);
    assert.match(output, new RegExp(COMPACTION_QUEUE_PATCH_SENTINEL), target);
  }
});
