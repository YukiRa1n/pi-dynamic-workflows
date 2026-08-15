import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import {
  CapabilityClassification,
  CapabilitySupport,
  DiscoveryPlacement,
  WorkflowAuthoringProtection,
  WorkflowReleaseDiagnosticCode,
} from "./enums.js";
import {
  WORKFLOW_AUTHORING_COVERAGE,
  WORKFLOW_AUTHORING_FROZEN_FILES,
  WORKFLOW_AUTHORING_PATTERN_IDS,
  WORKFLOW_AUTHORING_RECIPE_IDS,
  WORKFLOW_COMPREHENSION_SCENARIO_IDS,
  type WorkflowAuthoringCoverageEntry,
} from "./workflow-authoring-coverage.js";
import {
  type CAPABILITY_PUBLICATION_PATHS,
  checkWorkflowCapabilityPublications,
} from "./workflow-authoring-reference.js";
import { WORKFLOW_CAPABILITY_DEFINITION, type WorkflowCapabilityDefinition } from "./workflow-capability-contract.js";
import { checkWorkflowContextMeasurement, WORKFLOW_CONTEXT_MEASUREMENT_PATH } from "./workflow-context-measurement.js";
import { createWorkflowControlTool } from "./workflow-control-tool.js";
import { createWorkflowTool } from "./workflow-tool.js";

/** Re-exported stable diagnostic codes for release automation. */
export { WorkflowReleaseDiagnosticCode } from "./enums.js";

/** One actionable release alignment error or warning. */
export interface WorkflowReleaseDiagnostic {
  code: WorkflowReleaseDiagnosticCode;
  severity: "error" | "warning";
  subject: string;
  message: string;
}

type PublicationPath = (typeof CAPABILITY_PUBLICATION_PATHS)[number];

/** Inputs and test overrides for the model-free workflow release gate. */
export interface WorkflowReleaseCheckOptions {
  root: string;
  definition?: WorkflowCapabilityDefinition;
  extensionVersion?: string;
  skillVersion?: string;
  publishableFiles: readonly string[];
  publicationOverrides?: Readonly<Partial<Record<PublicationPath, string>>>;
  contextMeasurement?: string;
  guidanceBaseline?: string;
  authoringCoverage?: readonly WorkflowAuthoringCoverageEntry[];
  guidanceOverrides?: Readonly<Record<string, string>>;
  /** Changed package paths from the release diff; enables source/dist surface checks. */
  changedFiles?: readonly string[];
}

const SKILL_ROOT = "skills/workflow-authoring";
/** Package-relative generated hash baseline for compact and detailed guidance. */
export const WORKFLOW_GUIDANCE_BASELINE_PATH = "docs/workflow-guidance-baseline.json";
const FOCUSED_REFERENCES = [
  "capabilities",
  "capability-details",
  "runtime",
  "helpers",
  "common-helpers",
  "quality-helpers",
  "retry-helper",
  "specialized-helpers",
  "lifecycle",
  "versions",
  "pattern-selection",
  "focused-recipes",
  "registry-ownership",
  "review",
  "debugging",
] as const;
const PATTERNS = [
  "classify-and-act",
  "fan-out-and-synthesize",
  "adversarial-verification",
  "generate-and-filter",
  "tournament",
  "loop-until-done",
] as const;
const RECIPES = ["phased-budgets", "saved-nested-workflows", "bounded-semantic-retry", "structured-output"] as const;

/** Skill files that must be present in the publishable npm package. */
export const REQUIRED_WORKFLOW_PACKAGE_RESOURCES = [
  `${SKILL_ROOT}/SKILL.md`,
  ...FOCUSED_REFERENCES.map((name) => `${SKILL_ROOT}/references/${name}.md`),
  ...PATTERNS.map((name) => `${SKILL_ROOT}/examples/${name}.js`),
  ...RECIPES.map((name) => `${SKILL_ROOT}/examples/${name}.js`),
] as const;

