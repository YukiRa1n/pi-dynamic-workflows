/** In-memory showcase for the workflow progress UI. */
import { fileURLToPath } from "node:url";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clearTokenSamples, renderPanel, renderPanelDetailed } from "./task-panel.js";
/** Small real workflow: no repository scanning, nested runs, or fabricated usage. */
export const LIVE_WORKFLOW_DEMO_SCRIPT = `export const meta = {
  name: "pi_live_demo",
  description: "主会话真实 UI 演示：两个子代理检查固定样例",
  phases: [{ title: "并行检查" }, { title: "汇总" }]
};
phase("并行检查");
const reports = await parallel([
  () => agent("这是 DEMO 固定样例，不是用户项目。函数 mean(xs) { return xs.reduce((a,b)=>a+b,0)/xs.length; }。只分析空数组情况，不调用工具、不读文件。用不超过100字给出：实际结果、原因、一个修复建议。明确标记为演示发现。", { label: "边界检查" }),
  () => agent("这是 DEMO 固定样例，不是用户项目。函数 mean(xs) { return xs.reduce((a,b)=>a+b,0)/xs.length; }。只分析 [2,4,6] 与 [0]，不调用工具、不读文件。用不超过100字给出预期结果和覆盖边界。没有新问题就明确说无需新增动作。", { label: "正常输入检查" })
]);
phase("汇总");
return { demo: true, reports, note: "逐个保留报告；null 表示该项覆盖缺失。请主会话基于实际结果简短汇总。" };`;
export function buildLiveWorkflowDemoPrompt() {
    const sample = fileURLToPath(new URL("../src/workflow-demo-sample.txt", import.meta.url));
    const command = `node -e "const mean=xs=>xs.reduce((a,b)=>a+b,0)/xs.length; console.log('DEMO mean([2,4,6]) =',mean([2,4,6])); if(Number.isNaN(mean([]))){console.error('DEMO expected failure: mean([]) is NaN');process.exitCode=1;}"`;
    return [
        "请现在执行 Pi 主会话全流程演示，不要只解释或打开二级界面。用户已明确请求这个小型 workflow 演示，会使用真实模型。",
        "演示数据仅用于展示，不是当前项目的审计发现。不修改用户文件、不扫描项目、不启动额外代理。",
        `1. 先用 read 读取固定样例：${JSON.stringify(sample)}。`,
        `2. 用 bash 执行以下只读检查，让真实 Working 行与工具卡片展示成功输出和预期错误：${JSON.stringify(command)}。退出码1是预期的演示结果，解释一句后继续，不能据此终止演示。`,
        "3. 调用 start_workflow，仅传 script，脚本逐字使用下方内容。不要把它放进 args，不要启动第二个 workflow。",
        "4. 启动后告诉用户可以现在插入一条消息观察 steer。不要伪造用户消息；如果实际收到插话，按其内容处理，同时继续适用的演示任务。",
        "5. 等待真实子代理结果。逐份评估：有实质发现就简短评价，重复或无需动作的结果允许静默。不要把投递回执当成报告正文。需要等待时使用 get_workflow_output，不要 shell sleep 或轮询。",
        "6. 最终报告到达后，用几句话汇总正常输入、空数组问题、预期错误恢复和实际观察到的投递；没发生插话就明确未演示插话。不要声称模型、token或缓存数据是模拟值。",
        "脚本：",
        LIVE_WORKFLOW_DEMO_SCRIPT,
    ].join("\n\n");
}
const DEMO_FRAME_MS = 50;
const DEMO_RUN_IDS = ["workflow-demo-compact", "workflow-demo-paused", "workflow-demo-detailed"];
function usage(input, output, cacheRead = 0) {
    return {
        input,
        output,
        cacheRead,
        cacheWrite: 0,
        total: input + output + cacheRead,
        cost: 0.012,
    };
}
function agent(id, label, status, tokens, phase = "Checks") {
    return {
        id,
        label,
        phase,
        prompt: "Synthetic UI preview",
        status,
        tokens,
        tokenUsage: tokens > 0 ? usage(Math.floor(tokens * 0.3), Math.floor(tokens * 0.2), Math.floor(tokens * 0.5)) : undefined,
        model: "anthropic/claude-sonnet-4-5",
        error: status === "error" ? "Example validation failure" : undefined,
    };
}
function snapshot(name, agents, currentPhase = "Checks") {
    return {
        name,
        phases: [currentPhase],
        currentPhase,
        logs: [],
        agents,
        agentCount: agents.length,
        runningCount: agents.filter((item) => item.status === "running").length,
        doneCount: agents.filter((item) => item.status === "done").length,
        errorCount: agents.filter((item) => item.status === "error").length,
        tokenUsage: { input: 6_200, output: 1_800, total: 28_000, cacheRead: 20_000, cacheWrite: 0, cost: 0.08 },
    };
}
function persisted(runId, workflowName, status, agents) {
    return {
        runId,
        workflowName,
        script: "// synthetic preview",
        status,
        phases: ["Checks"],
        currentPhase: "Checks",
        agents,
        logs: [],
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
        tokenUsage: { input: 6_200, output: 1_800, total: 28_000, cacheRead: 20_000, cacheWrite: 0, cost: 0.08 },
    };
}
function asWorkflowManager(runs, liveRuns) {
    const liveById = new Map(liveRuns.map((run) => [run.snapshot.runId ?? "", run]));
    const manager = {
        listRuns: () => runs,
        getRun: (runId) => liveById.get(runId),
    };
    return manager;
}
function compactDemoManager(elapsedMs) {
    const movingTokens = 2_000 + Math.floor(elapsedMs * 1.8);
    const runningAgents = Array.from({ length: 5 }, (_, index) => agent(index + 1, `check-${index + 1}`, "running", movingTokens + index * 320));
    const pausedAgents = [agent(1, "resolved_dependency", "done", 4_800), agent(2, "waiting_for_input", "queued", 0)];
    const runningSnapshot = { ...snapshot("codebase_audit", runningAgents), runId: DEMO_RUN_IDS[0] };
    const pausedSnapshot = { ...snapshot("dependency_review", pausedAgents), runId: DEMO_RUN_IDS[1] };
    return asWorkflowManager([
        persisted(DEMO_RUN_IDS[0], "codebase_audit", "running", runningAgents),
        persisted(DEMO_RUN_IDS[1], "dependency_review", "paused", pausedAgents),
        persisted("workflow-demo-completed", "completed_example", "completed", []),
        persisted("workflow-demo-failed", "failed_example", "failed", []),
    ], [
        { status: "running", snapshot: runningSnapshot },
        { status: "paused", snapshot: pausedSnapshot },
    ]);
}
function detailedDemoManager(elapsedMs) {
    const agents = [
        agent(1, "completed_check", "done", 8_400),
        agent(2, "running_check", "running", 3_000 + Math.floor(elapsedMs * 1.4)),
        agent(3, "queued_check", "queued", 0),
        agent(4, "failed_check", "error", 1_200),
        agent(5, "skipped_check", "skipped", 0),
    ];
    const liveSnapshot = { ...snapshot("state_showcase", agents), runId: DEMO_RUN_IDS[2] };
    return asWorkflowManager([
        persisted(DEMO_RUN_IDS[2], "state_showcase", "running", agents),
        persisted("workflow-demo-done-count", "done", "completed", []),
        persisted("workflow-demo-failed-count", "failed", "failed", []),
    ], [{ status: "running", snapshot: liveSnapshot }]);
}
/** Render both public progress modes from synthetic, non-persisted state. */
export function renderWorkflowDemo(theme, width, now = Date.now(), startedAt = now, iconMode = "auto") {
    const elapsedMs = Math.max(0, now - startedAt);
    const contentWidth = Math.max(1, width);
    return [
        theme.bold("Compact live panel"),
        ...renderPanel(compactDemoManager(elapsedMs), theme, contentWidth, now, { iconMode, hint: false }),
        "",
        theme.bold("Detailed state showcase"),
        ...renderPanelDetailed(detailedDemoManager(elapsedMs), theme, contentWidth, 8, now, {
            iconMode,
            hint: false,
        }),
        "",
        theme.fg("dim", "Synthetic preview · no agents or model calls · Esc/q close"),
    ];
}
/** Open the animated `/workflows-demo` overlay. */
export function openWorkflowDemo(ui, iconMode = "auto") {
    for (const runId of DEMO_RUN_IDS)
        clearTokenSamples(runId);
    return ui.custom((tui, theme, _keybindings, done) => {
        const startedAt = Date.now();
        let closed = false;
        const timer = setInterval(() => tui.requestRender(), DEMO_FRAME_MS);
        timer.unref?.();
        const cleanup = () => {
            if (closed)
                return;
            closed = true;
            clearInterval(timer);
            for (const runId of DEMO_RUN_IDS)
                clearTokenSamples(runId);
        };
        const close = () => {
            cleanup();
            done(undefined);
        };
        const component = {
            render: (width) => {
                const innerWidth = Math.max(1, width - 2);
                const title = " Workflow UI demo ";
                const titleText = truncateToWidth(title, innerWidth, "", true);
                const top = `╭${theme.fg("accent", titleText)}${theme.fg("borderMuted", "─".repeat(Math.max(0, innerWidth - visibleWidth(titleText))))}╮`;
                const bottom = theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`);
                const body = renderWorkflowDemo(theme, innerWidth, Date.now(), startedAt, iconMode).map((line) => {
                    const clipped = truncateToWidth(line, innerWidth, "", true);
                    const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
                    return `${theme.fg("borderMuted", "│")}${clipped}${padding}${theme.fg("borderMuted", "│")}`;
                });
                const background = (line) => theme.bg("customMessageBg", line);
                return [background(top), ...body.map(background), background(bottom)];
            },
            handleInput: (data) => {
                if (data === "q" || data === "Q" || data === "\x1b" || data === "\x03")
                    close();
            },
            invalidate: () => { },
            dispose: cleanup,
        };
        return component;
    }, {
        overlay: true,
        overlayOptions: { width: "94%", maxHeight: "92%", anchor: "center", margin: 1 },
    });
}
