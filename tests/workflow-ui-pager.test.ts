import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import type { AgentHistoryEntry } from "../src/agent-history.js";
import type { WorkflowAgentSnapshot, WorkflowSnapshot } from "../src/display.js";
import type { PersistedRunState } from "../src/run-persistence.js";
import type { ManagedRun, WorkflowManager } from "../src/workflow-manager.js";
import { keyToAction, NavigatorModel, NavigatorState, renderNavigator } from "../src/workflow-ui.js";

function modelForAgent(agent: WorkflowAgentSnapshot, status: PersistedRunState["status"] = "running"): NavigatorModel {
  const snapshot: WorkflowSnapshot = {
    name: "pager-demo",
    phases: ["Work"],
    currentPhase: "Work",
    logs: [],
    agents: [agent],
    agentCount: 1,
    runningCount: agent.status === "running" ? 1 : 0,
    doneCount: agent.status === "done" ? 1 : 0,
    errorCount: agent.status === "error" ? 1 : 0,
  };
  const persisted: PersistedRunState = {
    runId: "pager-run",
    workflowName: "pager-demo",
    status,
    phases: ["Work"],
    agents: snapshot.agents,
    logs: [],
    script: "",
    startedAt: "",
    updatedAt: "",
  };
  const manager = {
    listRuns: () => [persisted],
    getRun: () => ({ runId: "pager-run", status, snapshot }) as unknown as ManagedRun,
  } satisfies Pick<WorkflowManager, "listRuns" | "getRun">;
  return new NavigatorModel(manager);
}

function enterAgentDetail(model: NavigatorModel): NavigatorState {
  const state = new NavigatorState();
  assert.equal(state.drill(model), true);
  assert.equal(state.drill(model), true);
  assert.equal(state.drill(model), true);
  assert.equal(state.kind, "detail");
  return state;
}

const plainMarkdownTheme: MarkdownTheme = {
  heading: (text) => text,
  link: (text) => text,
  linkUrl: (text) => text,
  code: (text) => text,
  codeBlock: (text) => text,
  codeBlockBorder: (text) => text,
  quote: (text) => text,
  quoteBorder: (text) => text,
  hr: (text) => text,
  listBullet: (text) => text,
  bold: (text) => text,
  italic: (text) => text,
  strikethrough: (text) => text,
  underline: (text) => text,
  highlightCode: (code, language) => code.split("\n").map((line) => `[${language}] ${line}`),
};

test("activity key mappings include block pages, boundaries, follow, and expansion", () => {
  assert.deepEqual(keyToAction("enter", "detail"), { type: "togglePager" });
  assert.deepEqual(keyToAction("right", "detail"), { type: "openPager" });
  assert.deepEqual(keyToAction("pageUp", "detail"), { type: "page", direction: -1 });
  assert.deepEqual(keyToAction("pageDown", "detail"), { type: "page", direction: 1 });
  assert.deepEqual(keyToAction("home", "detail"), { type: "jump", edge: "start" });
  assert.deepEqual(keyToAction("end", "detail"), { type: "jump", edge: "end" });
  assert.deepEqual(keyToAction("t", "detail"), { type: "toggleTail" });
  assert.deepEqual(keyToAction("t", "runs"), { type: "none" });
});

test("opening agent activity is idempotent", () => {
  const model = modelForAgent({ id: 1, label: "worker", phase: "Work", prompt: "work", status: "running" });
  const state = enterAgentDetail(model);

  assert.equal(state.openPager(), true);
  state.cursor = 4;
  assert.equal(state.openPager(), true);
  assert.equal(state.pagerOpen, true);
  assert.equal(state.cursor, 4, "opening an existing activity view does not reset its block selection");
});

test("completed agents default to a result summary and progressively disclose semantic blocks", () => {
  const model = modelForAgent({
    id: 1,
    label: "completed worker",
    phase: "Work",
    prompt: "private prompt",
    status: "done",
    result: { verdict: "complete", files: ["src/a.ts"] },
    resultPreview: "compact fallback",
    history: [{ role: "assistant", kind: "text", text: "old history" }],
  });
  const state = enterAgentDetail(model);

  const summary = renderNavigator(state, model, 80, undefined, 20, plainMarkdownTheme).join("\n");
  assert.match(summary, /complete/);
  assert.doesNotMatch(summary, /private prompt/);
  assert.doesNotMatch(summary, /old history/);
  assert.match(summary, /enter activity/);

  state.togglePager();
  const activity = renderNavigator(state, model, 80, undefined, 20, plainMarkdownTheme).join("\n");
  assert.match(activity, /Task {2}private prompt/);
  assert.match(activity, /Model output {2}old history/);
  assert.match(activity, /Final result/);
  assert.doesNotMatch(activity, /\[json\]/, "collapsed blocks do not dump raw payloads");

  state.jump("end", 3);
  state.togglePager();
  const expanded = renderNavigator(state, model, 80, undefined, 20, plainMarkdownTheme).join("\n");
  assert.match(expanded, /Final result detail/);
  assert.match(expanded, /\[json\]/);
});