function diagnostic(
  code: WorkflowReleaseDiagnosticCode,
  subject: string,
  message: string,
  severity: WorkflowReleaseDiagnostic["severity"] = "error",
): WorkflowReleaseDiagnostic {
  return { code, severity, subject, message };
}

function skillVersion(root: string): string | null {
  const skill = readFileSync(join(root, SKILL_ROOT, "SKILL.md"), "utf8");
  return /^\s{2}version:\s*["']?([^"'\s]+)["']?\s*$/m.exec(skill)?.[1] ?? null;
}

function anchorExists(markdown: string, anchor: string): boolean {
  if (markdown.includes(`<a id="${anchor}"></a>`)) return true;
  return markdown
    .split("\n")
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) =>
      line
        .replace(/^#{1,6} /, "")
        .toLowerCase()
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ +/g, "-"),
    )
    .includes(anchor);
}

function validateVersions(
  definition: WorkflowCapabilityDefinition,
  extensionVersion: string,
  installedSkillVersion: string | null,
): WorkflowReleaseDiagnostic[] {
  const diagnostics: WorkflowReleaseDiagnostic[] = [];
  const versions: Array<[string, string | null]> = [
    ["contract extension", definition.versions.extension],
    ["contract content", definition.versions.content.version],
    ["installed skill", installedSkillVersion],
  ];
  for (const [subject, actual] of versions) {
    if (actual !== extensionVersion) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.INCOMPATIBLE_VERSION,
          subject,
          `${subject} version ${actual ?? "<missing>"} must match extension version ${extensionVersion}.`,
        ),
      );
    }
  }
  if (definition.versions.format.kind !== "present-at" || !/^1(?:\.|$)/.test(definition.versions.format.version)) {
    diagnostics.push(
      diagnostic(
        WorkflowReleaseDiagnosticCode.INCOMPATIBLE_VERSION,
        "contract format",
        `Contract format ${definition.versions.format.version} is incompatible with supported format major 1.`,
      ),
    );
  }
  return diagnostics;
}

