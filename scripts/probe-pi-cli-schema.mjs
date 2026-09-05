import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Exercise the validator embedded in the actual CLI, not a separately
// installed SDK dependency. The probe never invokes main() or a model.
const bundle = resolve(process.argv[2]);
const source = readFileSync(bundle, "utf8");
if (!source.includes("function validateToolArguments(")) throw new Error("Unsupported CLI bundle");
const probe = join(dirname(bundle), `schema-probe-${randomUUID()}.mjs`);
try {
  writeFileSync(probe, `${source}\nexport { validateToolArguments as probeValidate, loadExtensions as probeLoad };\n`);
  const { probeValidate, probeLoad } = await import(pathToFileURL(probe).href);
  const loaded = await probeLoad([resolve("extensions/workflow.ts")], process.cwd());
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  const registered = loaded.extensions
    .flatMap((ext) => [...ext.tools.values()])
    .find((tool) => tool.definition?.name === "start_workflow");
  if (!registered) throw new Error("Actual CLI loader did not register start_workflow");
  const tool = registered.definition;
  console.log("Schema source: actual CLI extension loader");
  console.log(JSON.stringify(tool.parameters.oneOf));
  for (const args of [
    { preset: "codebase-audit", args: { scope: "logs", checks: ["inventory"] } },
    { script: "return 1;" },
  ]) {
    try {
      const prepared = tool.prepareArguments ? await tool.prepareArguments(args) : args;
      console.log(`Prepared keys: ${Object.keys(prepared).join(",")}`);
      probeValidate(tool, { type: "toolCall", id: "schema-probe", name: tool.name, arguments: prepared });
      console.log(`PASS ${Object.keys(args).join(",")}`);
    } catch (error) {
      console.log(String(error));
      process.exitCode = 1;
    }
  }
} finally {
  unlinkSync(probe);
}
