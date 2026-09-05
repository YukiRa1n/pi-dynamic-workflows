import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// Mechanical patch for installed Pi 0.84.x, including its bundled CLI.
// Exact anchors fail closed on incompatible upgrades. Originals are retained.
for (const file of process.argv.slice(2)) {
  const input = readFileSync(file, "utf8");
  const start = input.indexOf("async emitBeforeProviderRequest(payload)");
  const end = input.indexOf("async emitBeforeProviderHeaders(headers)", start);
  if (start < 0 || end < 0) throw new Error(`Unsupported Pi runner: ${file}`);
  const method = input.slice(start, end);
  if (method.includes('type:"provider_request_prepared"')) {
    console.log(`Already patched: ${file}`);
    continue;
  }
  if (method.split("return currentPayload").length !== 2) throw new Error(`Ambiguous return: ${file}`);
  const patched = method.replace(
    "return currentPayload",
    'await this.emit({type:"provider_request_prepared",payload:currentPayload});return currentPayload',
  );
  if (!existsSync(`${file}.request-trace-original`)) copyFileSync(file, `${file}.request-trace-original`);
  writeFileSync(file, input.slice(0, start) + patched + input.slice(end));
  console.log(`Patched final payload event: ${file}`);
}
