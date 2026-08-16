import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { buildArmedWorkflowPrompt, buildForcedWorkflowPrompt } from "./workflow-editor.js";
import { createWorkflowTool } from "./workflow-tool.js";
/** Package-relative generated context-measurement artifact. */
export const WORKFLOW_CONTEXT_MEASUREMENT_PATH = "docs/workflow-context-surfaces.json";
const ROOT = join(import.meta.dirname, "..");
const SKILL_ROOT = "skills/workflow-authoring";
const SKILL_PATH = `${SKILL_ROOT}/SKILL.md`;
/** Canonical task profiles used for stable byte-based on-demand context measurements. */
export const WORKFLOW_AUTHORING_PROFILES = [
    {
        name: "write",
        files: [
            SKILL_PATH,
            `${SKILL_ROOT}/references/runtime.md`,
            `${SKILL_ROOT}/references/pattern-selection.md`,
            `${SKILL_ROOT}/references/focused-recipes.md`,
            `${SKILL_ROOT}/examples/fan-out-and-synthesize.js`,
            `${SKILL_ROOT}/examples/structured-output.js`,
        ],
    },
    {
        name: "edit",
        files: [
            SKILL_PATH,
            `${SKILL_ROOT}/references/runtime.md`,
            `${SKILL_ROOT}/references/lifecycle.md`,
            `${SKILL_ROOT}/references/focused-recipes.md`,
            `${SKILL_ROOT}/examples/phased-budgets.js`,
            `${SKILL_ROOT}/examples/saved-nested-workflows.js`,
        ],
    },
    {
        name: "review",
        files: [
            SKILL_PATH,
            `${SKILL_ROOT}/references/runtime.md`,
            `${SKILL_ROOT}/references/review.md`,
            `${SKILL_ROOT}/references/quality-helpers.md`,
            `${SKILL_ROOT}/examples/adversarial-verification.js`,
        ],
    },
    {
        name: "debug",
        files: [
            SKILL_PATH,
            `${SKILL_ROOT}/references/runtime.md`,
            `${SKILL_ROOT}/references/debugging.md`,
            `${SKILL_ROOT}/references/specialized-helpers.md`,
            `${SKILL_ROOT}/examples/validated-gate.js`,
        ],
    },
    {
        name: "loop",
        files: [
            SKILL_PATH,
            `${SKILL_ROOT}/references/runtime.md`,
            `${SKILL_ROOT}/references/pattern-selection.md`,
            `${SKILL_ROOT}/references/lifecycle.md`,
            `${SKILL_ROOT}/references/focused-recipes.md`,
            `${SKILL_ROOT}/examples/loop-until-done.js`,
            `${SKILL_ROOT}/examples/structured-output.js`,
        ],
    },
    {
        name: "retry",
        files: [
            SKILL_PATH,
            `${SKILL_ROOT}/references/runtime.md`,
            `${SKILL_ROOT}/references/retry-helper.md`,
            `${SKILL_ROOT}/references/focused-recipes.md`,
            `${SKILL_ROOT}/examples/bounded-semantic-retry.js`,
            `${SKILL_ROOT}/examples/structured-output.js`,
        ],
    },
];
function bytes(value) {
    return Buffer.byteLength(value, "utf8");
}
function fileBytes(root, path) {
    return bytes(readFileSync(join(root, path), "utf8"));
}
function skillFiles(root) {
    const absoluteRoot = join(root, SKILL_ROOT);
    const pending = [absoluteRoot];
    const files = [];
    while (pending.length > 0) {
        const directory = pending.pop();
        if (!directory)
            continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const absolute = join(directory, entry.name);
            if (entry.isDirectory())
                pending.push(absolute);
            else if (entry.isFile())
                files.push(relative(root, absolute).replaceAll("\\", "/"));
        }
    }
    return files.sort();
}
/**
 * Every skill root this package registers, read from package.json's
 * `pi.skills` array rather than hardcoded — so a newly added skill is picked
 * up automatically instead of silently missing from the always-on tally.
 */