function validateCapabilityLinks(root: string, definition: WorkflowCapabilityDefinition): WorkflowReleaseDiagnostic[] {
  const diagnostics: WorkflowReleaseDiagnostic[] = [];
  for (const capability of definition.capabilities) {
    if (
      capability.support === CapabilitySupport.SUPPORTED &&
      capability.discovery !== DiscoveryPlacement.NONE &&
      capability.behaviorEvidence.length === 0
    ) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.MISSING_BEHAVIOR_EVIDENCE,
          capability.id,
          `Advertised capability ${capability.id} has no behavior-test evidence.`,
        ),
      );
    }
    for (const evidence of capability.behaviorEvidence) {
      if (!existsSync(join(root, evidence))) {
        diagnostics.push(
          diagnostic(
            WorkflowReleaseDiagnosticCode.UNRESOLVED_BEHAVIOR_EVIDENCE,
            evidence,
            `Capability ${capability.id} references missing behavior test ${evidence}.`,
          ),
        );
      }
    }
    if (capability.staticReference) {
      const { path, anchor } = capability.staticReference;
      const absolute = join(root, path);
      const subject = `${path}#${anchor}`;
      if (!existsSync(absolute) || !anchorExists(readFileSync(absolute, "utf8"), anchor)) {
        diagnostics.push(
          diagnostic(
            WorkflowReleaseDiagnosticCode.BROKEN_CONTRACT_REFERENCE,
            subject,
            `Capability ${capability.id} references unresolved installed documentation ${subject}.`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

function validateAuthoringCoverage(
  root: string,
  definition: WorkflowCapabilityDefinition,
  coverage: readonly WorkflowAuthoringCoverageEntry[],
  guidanceOverrides: Readonly<Record<string, string>> = {},
): WorkflowReleaseDiagnostic[] {
  const expectedIds = [
    ...definition.capabilities
      .filter(
        ({ discovery, support }) => discovery !== DiscoveryPlacement.NONE && support !== CapabilitySupport.INTERNAL,
      )
      .map(({ id }) => id),
    ...WORKFLOW_AUTHORING_PATTERN_IDS,
    ...WORKFLOW_AUTHORING_RECIPE_IDS,
  ];
  const observed = new Set(coverage.map(({ id }) => id));
  const diagnostics = expectedIds
    .filter((id) => !observed.has(id))
    .map((id) =>
      diagnostic(
        WorkflowReleaseDiagnosticCode.MISSING_AUTHORING_COVERAGE,
        id,
        `Stable workflow authoring surface ${id} is absent from the capability coverage manifest.`,
      ),
    );

  const knownScenarioIds = new Set(WORKFLOW_COMPREHENSION_SCENARIO_IDS);
  for (const entry of coverage.filter(
    ({ protection }) => protection === WorkflowAuthoringProtection.BEHAVIORALLY_COVERED,
  )) {
    if (
      entry.comprehensionScenarios.length === 0 ||
      entry.comprehensionScenarios.some((scenarioId) => !knownScenarioIds.has(scenarioId))
    ) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.UNKNOWN_COMPREHENSION_SCENARIO,
          entry.id,
          `Behaviorally covered authoring surface ${entry.id} references a missing comprehension scenario.`,
        ),
      );
    }
  }

  for (const entry of coverage.filter(({ protection }) => protection === WorkflowAuthoringProtection.GUIDANCE_FROZEN)) {
    if (entry.protectedGuidance.length === 0) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.UNPROTECTED_AUTHORING_GUIDANCE,
          entry.id,
          `Untested authoring surface ${entry.id} has no frozen guidance or routing pointer.`,
        ),
      );
      continue;
    }
    const drifted = entry.protectedGuidance.find(({ path, anchor, requiredText }) => {
      const absolute = join(root, path);
      if (!existsSync(absolute) && guidanceOverrides[path] === undefined) return true;
      const source = guidanceOverrides[path] ?? readFileSync(absolute, "utf8");
      return (
        (anchor !== undefined && !anchorExists(source, anchor)) ||
        (requiredText !== undefined && !source.includes(requiredText))
      );
    });
    if (drifted) {
      const absolute = join(root, drifted.path);
      const source =
        !existsSync(absolute) && guidanceOverrides[drifted.path] === undefined
          ? null
          : (guidanceOverrides[drifted.path] ?? readFileSync(absolute, "utf8"));
      const failedChecks: string[] = [];
      if (source === null) {
        failedChecks.push("protected file");
      }
      if (source !== null && drifted.anchor !== undefined && !anchorExists(source, drifted.anchor)) {
        failedChecks.push("required anchor");
      }
      if (source !== null && drifted.requiredText !== undefined && !source.includes(drifted.requiredText)) {
        failedChecks.push("required text");
      }
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.PROTECTED_GUIDANCE_DRIFT,
          entry.id,
          `Protected guidance for ${entry.id} no longer matches the ${failedChecks.join(" and ")} in ${drifted.path}. Restore it to undo an accidental change. For an intentional change, inspect the coverage manifest and relevant behavioral/provider evidence before deliberately updating the corresponding anchor/text in src/workflow-authoring-coverage.ts. See CONTRIBUTING.md#protected-workflow-authoring-guidance.`,
        ),
      );
    }
  }
  return diagnostics;
}

