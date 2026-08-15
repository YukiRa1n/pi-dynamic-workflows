import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityClassification, CapabilitySupport, WORKFLOW_CAPABILITY_CONTRACT, } from "./workflow-capability-contract.js";
const GENERATED_MARKER = "<!-- GENERATED from WORKFLOW_CAPABILITY_CONTRACT; do not edit by hand. -->";
const TABLE_START = "<!-- BEGIN GENERATED SUPPORTED WORKFLOW CAPABILITIES -->";
const TABLE_END = "<!-- END GENERATED SUPPORTED WORKFLOW CAPABILITIES -->";
/** Package-relative compact capability index generated from the contract. */
export const CAPABILITY_INDEX_PATH = "skills/workflow-authoring/references/capabilities.md";
/** Package-relative exhaustive generated capability reference. */
export const CAPABILITY_DETAIL_PATH = "skills/workflow-authoring/references/capability-details.md";
/** Documents that embed the byte-identical supported-capability table. */
export const CAPABILITY_TABLE_PUBLICATION_PATHS = [
    CAPABILITY_INDEX_PATH,
    "README.md",
    "docs/workflow-authoring.md",
];
/** All generated capability publication surfaces checked for drift. */
export const CAPABILITY_PUBLICATION_PATHS = [...CAPABILITY_TABLE_PUBLICATION_PATHS, CAPABILITY_DETAIL_PATH];
function escapeTable(value) {
    return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
function display(value) {
    return value === null ? "—" : `\`${escapeTable(value)}\``;
}
function optionText(option) {
    const required = option.optional ? "optional" : "required";
    const defaultValue = option.default === null ? "" : `; default: ${option.default}`;
    const constraints = option.constraints.length === 0 ? "" : `; ${option.constraints.join("; ")}`;
    const dynamic = option.dynamicReference === null ? "" : `; dynamic reference: ${option.dynamicReference}`;
    return `- \`${option.name}\`: ${option.type} (${required}${defaultValue}${constraints}${dynamic})`;
}
function compactOptions(fact) {
    if (!fact.options)
        return "—";
    return fact.options.options
        .map((option) => {
        const optionality = option.optional ? "optional" : "required";
        const defaultValue = option.default === null ? "" : `; default: ${option.default}`;
        return `\`${escapeTable(option.name)}\`: ${escapeTable(option.type)} (${optionality}${escapeTable(defaultValue)})`;
    })
        .join("<br>");
}
function publishedFacts() {
    return WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts().filter((fact) => fact.support === CapabilitySupport.SUPPORTED &&
        (fact.classification === CapabilityClassification.RUNTIME_GLOBAL ||
            fact.classification === CapabilityClassification.WORKFLOW_TOOL_INPUT));
}
/** The byte-identical generated block embedded in every public documentation surface. */
export function renderSupportedCapabilityTable() {
    const rows = publishedFacts().map((fact) => `| ${escapeTable(fact.label)} | ${fact.classification} | ${display(fact.signature)} | ${compactOptions(fact)} |`);
    return `${TABLE_START}
| Name | Classification | Signature | Options and defaults |
| --- | --- | --- | --- |
${rows.join("\n")}
${TABLE_END}`;
}
function replaceSupportedCapabilityTable(document) {
    const start = document.indexOf(TABLE_START);
    const end = document.indexOf(TABLE_END, start + TABLE_START.length);
    if (start < 0 || end < 0 || document.indexOf(TABLE_START, start + TABLE_START.length) >= 0)
        return null;
    const after = end + TABLE_END.length;
    return `${document.slice(0, start)}${renderSupportedCapabilityTable()}${document.slice(after)}`;
}
/** Regenerates only contract-owned content, preserving hand-written prose around marked blocks. */
export function writeWorkflowCapabilityPublications(root) {
    for (const path of CAPABILITY_TABLE_PUBLICATION_PATHS) {
        const absolutePath = join(root, path);
        if (path === CAPABILITY_INDEX_PATH) {
            writeFileSync(absolutePath, renderWorkflowCapabilityReference());
            continue;
        }
        const source = readFileSync(absolutePath, "utf8");
        const refreshed = replaceSupportedCapabilityTable(source);
        if (refreshed === null)
            throw new Error(`Missing or duplicate generated capability-table anchors in ${path}.`);
        writeFileSync(absolutePath, refreshed);
    }
    writeFileSync(join(root, CAPABILITY_DETAIL_PATH), renderWorkflowCapabilityDetails());
}
/** Returns every stale surface in stable publication order. Overrides are useful to CI callers and tests. */
export function checkWorkflowCapabilityPublications(root, overrides = {}) {
    const stale = [];
    for (const path of CAPABILITY_TABLE_PUBLICATION_PATHS) {
        const actual = overrides[path] ?? readFileSync(join(root, path), "utf8");
        if (path === CAPABILITY_INDEX_PATH) {
            if (actual !== renderWorkflowCapabilityReference())
                stale.push(path);
            continue;
        }
        const refreshed = replaceSupportedCapabilityTable(actual);
        if (refreshed === null || refreshed !== actual)
            stale.push(path);
    }
    const details = overrides[CAPABILITY_DETAIL_PATH] ?? readFileSync(join(root, CAPABILITY_DETAIL_PATH), "utf8");
    if (details !== renderWorkflowCapabilityDetails())
        stale.push(CAPABILITY_DETAIL_PATH);
    return stale;
}
function anchorFor(fact) {
    const anchor = fact.reference?.split("#")[1];
    if (!anchor)
        throw new Error(`Static capability fact ${fact.id} has no reference anchor.`);
    return anchor;
}
function detail(fact) {
    const lines = [
        `<a id="${anchorFor(fact)}"></a>`,
        `## ${fact.label}`,
        "",
        `- Classification: \`${fact.classification}\``,
        `- Support: \`${fact.support}\``,
        `- Signature: ${display(fact.signature)}`,
    ];
    if (fact.options) {
        lines.push(`- Option shape: \`${fact.options.id}\``, ...fact.options.options.map(optionText));
    }
    if (fact.constraints.length > 0)
        lines.push(...fact.constraints.map((constraint) => `- Constraint: ${constraint}`));
    if (fact.dynamicReference) {
        lines.push(`- Dynamic reference owner: \`${fact.dynamicReference.owner}\``, `- Item shape: \`${fact.dynamicReference.itemShape}\``, `- Future lookup connection: \`${fact.dynamicReference.connection}\``, "- Live values are intentionally absent from this static reference.");
    }
    return `${lines.join("\n")}\n`;
}
/** Compact generated entrypoint for ordinary exact-name and signature lookup. */
/** Render the compact index that routes exact lookups to exhaustive details. */
export function renderWorkflowCapabilityReference() {
    const { definition } = WORKFLOW_CAPABILITY_CONTRACT;
    return `${GENERATED_MARKER}
# Workflow capability index

Contract format: \`${definition.versions.format.version}\`<br>
Contract content / skill / extension: \`${definition.versions.content.version}\`

This compact generated index covers supported runtime globals and workflow-tool inputs. For constraints, compatibility behavior, internal boundaries, and dynamic-reference ownership, follow the [exhaustive generated facts](capability-details.md).

## Supported capability index

${renderSupportedCapabilityTable()}
`;
}
/** Exhaustive generated fact projection and stable anchor owner. */
/** Render exhaustive static facts while leaving live catalogues as dynamic references. */
export function renderWorkflowCapabilityDetails() {
    const { definition } = WORKFLOW_CAPABILITY_CONTRACT;
    const facts = WORKFLOW_CAPABILITY_CONTRACT.projectStaticReferenceFacts();
    return `${GENERATED_MARKER}
# Exhaustive workflow capability facts

Contract format: \`${definition.versions.format.version}\`<br>
Contract content / skill / extension: \`${definition.versions.content.version}\`

Every exact fact below is projected from the installed extension's capability contract. Explanatory judgment belongs in the hand-written references next to this file.

${facts.map(detail).join("\n")}`;
}