test("active agent summary shows the task, current semantic activity, and counts", () => {
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "text", text: "old event" },
    { role: "assistant", kind: "text", text: "recent event one" },
    { role: "tool", kind: "toolResult", toolName: "read", text: "recent event two" },
  ];
  const model = modelForAgent({
    id: 1,
    label: "active worker",
    phase: "Work",
    prompt: "inspect the project",
    status: "running",
    history,
  });
  const state = enterAgentDetail(model);
  const summary = renderNavigator(state, model, 80, undefined, 30).join("\n");

  assert.match(summary, /inspect the project/);
  assert.match(summary, /recent event two/);
  assert.match(summary, /1 tool · 2 models/);
  assert.doesNotMatch(summary, /recent event one/, "older model output stays folded in the activity view");
  assert.doesNotMatch(summary, /old event/);

  state.openPager();
  const activity = renderNavigator(state, model, 80, undefined, 30).join("\n");
  assert.match(activity, /Model output {2}recent event one/);
  assert.match(activity, /Tool result · read {2}recent event two/);
});

test("follow mode tracks appended blocks and moving up disables follow", () => {
  const history: AgentHistoryEntry[] = Array.from({ length: 20 }, (_, index) => ({
    role: "assistant",
    kind: "text",
    text: `event ${index}`,
  }));
  const model = modelForAgent({
    id: 1,
    label: "tail worker",
    phase: "Work",
    prompt: "keep working",
    status: "running",
    history,
  });
  const state = enterAgentDetail(model);

  assert.equal(state.toggleTail(), true);
  renderNavigator(state, model, 80, undefined, 12);
  const previousCursor = state.cursor;
  history.push({ role: "assistant", kind: "text", text: "new tail event" });
  const tailed = renderNavigator(state, model, 80, undefined, 12).join("\n");
  assert.ok(state.cursor > previousCursor);
  assert.match(tailed, /follow/);

  state.move(-1, history.length + 1);
  assert.equal(state.tailing, false);
  state.jump("end", history.length + 1);
  assert.equal(state.tailing, true);
});

test("escape closes the pager before leaving agent detail", () => {
  const model = modelForAgent({ id: 1, label: "worker", phase: "Work", prompt: "work", status: "running" });
  const state = enterAgentDetail(model);
  state.togglePager();

  assert.equal(state.back(), true);
  assert.equal(state.kind, "detail");
  assert.equal(state.pagerOpen, false);
  assert.equal(state.back(), true);
  assert.equal(state.kind, "agents");
});

test("activity footer describes block navigation and escape returns to summary", () => {
  const model = modelForAgent({ id: 1, label: "worker", phase: "Work", prompt: "work", status: "running" });
  const state = enterAgentDetail(model);
  state.togglePager();

  const footer = renderNavigator(state, model, 80, undefined, 20, plainMarkdownTheme).join("\n");
  assert.match(footer, /↑\/↓ block/);
  assert.match(footer, /enter expand/);
  assert.match(footer, /esc summary/);
  assert.doesNotMatch(footer, /↑\/↓ line/);
});

test("raw read results inherit syntax highlighting from the requested path", () => {
  const history: AgentHistoryEntry[] = [
    { role: "assistant", kind: "toolCall", toolName: "read", text: '{"path":"src/example.ts"}' },
    { role: "tool", kind: "toolResult", toolName: "read", text: "const answer: number = 42;" },
  ];
  const model = modelForAgent({
    id: 1,
    label: "reader",
    phase: "Work",
    prompt: "read it",
    status: "running",
    history,
  });
  const state = enterAgentDetail(model);
  state.togglePager();
  state.move(1, 2);
  state.togglePager();
  const text = renderNavigator(state, model, 100, undefined, 30, plainMarkdownTheme).join("\n");

  assert.match(text, /\[typescript\] const answer: number = 42;/);
  assert.match(text, /\[json\] \{"path":"src\/example.ts"\}/);
});

