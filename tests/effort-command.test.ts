import assert from "node:assert/strict";
import test from "node:test";
import { createEffortState, effortDirective, isSubstantive, registerEffortCommand } from "../src/effort-command.js";

test("effortDirective shapes fan-out without inventing token budgets", () => {
  const high = effortDirective("high") ?? "";
  const ultra = effortDirective("ultra") ?? "";

  assert.equal(effortDirective("off"), undefined);
  assert.match(high, /effort: high/i);
  assert.match(high, /independent parallel/i);
  assert.match(ultra, /effort: ultra/i);
  assert.match(ultra, /adversarial verification/i);
  assert.doesNotMatch(high, /tokenBudget|maxAgents|concurrency/i);
  assert.doesNotMatch(ultra, /tokenBudget|maxAgents|concurrency/i);
});

test("isSubstantive accepts real requests, rejects terse text and slash commands", () => {
  assert.equal(isSubstantive("audit the auth module for race conditions"), true);
  assert.equal(isSubstantive("ok"), false);
  assert.equal(isSubstantive("/workflows"), false);
  assert.equal(isSubstantive("    "), false);
});

type CmdDef = { handler: (a: string, c: unknown) => Promise<void> };

function registerAndCapture(state: ReturnType<typeof createEffortState>) {
  const cmds = new Map<string, CmdDef>();
  const pi = {
    registerCommand: (name: string, d: unknown) => cmds.set(name, d as CmdDef),
    sendMessage: () => {},
  };
  registerEffortCommand(pi as never, state);
  return cmds;
}

test("registerEffortCommand: /effort toggles the shared state", async () => {
  const state = createEffortState();
  const effort = registerAndCapture(state).get("effort");
  assert.ok(effort, "/effort registered");
  assert.equal(state.level, "off");

  await effort?.handler("ultra", {});
  assert.equal(state.level, "ultra");
  await effort?.handler("high", {});
  assert.equal(state.level, "high");
  await effort?.handler("off", {});
  assert.equal(state.level, "off");
  await effort?.handler("bogus", {});
  assert.equal(state.level, "off", "unknown arg leaves the level unchanged");
});

test("registerEffortCommand: /ultracode turns ultra on, /ultracode off turns it off", async () => {
  const state = createEffortState();
  const ultracode = registerAndCapture(state).get("ultracode");
  assert.ok(ultracode, "/ultracode registered");

  await ultracode?.handler("", {});
  assert.equal(state.level, "ultra", "/ultracode (no arg) sets ultra");
  await ultracode?.handler("off", {});
  assert.equal(state.level, "off", "/ultracode off turns it off");
  await ultracode?.handler("anything", {});
  assert.equal(state.level, "ultra", "/ultracode <anything-but-off> sets ultra");
});