function validateFrozenGuidanceFiles(
  root: string,
  guidanceOverrides: Readonly<Record<string, string>> = {},
): WorkflowReleaseDiagnostic[] {
  return WORKFLOW_AUTHORING_FROZEN_FILES.flatMap(({ path, sha256: expected }) => {
    const absolute = join(root, path);
    if (!existsSync(absolute) && guidanceOverrides[path] === undefined) {
      return [
        diagnostic(
          WorkflowReleaseDiagnosticCode.PROTECTED_GUIDANCE_DRIFT,
          path,
          `Protected workflow-authoring file is missing: ${path}. Restore an accidental deletion. An intentional removal requires review of the coverage manifest and relevant behavioral/provider evidence, followed by deliberate updates to authoring coverage and package resources. See CONTRIBUTING.md#protected-workflow-authoring-guidance.`,
        ),
      ];
    }
    const source = guidanceOverrides[path] ?? readFileSync(absolute, "utf8");
    return sha256(source) === expected
      ? []
      : [
          diagnostic(
            WorkflowReleaseDiagnosticCode.PROTECTED_GUIDANCE_DRIFT,
            path,
            `Protected workflow-authoring file changed: ${path}. Its SHA-256 is an explicit review checkpoint for guidance with partial behavioral coverage. Revert accidental changes. For an intentional change, inspect the coverage manifest and relevant behavioral tests, plus provider evidence when needed, then run npm run guidance:accept -- ${path}. This updates the matching sha256 in WORKFLOW_AUTHORING_FROZEN_FILES (src/workflow-authoring-coverage.ts). See CONTRIBUTING.md#protected-workflow-authoring-guidance.`,
          ),
        ];
  });
}

function validateToolInputs(definition: WorkflowCapabilityDefinition): WorkflowReleaseDiagnostic[] {
  const { parameters } = createWorkflowTool();
  const properties: Record<string, unknown> =
    isRecord(parameters) && isRecord(parameters.properties) ? parameters.properties : {};
  const observed = new Set(Object.keys(properties));
  const declared = new Set(
    definition.capabilities
      .filter((capability) => capability.classification === CapabilityClassification.WORKFLOW_TOOL_INPUT)
      .map((capability) => capability.label),
  );
  const diagnostics: WorkflowReleaseDiagnostic[] = [];
  for (const name of declared) {
    if (!observed.has(name)) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.TOOL_INPUT_MISMATCH,
          name,
          `Declared workflow-tool input ${name} is absent from the runtime schema.`,
        ),
      );
    }
  }
  for (const name of observed) {
    if (!declared.has(name)) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.TOOL_INPUT_MISMATCH,
          name,
          `Runtime schema exposes undeclared workflow-tool input ${name}.`,
        ),
      );
    }
  }

  const tokenBudget = definition.capabilities.find(
    (capability) =>
      capability.classification === CapabilityClassification.WORKFLOW_TOOL_INPUT && capability.label === "tokenBudget",
  );
  const tokenBudgetSchema = properties.tokenBudget;
  const observedTokenBudget =
    isRecord(tokenBudgetSchema) && typeof tokenBudgetSchema.description === "string"
      ? tokenBudgetSchema.description
      : "";
  const contractCallsSoft = tokenBudget?.constraints.some((constraint) => /soft/i.test(constraint)) ?? false;
  const contractCallsHard = tokenBudget?.constraints.some((constraint) => /hard/i.test(constraint)) ?? false;
  const proseCallsSoft = /soft/i.test(observedTokenBudget);
  const proseCallsHard = /hard/i.test(observedTokenBudget);
  if ((contractCallsSoft && proseCallsHard) || (contractCallsHard && proseCallsSoft)) {
    diagnostics.push(
      diagnostic(
        WorkflowReleaseDiagnosticCode.RUNTIME_CONSTRAINT_DISAGREEMENT,
        "tokenBudget",
        `Contract constraints and provider-visible tool prose disagree about whether tokenBudget is a soft or hard gate. Contract: ${tokenBudget?.constraints.join("; ")}. Tool prose: ${observedTokenBudget}`,
      ),
    );
  }
  return diagnostics;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateWorkflowControlSurface(): WorkflowReleaseDiagnostic[] {
  const tool = createWorkflowControlTool({
    getManager: () => {
      throw new Error("release inspection");
    },
  });
  const parameters = isRecord(tool.parameters) ? tool.parameters : {};
  const properties = isRecord(parameters.properties) ? parameters.properties : {};
  const diagnostics: WorkflowReleaseDiagnostic[] = [];
  if (parameters.type !== "object" || parameters.additionalProperties !== false) {
    diagnostics.push(
      diagnostic(
        WorkflowReleaseDiagnosticCode.TOOL_INPUT_MISMATCH,
        "workflow_control",
        "workflow_control must expose a strict top-level object schema for provider compatibility.",
      ),
    );
  }
  const action = properties.action;
  const actionNames =
    isRecord(action) && Array.isArray(action.anyOf)
      ? action.anyOf.flatMap((entry: unknown) => {
          if (isRecord(entry) && typeof entry.const === "string") return [entry.const];
          return [];
        })
      : isRecord(action) && Array.isArray(action.enum)
        ? action.enum.filter((entry: unknown): entry is string => typeof entry === "string")
        : [];
  for (const required of ["list", "status", "pause", "resume", "stop"]) {
    if (!actionNames.includes(required)) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.TOOL_INPUT_MISMATCH,
          `workflow_control.action.${required}`,
          `workflow_control schema is missing action ${required}.`,
        ),
      );
    }
  }
  const runId = properties.runId;
  if (
    !isRecord(runId) ||
    runId.type !== "string" ||
    (typeof runId.minLength === "number" && runId.minLength > 0)
  ) {
    diagnostics.push(
      diagnostic(
        WorkflowReleaseDiagnosticCode.TOOL_INPUT_MISMATCH,
        "workflow_control.runId",
        "workflow_control runId must be an optional string so list wrappers may send an empty compatibility value.",
      ),
    );
  }
  return diagnostics;
}

