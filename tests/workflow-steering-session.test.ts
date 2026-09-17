import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { installFollowUpPriority } from "../extensions/follow-up-priority.js";
import { withFakeHomeAsync } from "./helpers/fake-home.js";

function followUpIdFromContext(messages: any[]): string {
  const text = messages
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text)
          : [],
    )
    .join("\n");
  const match = text.match(/<pending-user-follow-up id="([^"]+)"/);
  assert.ok(match, "provider context contains the active follow-up identity");
  return match[1];
}

test("real Pi session retires steering after a visible reply across tools, notifications and reload", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-steering-session-"));
  try {
    await withFakeHomeAsync(root, async () => {
      const core = createFauxCore({
        provider: "steering-test",
        models: [{ id: "faux", contextWindow: 128000, maxTokens: 1024 }],
      });
      const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null });
      runtime.registerProvider("steering-test", {
        name: "Steering Test",
        baseUrl: "http://127.0.0.1:9/unused",
        apiKey: "unused-faux-key",
        api: core.api,
        streamSimple: core.streamSimple as never,
        models: [
          {
            id: "faux",
            name: "Faux",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 1024,
          },
        ],
      });
      const manager = SessionManager.create(root, join(root, "sessions"));
      const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const requests: string[] = [];
      const errors: unknown[] = [];
      const model = runtime.getModel("steering-test", "faux");
      assert.ok(model);
      const makeSession = async () => {
        const loader = new DefaultResourceLoader({
          cwd: root,
          agentDir: root,
          settingsManager: settings,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionFactories: [installFollowUpPriority],
        });
        await loader.reload();
        const { session } = await createAgentSession({
          cwd: root,
          agentDir: root,
          modelRuntime: runtime,
          model,
          sessionManager: manager,
          settingsManager: settings,
          resourceLoader: loader,
          tools: ["audit_tick"],
          customTools: [
            {
              name: "audit_tick",
              label: "Audit tick",
              description: "Advance the test once.",
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "next step" }], details: {} };
              },
            },
          ],
        });
        await session.bindExtensions({ mode: "rpc", onError: (error) => errors.push(error) });
        return session;
      };
      let session = await makeSession();
      try {
        core.setResponses([
          async (context) => {
            requests.push(JSON.stringify(context.messages));
            await session.prompt("What is the status?", { source: "rpc", streamingBehavior: "steer" });
            return fauxAssistantMessage("Initial work is underway.");
          },
          (context) => {
            requests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(
              [
                { type: "text", text: "Your status question is answered; continuing the remaining check." },
                fauxToolCall("audit_tick", {}),
              ],
              { stopReason: "toolUse" },
            );
          },
          (context) => {
            requests.push(JSON.stringify(context.messages));
            const followUpId = followUpIdFromContext(context.messages);
            return fauxAssistantMessage(`Remaining check completed.\n<!-- pi-follow-up-done:${followUpId} -->`);
          },
        ]);
        await session.prompt("Run the check.", { source: "rpc" });
        assert.equal(requests.length, 3);
        assert.match(requests[1], /pending-user-follow-up/);
        assert.match(requests[1], /todowrite or equivalent/);
        assert.match(requests[2], /pending-user-follow-up/, "tool-use progress does not retire the follow-up");
        const history = manager
          .getBranch()
          .filter((entry) => entry.type === "message")
          .map((entry: any) => entry.message);
        const steer = history.find((message: any) => message.followUpPriorityKind === "steer");
        const receipt = history.find((message: any) => Array.isArray(message.followUpPriorityAcknowledged));
        assert.ok(steer?.followUpPriorityId, "the real input/message_end path persists its identity");
        assert.deepEqual(receipt?.followUpPriorityAcknowledged, [steer.followUpPriorityId]);
        assert.doesNotMatch(JSON.stringify(receipt?.content), /pi-follow-up-done/, "hidden receipts are stripped");

        session.dispose();
        session = await makeSession();
        core.setResponses([
          (context) => {
            requests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage("New background result noted.");
          },
        ]);
        await session.sendCustomMessage(
          {
            customType: "audit-background",
            content: "A new background result is available.",
            display: false,
          },
          { triggerTurn: true },
        );
        assert.doesNotMatch(
          requests.at(-1) ?? "",
          /pending-user-follow-up|followUpPriorityId|followUpPriorityAcknowledged|workflowSteeringId|workflowSteeringAcknowledged/,
        );
        assert.deepEqual(errors, []);
      } finally {
        session.dispose();
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
