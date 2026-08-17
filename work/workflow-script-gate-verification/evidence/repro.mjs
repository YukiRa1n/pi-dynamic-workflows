import { readFileSync } from "node:fs";
import { auditWorkflowScript } from "../../../src/workflow-script-gate.js";

const source = readFileSync("../../../skills/workflow-authoring/examples/defensive-json-parsing.js", "utf8");
console.log(JSON.stringify(auditWorkflowScript(source), null, 2));
