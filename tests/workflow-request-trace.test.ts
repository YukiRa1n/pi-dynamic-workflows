import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { installWorkflowRequestTrace, requestTracePath, serializeRequestTrace } from "../src/workflow-request-trace.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

test("trace preserves report text, omits credentials and does not mutate payload", () => {
  const payload = {
    input: [{ role: "user", content: "检查返回的证据" }],
    api_key: "secret",
    encrypted_content: "opaque",
  };
  const result = serializeRequestTrace(payload);
  assert.match(result.text, /检查返回的证据/);
  assert.doesNotMatch(result.text, /secret|opaque/);
  assert.equal(payload.api_key, "secret");
  assert.equal(result.truncated, false);
});

test("actual Pi runner traces the replacement from the last payload handler", {
  skip: !ExtensionRunner.prototype.emitBeforeProviderRequest.toString().includes("provider_request_prepared"),
}, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-final-trace-"));
  try {
    await withFakeHomeAsync(home, async () => {
      const handlers = new Map<string, any[]>();
      const ctx = {
        sessionManager: { getSessionId: () => "trace-test" },
        model: { id: "test", provider: "local" },
        ui: { notify: () => {} },
      };
      installWorkflowRequestTrace({
        on: (name: string, fn: any) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
        registerCommand: () => {},
      } as any);
      for (const fn of handlers.get("session_start") ?? []) fn({}, ctx);
      const lastPayload = {
        input: [
          { type: "function_call_output", call_id: "wait", output: "实质结论：边界校验缺失，证据 example.ts:12" },
        ],
      };
      const receiver = {
        extensions: [
          { path: "trace", handlers },
          { path: "last-mutator", handlers: new Map([["before_provider_request", [() => lastPayload]]]) },
        ],
        createContext: () => ctx,
        emitError: (err: unknown) => {
          throw err;
        },
        emit: async (event: any) => {
          for (const fn of handlers.get(event.type) ?? []) await fn(event, ctx);
        },
      };
      const returned = await ExtensionRunner.prototype.emitBeforeProviderRequest.call(receiver as any, {
        input: "old payload",
      });
      assert.equal(returned, lastPayload);
      const records = readFileSync(requestTracePath("trace-test"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const final = records.find((row) => row.stage === "provider-request-prepared");
      assert.ok(final, "installed Pi must include the final-observer patch");
      assert.match(final.text, /实质结论/);
      assert.doesNotMatch(final.text, /old payload/);
      assert.deepEqual(JSON.parse(final.text), lastPayload);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
