# Runtime authoring

Use this page for routine scripts. Open the generated capability index only when a signature, default, support boundary, or installed-version fact is missing here.

## Script envelope

Start with the only legal export: `export const meta = { name, description, phases?: [{ title, detail?, model? }] }`. Values are nonblank literals; declare only used phases and call `phase()` before each phase's work. The remaining body already runs inside an async function: write helpers as ordinary declarations; `export default` and other exports are invalid. Return the result explicitly.

The runtime supplies `agent`, `parallel`, `pipeline`, `createTeam`, `workflow`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`. Imports, `require()`, filesystem modules, `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable. The Node VM realm is implementation substrate, not a security boundary or public API.

## Topology

- `parallel([() => agent(...), ...])` takes thunks, runs independent work, and preserves input order. Variadic thunks (`parallel(fn1, fn2)`) are also accepted; promises are not. Await the whole result before whole-set synthesis.
- `pipeline()` runs stages sequentially per item while items proceed concurrently. Each stage receives `(previousValue, originalItem, index)` and forwards `null` to the next stage, so guard missing coverage first.
- `workflow(name, childArgs?)` runs a context-supplied saved workflow. Nesting is one level and shares limits, counters, tokens, and store.
- `createTeam(name)` creates a workflow-scoped peer team. `team.spawn([{ label, role, prompt, options? }])` runs members through the same scheduler; members receive targeted `team_send_message`, `team_inbox`, `team_members`, and shared task-board tools. Workflow code retains broadcast APIs when every member truly needs the same task-changing update. Add tasks with `team.addTask(title, description?)`. Team mailbox/task side effects are intentionally rerun live on resume rather than replayed from the ordinary agent journal.

Example:

```js
const team = createTeam("security-review");
const taskIds = team.addTasks([
  { title: "Dependencies", description: "Inspect vulnerable dependencies" },
  { title: "Auth", description: "Inspect authentication boundaries" },
]);
const findings = await team.spawn([
  { label: "dependency-reviewer", role: "dependency analyst", prompt: "Claim and complete the dependency task." },
  { label: "auth-reviewer", role: "security analyst", prompt: "Claim and complete the auth task." },
]);
return { taskIds, findings, team: team.snapshot() };
```

## Data and failure

Call `agent(prompt, { label, schema? })`; it returns text, a schema-validated value, or recoverable `null`. Nonrecoverable limit, validation, and budget failures throw. Record each intended work ID before filtering. A `null` means missing coverage, never a negative finding.

When JavaScript reads fields, pass a small plain JSON Schema. Schema noncompliance after repair throws and bypasses agent retries. Catch it only to return an explicit incomplete outcome without reading missing fields. Return objects, arrays, strings, numbers, booleans, and `null`—not functions, promises, cycles, `BigInt`, or runtime handles.

## Routing and support

Selector priority is explicit `model` > `agentType` model > `tier` > phase model > metadata model > implicit `medium` > session default. An unavailable EXPLICIT selector (`model`, `agentType` model, `tier`, or phase model) throws instead of falling back — catch it if the script needs to degrade gracefully. Only the implicit default `medium` tier an untagged agent falls into degrades to the session default when unavailable, with a one-time warning logged into the run. Use exact `model`, nonstandard `tier`, or `agentType` only when context supplies its name and purpose. Worktree creation is fail-closed; post-settlement cleanup is best-effort and remains visible when reclamation is pending. See [registry ownership](registry-ownership.md).

Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only. VM realm facilities are internal. Active model routes and agent types are dynamic. Use `log()` in new scripts.