// Every TypeScript source has a package-root dist twin. Keeping the complete
// list here makes a changed source file a release-gate input instead of relying
// on a small hand-maintained high-risk subset that can silently drift.
const RELEASE_SURFACE_SOURCES = [
  "src/accept-workflow-guidance.ts",
  "src/adversarial-review.ts",
  "src/agent-history.ts",
  "src/agent-registry.ts",
  "src/agent-team.ts",
  "src/agent.ts",
  "src/builtin-commands.ts",
  "src/builtin-workflows.ts",
  "src/code-review.ts",
  "src/config.ts",
  "src/deep-research.ts",
  "src/display.ts",
  "src/effort-command.ts",
  "src/enums.ts",
  "src/errors.ts",
  "src/extension-reload.ts",
  "src/fs-persistence.ts",
  "src/index.ts",
  "src/logger.ts",
  "src/model-routing.ts",
  "src/model-spec.ts",
  "src/model-tier-config.ts",
  "src/run-persistence.ts",
  "src/safe-serialize.ts",
  "src/saved-commands.ts",
  "src/shared-store.ts",
  "src/structured-output.ts",
  "src/task-panel.ts",
  "src/usage-limit-scheduler.ts",
  "src/web-tools.ts",
  "src/workflow-authoring-coverage.ts",
  "src/workflow-authoring-reference.ts",
  "src/workflow-capability-contract.ts",
  "src/workflow-commands.ts",
  "src/workflow-comprehension.ts",
  "src/workflow-context-measurement.ts",
  "src/workflow-control-tool.ts",
  "src/workflow-delivery-choice.ts",
  "src/workflow-editor.ts",
  "src/workflow-manager.ts",
  "src/workflow-paths.ts",
  "src/workflow-release-gate.ts",
  "src/workflow-saved.ts",
  "src/workflow-settings.ts",
  "src/workflow-tool.ts",
  "src/workflow-ui.ts",
  "src/workflow.ts",
  "src/workflows-models-command.ts",
  "src/worktree.ts",
] as const;

function normalizePackagePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