test("write calls render source code instead of a raw JSON argument envelope", () => {
  const history: AgentHistoryEntry[] = [
    {
      role: "assistant",
      kind: "toolCall",
      toolName: "write",
      path: "src/example.rs",
      text: "use uuid::Uuid;\n\npub struct Example;",
    },
    { role: "tool", kind: "toolResult", toolName: "write", text: "Successfully wrote 42 bytes" },
  ];
  const model = modelForAgent({
    id: 1,
    label: "writer",
    phase: "Work",
    prompt: "write it",
    status: "running",
    history,
  });
  const state = enterAgentDetail(model);
  state.togglePager();
  state.move(1, 2);
  state.togglePager();
  const text = renderNavigator(state, model, 100, undefined, 30, plainMarkdownTheme).join("\n");

  assert.match(text, /assistant tool write: src\/example\.rs/);
  assert.match(text, /\[rust\] use uuid::Uuid;/);
  assert.doesNotMatch(text, /"content":/);
});

test("edit calls render with Pi's native diff view instead of replacement JSON", () => {
  initTheme("dark");
  const history: AgentHistoryEntry[] = [
    {
      role: "assistant",
      kind: "toolCall",
      toolName: "edit",
      path: "src/example.ts",
      text: '{"path":"src/example.ts","edits":[{"oldText":"old value","newText":"new value"}]}',
    },
    {
      role: "tool",
      kind: "toolResult",
      toolName: "edit",
      text: "Successfully replaced 1 block(s) in src/example.ts.",
      diff: " 1 before\n-2 old value\n+2 new value\n 3 after",
    },
  ];
  const model = modelForAgent({
    id: 1,
    label: "editor",
    phase: "Work",
    prompt: "edit it",
    status: "running",
    history,
  });
  const state = enterAgentDetail(model);
  state.togglePager();
  state.move(1, 2);
  state.togglePager();
  const text = renderNavigator(state, model, 100, undefined, 30, plainMarkdownTheme).join("\n");

  assert.match(text, /assistant tool edit: src\/example\.ts/);
  assert.match(text, /-2 old value/);
  assert.match(text, /\+2 new value/);
  assert.doesNotMatch(text, /oldText/);
});

test("short pagers and long run lists stay within their viewport", () => {
  const longResult = "Z".repeat(2000);
  const detailModel = modelForAgent({
    id: 1,
    label: "long worker",
    phase: "Work",
    prompt: "work",
    status: "done",
    result: longResult,
  });
  const detailState = enterAgentDetail(detailModel);
  detailState.togglePager();
  assert.ok(renderNavigator(detailState, detailModel, 40, undefined, 6).length <= 6);

  const runs = Array.from({ length: 20 }, (_, index) => ({
    runId: `run-${index}`,
    workflowName: `workflow-${index}`,
    status: "completed" as const,
    phases: [],
    agents: [],
    logs: [],
    script: "",
    startedAt: "",
    updatedAt: "",
  }));
  const runsModel = new NavigatorModel({ listRuns: () => runs, getRun: () => undefined });
  const runsState = new NavigatorState();
  runsState.jump("end", runs.length);
  const lines = renderNavigator(runsState, runsModel, 80, undefined, 10);
  assert.ok(lines.length <= 10);
  assert.match(lines.join("\n"), /workflow-19/);
});

test("cold journal rehydration keeps nested and parent call indexes separate", () => {
  const persisted = {
    runId: "parent-run",
    workflowName: "nested",
    status: "paused",
    phases: ["Work"],
    agents: [
      {
        id: 1,
        callId: "parent-run-nested1:0",
        label: "nested worker",
        phase: "Work",
        prompt: "nested",
        status: "done",
      },
      {
        id: 2,
        callId: "parent-run:0",
        label: "parent worker",
        phase: "Work",
        prompt: "parent",
        status: "done",
      },
    ],
    journal: [
      { index: 0, runId: "parent-run", hash: "parent", result: "parent result" },
      { index: 0, runId: "parent-run-nested1", hash: "nested", result: "nested result" },
    ],
    logs: [],
    script: "",
    startedAt: "",
    updatedAt: "",
  } as PersistedRunState;
  const model = new NavigatorModel({ listRuns: () => [persisted], getRun: () => undefined });

  assert.equal(model.agentDetail("parent-run", 1)?.result, "nested result");
  assert.equal(model.agentDetail("parent-run", 2)?.result, "parent result");
});

test("legacy persisted result previews remain visible", () => {
  const persisted = {
    runId: "legacy",
    workflowName: "legacy",
    status: "completed",
    phases: ["Work"],
    agents: [
      {
        id: 1,
        label: "legacy worker",
        phase: "Work",
        prompt: "old prompt",
        status: "done",
        resultPreview: "legacy final preview",
      },
    ],
    logs: [],
    script: "",
    startedAt: "",
    updatedAt: "",
  } as PersistedRunState;
  const model = new NavigatorModel({ listRuns: () => [persisted], getRun: () => undefined });
  const state = enterAgentDetail(model);
  assert.match(renderNavigator(state, model, 80).join("\n"), /legacy final preview/);
});