function registeredSkillRoots(root) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const skills = manifest.pi?.skills;
    if (!Array.isArray(skills) || skills.length === 0 || !skills.every((s) => typeof s === "string")) {
        throw new Error("package.json must declare a non-empty pi.skills array of skill root paths");
    }
    return skills;
}
function skillDiscoveryEntry(root, skillRoot) {
    const skillPath = `${skillRoot}/SKILL.md`;
    const skill = readFileSync(join(root, skillPath), "utf8");
    const name = /^name:\s*(.+)$/m.exec(skill)?.[1]?.trim();
    const description = /^description:\s*(.+)$/m.exec(skill)?.[1]?.trim();
    if (!name || !description)
        throw new Error(`${skillPath} must declare name and description`);
    return [
        "<skill>",
        `  <name>${name}</name>`,
        `  <description>${description}</description>`,
        `  <location>${skillPath}</location>`,
        "</skill>",
    ].join("\n");
}
function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = sorted.length / 2;
    return sorted.length % 2 === 0
        ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
        : (sorted[Math.floor(middle)] ?? 0);
}
/** Measures permanent, discovery, corpus, and canonical on-demand workflow context surfaces. */
export function measureWorkflowContextSurfaces(root = ROOT) {
    const tool = createWorkflowTool({ allowResume: false, exposeAdvancedParameters: false, modelFacing: true });
    const alwaysOnTools = [tool];
    const permanentWorkflowPrompt = [
        ...(tool.promptSnippet ? [`- workflow: ${tool.promptSnippet}`] : []),
        ...(tool.promptGuidelines ?? []).map((guideline) => `- ${guideline}`),
    ].join("\n");
    const providerVisibleWorkflowToolDefinition = JSON.stringify({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    });
    const alwaysOnToolSurfaces = alwaysOnTools.map((alwaysOnTool) => ({
        name: alwaysOnTool.name,
        serialization: "UTF-8 bytes of JSON.stringify({ name, description, parameters })",
        bytes: bytes(JSON.stringify({
            name: alwaysOnTool.name,
            description: alwaysOnTool.description,
            parameters: alwaysOnTool.parameters,
        })),
    }));
    const alwaysOnToolBytes = alwaysOnToolSurfaces.reduce((sum, surface) => sum + surface.bytes, 0);
    const skillRoots = registeredSkillRoots(root);
    const skillDiscoverySurfaces = skillRoots.map((skillRoot) => ({
        root: skillRoot,
        serialization: "UTF-8 bytes of normalized Pi skill XML with package-relative location",
        bytes: bytes(skillDiscoveryEntry(root, skillRoot)),
    }));
    const registeredSkillsDiscoveryBytes = skillDiscoverySurfaces.reduce((sum, surface) => sum + surface.bytes, 0);
    const corpusFiles = skillFiles(root);
    const corpusBytes = corpusFiles.reduce((sum, path) => sum + fileBytes(root, path), 0);
    const profiles = WORKFLOW_AUTHORING_PROFILES.map((profile) => ({
        name: profile.name,
        files: [...profile.files],
        bytes: profile.files.reduce((sum, path) => sum + fileBytes(root, path), 0),
    }));
    const promptBytes = bytes(permanentWorkflowPrompt);
    const toolBytes = bytes(providerVisibleWorkflowToolDefinition);
    const armedRewriteBytes = bytes(buildArmedWorkflowPrompt(""));
    const forcedRewriteBytes = bytes(buildForcedWorkflowPrompt(""));
    return {
        formatVersion: 7,
        encoding: "utf8",
        sources: ["src/workflow-tool.ts", "src/workflow-editor.ts", "skills/workflow-authoring", "package.json#pi.skills"],
        surfaces: {
            permanentWorkflowPrompt: {
                serialization: "UTF-8 bytes of LF-joined stable Pi prompt lines contributed by workflow",
                bytes: promptBytes,
            },
            providerVisibleWorkflowToolDefinition: {
                serialization: "UTF-8 bytes of the stable JSON.stringify({ name, description, parameters }) workflow definition",
                bytes: toolBytes,
            },
            providerVisibleAlwaysOnToolDefinitions: {
                serialization: "sum of stable provider-visible workflow tool definitions on ordinary turns",
                bytes: alwaysOnToolBytes,
                tools: alwaysOnToolSurfaces,
            },
            armedWorkflowPromptRewrite: {
                serialization: "UTF-8 bytes added by buildArmedWorkflowPrompt to an empty user message",
                bytes: armedRewriteBytes,
            },
            forcedWorkflowPromptRewrite: {
                serialization: "UTF-8 bytes added by buildForcedWorkflowPrompt to an empty user message",
                bytes: forcedRewriteBytes,
            },
            stableWorkflowOwnedContext: {
                serialization: "sum of the stable Pi prompt and provider workflow definition",
                bytes: promptBytes + toolBytes,
            },
            explicitWorkflowRequestOwnedContext: {
                serialization: "stable workflow-owned context plus the explicit-request suffix",
                bytes: promptBytes + toolBytes + armedRewriteBytes,
            },
            registeredSkillsDiscovery: {
                serialization: "sum of UTF-8 bytes of normalized Pi skill XML (name + description + location) across every root in package.json's pi.skills",
                bytes: registeredSkillsDiscoveryBytes,
                skills: skillDiscoverySurfaces,
            },
            ordinaryWorkflowOwnedAlwaysOn: {
                serialization: "sum of the stable workflow definition and every registered skill discovery entry",
                bytes: alwaysOnToolBytes + registeredSkillsDiscoveryBytes,
            },
            workflowAuthoringSkillCorpus: {
                serialization: "sum of UTF-8 bytes for every file under skills/workflow-authoring",
                files: corpusFiles.length,
                bytes: corpusBytes,
            },
            representativeAuthoringProfiles: {
                serialization: "sum of UTF-8 bytes for each profile's declared package-relative files",
                medianBytes: median(profiles.map(({ bytes: profileBytes }) => profileBytes)),
                profiles,
            },
        },
    };
}
/** Render the current measurement as deterministic formatted JSON. */
export function renderWorkflowContextMeasurement() {
    return `${JSON.stringify(measureWorkflowContextSurfaces(), null, 2)}\n`;
}
/** Write the generated measurement under root and return the measured values. */
export function writeWorkflowContextMeasurement(root) {
    const measurement = measureWorkflowContextSurfaces(root);
    writeFileSync(join(root, WORKFLOW_CONTEXT_MEASUREMENT_PATH), `${JSON.stringify(measurement, null, 2)}\n`);
    return measurement;
}
/** Report whether committed or supplied measurement JSON matches current package bytes. */
export function checkWorkflowContextMeasurement(root, actual) {
    const committed = actual ?? readFileSync(join(root, WORKFLOW_CONTEXT_MEASUREMENT_PATH), "utf8");
    return committed === `${JSON.stringify(measureWorkflowContextSurfaces(root), null, 2)}\n`;
}