/** Ensure changed persistence/control/release surfaces have a publishable build twin. */
function validateChangedSurfaces(
  root: string,
  publishableFiles: readonly string[],
  changedFiles: readonly string[] | undefined,
): WorkflowReleaseDiagnostic[] {
  const published = new Set(publishableFiles.map(normalizePackagePath));
  const diagnostics: WorkflowReleaseDiagnostic[] = [];
  // An omitted change list means a full release verification, not “skip the
  // parity check”. Incremental callers may still provide a narrower list.
  const candidates = changedFiles ?? RELEASE_SURFACE_SOURCES;
  for (const changed of candidates.map(normalizePackagePath)) {
    if (!RELEASE_SURFACE_SOURCES.includes(changed as (typeof RELEASE_SURFACE_SOURCES)[number])) continue;
    const source = join(root, changed);
    if (!existsSync(source)) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.STALE_GENERATED_SURFACE,
          changed,
          `Changed release surface is missing from the source tree: ${changed}.`,
        ),
      );
      continue;
    }
    if (!published.has(changed)) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.MISSING_PACKAGE_RESOURCE,
          changed,
          `Changed release surface is not included in the publishable package: ${changed}.`,
        ),
      );
    }
    const basename = changed.slice("src/".length, -".ts".length);
    for (const generated of [`dist/${basename}.js`, `dist/${basename}.d.ts`]) {
      const generatedPath = join(root, generated);
      let stale = !existsSync(generatedPath) || !published.has(generated);
      if (!stale) {
        try {
          stale = statSync(generatedPath).mtimeMs < statSync(source).mtimeMs;
        } catch {
          stale = true;
        }
      }
      if (stale) {
        diagnostics.push(
          diagnostic(
            WorkflowReleaseDiagnosticCode.STALE_GENERATED_SURFACE,
            generated,
            `Changed source surface ${changed} has no current publishable generated twin ${generated}; run the TypeScript build before release.`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Render deterministic hashes for provider-visible and on-demand guidance surfaces. */
export function renderWorkflowGuidanceBaseline(root: string): string {
  const tool = createWorkflowTool();
  const compact = JSON.stringify({
    description: tool.description,
    parameters: tool.parameters,
    promptSnippet: tool.promptSnippet,
    promptGuidelines: tool.promptGuidelines,
  });
  const detailedPaths = [
    `${SKILL_ROOT}/SKILL.md`,
    ...FOCUSED_REFERENCES.filter((name) => name !== "capabilities" && name !== "capability-details").map(
      (name) => `${SKILL_ROOT}/references/${name}.md`,
    ),
  ];
  const detailed = detailedPaths.map((path) => `${path}\n${readFileSync(join(root, path), "utf8")}`).join("\n");
  return `${JSON.stringify(
    {
      formatVersion: 1,
      algorithm: "sha256",
      surfaces: {
        compactGuidance: sha256(compact),
        detailedProse: sha256(detailed),
      },
    },
    null,
    2,
  )}\n`;
}

/** Refresh the committed guidance hash baseline under root. */
export function writeWorkflowGuidanceBaseline(root: string): void {
  writeFileSync(join(root, WORKFLOW_GUIDANCE_BASELINE_PATH), renderWorkflowGuidanceBaseline(root));
}

function validateGuidanceBaseline(root: string, actual?: string): WorkflowReleaseDiagnostic[] {
  const committed = actual ?? readFileSync(join(root, WORKFLOW_GUIDANCE_BASELINE_PATH), "utf8");
  if (committed === renderWorkflowGuidanceBaseline(root)) return [];
  return [
    diagnostic(
      WorkflowReleaseDiagnosticCode.NON_CONTRACTUAL_PROSE_DRIFT,
      WORKFLOW_GUIDANCE_BASELINE_PATH,
      `Compact guidance or detailed hand-written prose changed; review intent and refresh ${WORKFLOW_GUIDANCE_BASELINE_PATH} if intentional.`,
      "warning",
    ),
  ];
}

function validatePackage(root: string, publishableFiles: readonly string[]): WorkflowReleaseDiagnostic[] {
  const diagnostics: WorkflowReleaseDiagnostic[] = [];
  const files = new Set(publishableFiles);
  for (const resource of REQUIRED_WORKFLOW_PACKAGE_RESOURCES) {
    if (!files.has(resource)) {
      diagnostics.push(
        diagnostic(
          WorkflowReleaseDiagnosticCode.MISSING_PACKAGE_RESOURCE,
          resource,
          `Publishable package omitted required workflow resource ${resource}.`,
        ),
      );
    }
  }

  for (const sourcePath of publishableFiles.filter(
    (path) => path.startsWith(`${SKILL_ROOT}/`) && path.endsWith(".md"),
  )) {
    const source = readFileSync(join(root, sourcePath), "utf8");
    for (const match of source.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#([^)]+))?\)/g)) {
      const target = normalize(join(dirname(sourcePath), match[1]));
      const anchor = match[2];
      const outsidePackage = relative(".", target).startsWith("..");
      const targetMissing = !files.has(target);
      const targetSource = !targetMissing && anchor ? readFileSync(join(root, target), "utf8") : null;
      if (outsidePackage || targetMissing || (anchor && targetSource !== null && !anchorExists(targetSource, anchor))) {
        const subject = `${sourcePath} -> ${target}${anchor ? `#${anchor}` : ""}`;
        diagnostics.push(
          diagnostic(
            WorkflowReleaseDiagnosticCode.BROKEN_PACKAGE_LINK,
            subject,
            `Packaged workflow skill link does not resolve: ${subject}.`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

/** Parse publishable paths from `npm pack --dry-run --json` without trusting external JSON shapes. */
export function parseNpmPackFilePaths(output: string): string[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    return [];
  }
  const first = parsed[0];
  if (!isRecord(first) || !Array.isArray(first.files)) {
    return [];
  }
  return first.files.flatMap((file: unknown) => (isRecord(file) && typeof file.path === "string" ? [file.path] : []));
}

/** Return every model-free contract, package, documentation, and guidance alignment diagnostic. */
export function checkWorkflowRelease(options: WorkflowReleaseCheckOptions): WorkflowReleaseDiagnostic[] {
  const definition = options.definition ?? WORKFLOW_CAPABILITY_DEFINITION;
  const extensionVersion = options.extensionVersion ?? packageJson.version;
  const installedSkillVersion = options.skillVersion ?? skillVersion(options.root);
  const diagnostics = [
    ...validateVersions(definition, extensionVersion, installedSkillVersion),
    ...validateCapabilityLinks(options.root, definition),
    ...validateAuthoringCoverage(
      options.root,
      definition,
      options.authoringCoverage ?? WORKFLOW_AUTHORING_COVERAGE,
      options.guidanceOverrides,
    ),
    ...validateFrozenGuidanceFiles(options.root, options.guidanceOverrides),
    ...validateToolInputs(definition),
    ...validateWorkflowControlSurface(),
    ...validatePackage(options.root, options.publishableFiles),
    ...validateChangedSurfaces(options.root, options.publishableFiles, options.changedFiles),
    ...validateGuidanceBaseline(options.root, options.guidanceBaseline),
  ];

  for (const path of checkWorkflowCapabilityPublications(options.root, options.publicationOverrides)) {
    diagnostics.push(
      diagnostic(
        WorkflowReleaseDiagnosticCode.STALE_GENERATED_SURFACE,
        path,
        `Generated workflow capability publication is stale: ${path}.`,
      ),
    );
  }
  if (!checkWorkflowContextMeasurement(options.root, options.contextMeasurement)) {
    diagnostics.push(
      diagnostic(
        WorkflowReleaseDiagnosticCode.STALE_GENERATED_SURFACE,
        WORKFLOW_CONTEXT_MEASUREMENT_PATH,
        `Generated workflow context measurement is stale: ${WORKFLOW_CONTEXT_MEASUREMENT_PATH}.`,
      ),
    );
  }
  return diagnostics;
}
