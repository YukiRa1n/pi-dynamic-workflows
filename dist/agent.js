import { randomUUID } from "node:crypto";
import { realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, createCodingTools, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, } from "@earendil-works/pi-coding-agent";
import { Check, Convert } from "typebox/value";
import { compactAgentHistory } from "./agent-history.js";
import { applyToolPolicy } from "./agent-registry.js";
import { classifyProviderLimit, WorkflowError, WorkflowErrorCode } from "./errors.js";
import { canonicalModelSpec, resolveModelSpecWithThinking } from "./model-spec.js";
import { formatTierFallbackNotice, loadModelTierConfig, resolveTierModel, } from "./model-tier-config.js";
import { createStructuredOutputTool } from "./structured-output.js";
/**
 * Find a JSON object/array in free-form text: a fenced ```json block if present,
 * else the first balanced {...} or [...]. Best-effort (the schema check is the
 * real gate). Returns the raw JSON string, or undefined when none is found.
 */
function findJsonBlock(text) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence?.[1])
        return fence[1].trim();
    const start = text.search(/[{[]/);
    if (start === -1)
        return undefined;
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < text.length; i++) {
        if (text[i] === open)
            depth++;
        else if (text[i] === close && --depth === 0)
            return text.slice(start, i + 1);
    }
    return undefined;
}
/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export function extractValidated(text, schema) {
    const json = findJsonBlock(text);
    if (json === undefined)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(json);
    }
    catch {
        return undefined;
    }
    try {
        const converted = Convert(schema, parsed);
        if (Check(schema, converted))
            return converted;
    }
    catch {
        // typebox can throw on exotic schemas; treat as no match.
    }
    return undefined;
}
/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export function lastAssistantError(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message?.role !== "assistant")
            continue;
        return { stopReason: message.stopReason, errorMessage: message.errorMessage };
    }
    return undefined;
}
/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export function throwIfProviderLimit(messages, label) {
    const err = lastAssistantError(messages);
    if (err?.stopReason !== "error")
        return;
    const { matched, resetHint } = classifyProviderLimit(err.errorMessage);
    if (!matched)
        return;
    throw new WorkflowError(err.errorMessage ?? "Provider usage/quota limit reached", WorkflowErrorCode.PROVIDER_USAGE_LIMIT, { recoverable: false, agentLabel: label, resetHint });
}
/**
 * If the subagent's turn ended in a terminal provider/streaming error that is NOT a
 * usage/quota limit (connection reset, 5xx, invalid request, ...), throw
 * AGENT_EXECUTION_ERROR carrying the real provider message. The pi SDK encodes these
 * as an assistant message with stopReason "error" and an errorMessage; without this
 * guard a non-schema agent would be misreported as AGENT_EMPTY_OUTPUT and a schema
 * agent would waste repair prompts before reporting SCHEMA_NONCOMPLIANCE.
 */
export function throwIfProviderExecutionError(messages, label) {
    const err = lastAssistantError(messages);
    if (err?.stopReason !== "error")
        return;
    const { matched } = classifyProviderLimit(err.errorMessage);
    if (matched)
        return; // usage/quota handled by throwIfProviderLimit.
    throw new WorkflowError(err.errorMessage ?? "Provider execution failed", WorkflowErrorCode.AGENT_EXECUTION_ERROR, {
        recoverable: false,
        agentLabel: label,
    });
}
/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export async function resolveStructuredOutput(session, capture, schema, options, lastText) {
    if (capture.called)
        return capture.value;
    const maxRetries = Math.max(0, options.maxSchemaRetries ?? 2);
    // Restrict to the schema tool so the only useful next action is calling it
    // (takes effect on the next prompt turn). Best-effort.
    try {
        session.setActiveToolsByName?.(["structured_output"]);
    }
    catch {
        // ignore — the re-prompt alone still drives most models to comply
    }
    for (let attempt = 0; attempt < maxRetries && !capture.called; attempt++) {
        if (options.signal?.aborted)
            throw new Error("Subagent was aborted");
        await session.prompt("Call structured_output with the final result.");
    }
    if (capture.called)
        return capture.value;
    const extracted = extractValidated(lastText(session.messages), schema);
    if (extracted !== undefined) {
        console.warn("[workflow] structured_output recovered from prose extraction (the model never called the tool); prefer a tool-reliable model");
        return extracted;
    }
    // A repair re-prompt can itself hit the provider limit. Surface that as the real
    // (recoverable) cause instead of the misleading non-recoverable SCHEMA_NONCOMPLIANCE.
    throwIfProviderLimit(session.messages, options.label);
    // A repair re-prompt can also fail with a non-limit provider error (connection
    // reset / 5xx). Surface the real provider error instead of SCHEMA_NONCOMPLIANCE.
    throwIfProviderExecutionError(session.messages, options.label);
    throw new WorkflowError("Subagent did not produce valid structured_output after repair attempts", WorkflowErrorCode.SCHEMA_NONCOMPLIANCE, { recoverable: false, agentLabel: options.label });
}
/**
 * Resolve which concrete model spec a subagent should use. Precedence, most
 * specific first:
 *   1. options.model — an explicit per-agent model (also carries agentType /
 *      phase model, which the workflow layer folds into options.model).
 *   2. options.tier  — resolved via the model-tiers config, falling back to the
 *      session's main model when the tier has no configured entry.
 *   3. DEFAULT TIER — when neither is set but the user has a model-tiers config,
 *      untagged agents default to the "medium" tier so a configured tier set
 *      actually affects the whole workflow (not just agents the script tagged).
 *      Fresh-install medium == the session model, so this is a no-op until the
 *      user customizes tiers via /workflows-models.
 * Returns undefined when nothing applies, so the session default is used.
 *
 * `loadConfig` is injectable for testing; it defaults to reading from disk.
 */
export function resolveAgentModelSpec(options, mainModel, loadConfig = loadModelTierConfig, onTierWithoutConfig) {
    if (options.model)
        return options.model;
    const config = loadConfig();
    if (options.tier) {
        // Tier requested but unconfigured → it silently falls back to mainModel.
        // Let the caller surface that (once) so the no-op is discoverable.
        if (!config)
            onTierWithoutConfig?.(options.tier);
        return (config ? resolveTierModel(options.tier, config) : undefined) ?? mainModel;
    }
    // Untagged agent: default to the configured medium tier when one exists.
    if (config) {
        const medium = resolveTierModel("medium", config);
        if (medium)
            return medium;
    }
    return undefined;
}
// pi >= 0.80.8: ModelRegistry is a sync facade over an async-created ModelRuntime
// (AuthStorage/ModelRegistry.create are gone). The disk-backed fallback is built
// lazily; sync callers see [] until it resolves and real specs on later reads.
let fallbackRuntimePromise;
let fallbackRegistry;
function ensureFallbackRegistry() {
    if (!fallbackRuntimePromise) {
        const dir = getAgentDir();
        // Same auth.json/models.json createAgentSession uses by default, so a model
        // resolved here carries valid credentials.
        fallbackRuntimePromise = (async () => {
            const runtime = await ModelRuntime.create({
                authPath: join(dir, "auth.json"),
                modelsPath: join(dir, "models.json"),
            });
            // Warm the availability snapshot so the facade's sync getAvailable() is
            // populated immediately after this promise resolves.
            await runtime.getAvailable().catch(() => { });
            return runtime;
        })();
        // Don't cache a rejection: a transient failure (e.g. auth.json lock) would
        // otherwise wedge the fallback for the rest of the process.
        fallbackRuntimePromise.catch(() => {
            fallbackRuntimePromise = undefined;
        });
    }
    return fallbackRuntimePromise.then((runtime) => {
        fallbackRegistry ??= new ModelRegistry(runtime);
        return fallbackRegistry;
    });
}
let warnedNoRuntime = false;
/**
 * The ModelRuntime behind a registry facade. pi's ModelRegistry does not expose
 * its runtime publicly, so reach into the private field (stable since 0.80.8);
 * subagent sessions need it to share the host session's exact catalog and auth
 * (createAgentSession takes modelRuntime, not a registry, since 0.80.8).
 *
 * Exported so the test suite can pin this pi-internals contract: the cast means
 * neither tsc nor mock-based tests would notice pi renaming the field, and the
 * runtime consequence is silent (subagents fall back to a default runtime and
 * extension-registered providers vanish from routing).
 */
export function runtimeOf(registry) {
    const runtime = registry.runtime;
    if (!runtime && !warnedNoRuntime) {
        warnedNoRuntime = true;
        console.warn("[workflow] ModelRegistry no longer carries a private `runtime` field (pi internals changed); subagents fall back to a default-built runtime and may miss extension-registered providers");
    }
    return runtime;
}
/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export function listAvailableModels(registry) {
    try {
        const modelRegistry = registry ?? fallbackRegistry;
        if (!modelRegistry) {
            // Kick off the async fallback build; this call reports [] and later
            // calls (e.g. the tool's lazy promptGuidelines re-reads) see real specs.
            void ensureFallbackRegistry().catch(() => { });
            return [];
        }
        return modelRegistry.getAvailable().map((model) => ({
            spec: canonicalModelSpec(model),
            costOutput: model.cost?.output,
            contextWindow: model.contextWindow,
        }));
    }
    catch {
        return [];
    }
}
/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export function listAvailableModelSpecs(registry) {
    return listAvailableModels(registry).map((model) => model.spec);
}
/**
 * Emitted at most once per process: when an agent asks for a tier but no
 * model-tiers.json exists, the tier silently falls back to the session model.
 * Surface that once (with the mapping the user would get by configuring) so the
 * no-op is discoverable. Diagnostics only — never lets a failure break a run.
 */
let warnedTierUnconfigured = false;
function warnTierUnconfiguredOnce(mainModel, registry) {
    if (warnedTierUnconfigured)
        return;
    warnedTierUnconfigured = true;
    try {
        console.warn(formatTierFallbackNotice(mainModel, listAvailableModels(registry)));
    }
    catch {
        // best-effort diagnostic
    }
}
/**
 * Emitted at most once per process when persistAgentSessions is enabled and a
 * session is actually persisted: full subagent transcripts (which may include
 * secrets or other sensitive context) are being written to disk. Surface the
 * privacy trade-off at run time, not only in the docs.
 */
let warnedPersistSecrets = false;
function warnPersistSecretsOnce(sessionDir) {
    if (warnedPersistSecrets)
        return;
    warnedPersistSecrets = true;
    console.warn(`[workflow] persistAgentSessions is ON: full subagent transcripts (which may include secrets or other sensitive context) are being written to disk under ${sessionDir}. Disable persistAgentSessions if that isn't intended.`);
}
/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export function usageFromStats(stats) {
    const { tokens, cost } = stats;
    if (tokens.total <= 0 && cost <= 0)
        return undefined;
    return {
        input: tokens.input,
        output: tokens.output,
        cacheRead: tokens.cacheRead,
        cacheWrite: tokens.cacheWrite,
        total: tokens.total,
        cost,
    };
}
/**
 * Orchestration tools always denied to workflow subagents. The stock extension
 * exposes only start, active-list, and exact-ID stop workflow tools, but embedders may also register the library,
 * lifecycle, or steering tools. Nested background runs would escape the parent's
 * limits and accounting,
 * so all known orchestration names remain fail-closed here. Callers may deny
 * additional names via WorkflowAgentOptions.excludeTools.
 */
export const DEFAULT_EXCLUDED_SUBAGENT_TOOLS = [
    "start_workflow",
    "list_active_workflows",
    "stop_workflow",
    "workflow",
    "workflow_control",
    "workflow_steer",
];
/**
 * The full subagent tool denylist: the always-on defaults plus any names the
 * caller added (via WorkflowAgentOptions.excludeTools) or set on the injected
 * session options. Extracted so the merge — and its order — is unit-testable;
 * a spread-order regression that dropped the defaults would slip past a test
 * that only asserts the constant. The SDK dedupes, so overlap is harmless.
 */
export function subagentExcludedTools(extra, sessionExclude) {
    return [...DEFAULT_EXCLUDED_SUBAGENT_TOOLS, ...(sessionExclude ?? []), ...(extra ?? [])];
}
/**
 * Resolve a skill path the same way on Windows and POSIX, following package
 * symlinks when possible. The fallback keeps this filter safe while a package
 * is being assembled and the target path does not exist yet.
 */
function canonicalSkillPath(path) {
    const resolved = resolve(path);
    let canonical = resolved;
    try {
        canonical = realpathSync(resolved);
    }
    catch {
        // Keep the lexical path for missing paths; the loader only supplies real
        // skill files, but this makes the predicate safe for synthetic callers.
    }
    return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
/**
 * The package's workflow skills are useful to the host, where the `workflow`
 * tool exists, but misleading in subagents whose extensions are deliberately
 * disabled. Match the package-owned paths rather than skill names so a user's
 * or project's same-named skill is never removed.
 */
const WORKFLOW_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUBAGENT_HIDDEN_WORKFLOW_SKILL_FILES = new Set(["workflow-authoring", "workflow-patterns"].map((name) => canonicalSkillPath(join(WORKFLOW_PACKAGE_ROOT, "skills", name, "SKILL.md"))));
export function filterBundledWorkflowSkills(base) {
    return {
        ...base,
        skills: base.skills.filter((skill) => !SUBAGENT_HIDDEN_WORKFLOW_SKILL_FILES.has(canonicalSkillPath(skill.filePath))),
    };
}
export class WorkflowAgent {
    cwd;
    baseTools;
    /** Extra subagent tool-name denylist, merged with the always-on defaults. */
    excludeTools;
    sessionOptions;
    persistAgentSessions;
    instructions;
    mainModel;
    /** Shared registry from the host session, when provided. */
    sharedRegistry;
    /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
    registry;
    /**
     * Memoized model-tiers.json snapshot, boxed so a legitimately-null config
     * (file absent/invalid) is distinguishable from "not loaded yet". See
     * loadTierConfig() below for why this is scoped per-instance.
     */
    tierConfigBox;
    /**
     * Shared resource loader for every subagent of this run, built once. See
     * getSharedResourceLoader — this is the #109 memory mitigation.
     */
    sharedResourceLoaderPromise;
    /**
     * Emitted at most once per instance (~= once per run, see the class-level
     * lifetime note above): the untagged/default "medium" tier resolved to a
     * model spec that isn't available. Deliberately per-instance rather than a
     * MODEL_NOT_FOUND throw — an untagged agent never asked for that specific
     * model, so a broken default tier shouldn't fail every untagged agent in the
     * run. See onModelFallback below for the (still-loud) degrade path.
     */
    warnedDefaultTierUnavailable = false;
    constructor(options = {}) {
        this.cwd = options.cwd ?? process.cwd();
        this.baseTools = options.tools ?? createCodingTools(this.cwd);
        this.excludeTools = options.excludeTools ?? [];
        this.sessionOptions = options.session ?? {};
        this.persistAgentSessions = options.persistAgentSessions ?? false;
        this.instructions = options.instructions;
        this.mainModel = options.mainModel;
        this.sharedRegistry = options.modelRegistry;
    }
    /**
     * A resource loader shared by every subagent of this run, built once (#109).
     *
     * Without a resourceLoader, createAgentSession() builds a fresh
     * DefaultResourceLoader per subagent and reloads it — re-running EVERY installed
     * extension factory each time (verified: N subagents → N factory runs). Each
     * such factory that arms a load-time timer/listener then roots its subagent
     * session forever, because AgentSession.dispose() emits no session_shutdown to
     * run the cleanup — the dominant #109 leak, and one our own extension
     * (UsageLimitScheduler) can trigger.
     *
     * `noExtensions: true` skips loading host extensions; user/project skills,
     * prompts, and AGENTS.md context still load. The two package-owned workflow
     * guidance skills are filtered by `skillsOverride` below because they describe
     * a host-only workflow tool surface. The subagent keeps the tools this
     * workflow hands it via `customTools` (coding tools + any toolset like
     * web-research) — those are unaffected. What it loses is HOST
     * EXTENSION-REGISTERED tools (MCP bridges, browser tools, anything a host
     * extension added via ctx.registerTool):
     * pre-change a subagent session inherited those from the full host extension
     * set, now it does not, so an agentType `tools` allowlist naming one matches
     * nothing. This is a deliberate trade-off — it also structurally kills recursive
     * orchestration in subagents (no extension runtime at all), beyond the name-level
     * #107 denylist — and must be release-noted. `createAgentSession` with a shared
     * resourceLoader is a supported embedding pattern. runWorkflow builds one
     * WorkflowAgent per run, so this loader's lifetime is exactly one run: built
     * once, reused by all its subagents, then dropped with the agent.
     */
    getSharedResourceLoader(agentDir) {
        if (!this.sharedResourceLoaderPromise) {
            this.sharedResourceLoaderPromise = (async () => {
                const loader = new DefaultResourceLoader({
                    cwd: this.cwd,
                    agentDir,
                    settingsManager: SettingsManager.create(this.cwd, agentDir),
                    noExtensions: true,
                    skillsOverride: filterBundledWorkflowSkills,
                });
                await loader.reload();
                return loader;
            })().catch((err) => {
                // Don't let a transient build failure (e.g. EMFILE during reload's disk
                // I/O) poison every subagent AND every retry of this run — clear the memo
                // so the next caller rebuilds instead of replaying the same rejection.
                this.sharedResourceLoaderPromise = undefined;
                throw err;
            });
        }
        return this.sharedResourceLoaderPromise;
    }
    /**
     * Resolve the registry for a run: an explicit per-run registry wins, then the
     * constructor's shared registry, then a lazily-built disk registry (shared
     * across calls once built). Async because pi >= 0.80.8 builds registries from
     * an async-created ModelRuntime.
     */
    async getRegistry(perRunRegistry) {
        if (perRunRegistry) {
            return perRunRegistry;
        }
        if (this.sharedRegistry) {
            return this.sharedRegistry;
        }
        if (!this.registry) {
            this.registry = await ensureFallbackRegistry();
        }
        return this.registry;
    }
    /**
     * Read+parse ~/.pi/workflows/model-tiers.json at most once for this
     * instance's lifetime, instead of on every run() call. `resolveAgentModelSpec`
     * previously received `loadModelTierConfig` directly (sync existsSync +
     * readFileSync + JSON.parse from disk), which it calls unconditionally for
     * any agent without an explicit options.model — so a large fan-out did N
     * redundant synchronous disk reads that blocked the event loop and stalled
     * concurrent agents' I/O.
     *
     * `runWorkflow()` constructs a fresh `WorkflowAgent` per run (see
     * `new WorkflowAgent(options)` in workflow.ts, unless a caller injects its
     * own `options.agent` runner — a test-only escape hatch per
     * WorkflowManagerOptions.agent's doc comment), so a WorkflowAgent instance's
     * lifetime is one run in production. Memoizing on `this` therefore has the
     * same scope and lifetime as the agentRegistry snapshot workflow.ts already
     * takes once per run "for determinism" — the config file isn't expected to
     * change mid-run, and two different runs (= two different WorkflowAgent
     * instances) each get their own fresh read of whatever is on disk at the
     * time, so this does not leak stale config across runs or break tests that
     * construct fresh agents with different configs.
     *
     * `loader` is injectable for tests (defaults to the real disk read); it is
     * only ever consulted once, on the first call, regardless of what is passed
     * on later calls.
     */
    loadTierConfig(loader = loadModelTierConfig) {
        if (!this.tierConfigBox) {
            this.tierConfigBox = { value: loader() };
        }
        return this.tierConfigBox.value;
    }
    /**
     * Session manager for one subagent run. File-backed (persisted under the
     * standard sessions dir, keyed by the runner's project cwd — never a
     * per-call worktree cwd) when persistAgentSessions is on; in-memory otherwise.
     *
     * SessionManager.create() only creates the session directory — the SDK writes
     * the session file lazily (synchronous fs calls, uncaught) on the first
     * assistant message, deep inside session.prompt(). A failure there would
     * otherwise throw mid-run and abort this subagent. Probe writability up front
     * so any create/write failure (permissions, disk full) degrades this single
     * agent to an in-memory session instead — the run continues, just without a
     * persisted transcript.
     */
    createSessionManager() {
        if (!this.persistAgentSessions)
            return SessionManager.inMemory();
        try {
            const manager = SessionManager.create(this.cwd);
            this.assertSessionDirWritable(manager.getSessionDir());
            warnPersistSecretsOnce(manager.getSessionDir());
            return manager;
        }
        catch (error) {
            console.warn(`[workflow] persistAgentSessions: could not persist this agent's session (${error instanceof Error ? error.message : String(error)}); continuing with an in-memory session`);
            return SessionManager.inMemory();
        }
    }
    /** Best-effort write probe: throws if the session directory isn't actually writable. */
    assertSessionDirWritable(dir) {
        const probePath = join(dir, `.write-probe-${randomUUID()}`);
        writeFileSync(probePath, "");
        unlinkSync(probePath);
    }
    async run(prompt, options = {}) {
        const capture = { called: false, value: undefined };
        // Per-call cwd (e.g. a worktree) needs coding tools bound to that directory,
        // since tools capture their cwd at construction and can't be relocated.
        const runCwd = options.cwd ?? this.cwd;
        const baseTools = runCwd === this.cwd ? this.baseTools : createCodingTools(runCwd);
        // Apply the agentType tool policy BEFORE adding structured_output, so a
        // restrictive allowlist never strips the schema tool.
        const customTools = applyToolPolicy([...baseTools, ...(options.tools ?? [])], options.toolNames, options.disallowedToolNames);
        // System tools bypass the allowlist/denylist filter (e.g. shared-store tools).
        if (options.systemTools?.length) {
            customTools.push(...options.systemTools);
        }
        if (options.schema) {
            // Strict OpenAI-compatible providers (e.g. DeepSeek) reject a tool whose top-level
            // parameters schema isn't a JSON object with a transport-level 400, before any of
            // this file's SCHEMA_NONCOMPLIANCE/empty-output classification ever runs. Fail fast
            // here instead, so a script's non-object opts.schema surfaces a clear workflow error.
            const schemaType = options.schema.type;
            if (schemaType !== "object") {
                throw new WorkflowError(`agent() opts.schema must be a top-level JSON object schema (type: "object") — got type: ${schemaType ?? "undefined"}; wrap array/primitive results in an object, e.g. { type: "object", properties: { items: <your schema> } }`, WorkflowErrorCode.SCRIPT_VALIDATION_ERROR, { recoverable: false });
            }
            customTools.push(createStructuredOutputTool({ schema: options.schema, capture }));
        }
        // Per-run modelRegistry wins over the constructor's shared registry, then
        // the lazily-built disk fallback. Used for tier diagnostics, model
        // resolution, and the subagent session's runtime below.
        const modelRegistry = await this.getRegistry(options.modelRegistry);
        // Resolve the model spec (explicit model > tier > session default). This
        // composes with phase-based routing in workflow.ts, which only supplies
        // options.model when a phase pattern matches — so an explicit model wins.
        const modelSpec = resolveAgentModelSpec(options, this.mainModel, () => this.loadTierConfig(), () => warnTierUnconfiguredOnce(this.mainModel, modelRegistry));
        // Resolve a requested model spec to a Model object. Specs use Pi CLI-style
        // parsing, including an optional :thinking suffix such as gpt-5.5:xhigh.
        //
        // A given-but-unresolved spec's behavior is asymmetric by design (#131):
        //   - options.model or options.tier was explicitly set by the script (or by
        //     workflow.ts's phase-based routing, which only ever supplies
        //     options.model when the user configured that phase) → throw
        //     MODEL_NOT_FOUND naming the source. Resolution is deterministic, so
        //     retrying the same spec is pointless (recoverable:false), and a silent
        //     substitution would otherwise run real API calls against a different
        //     (or unauthenticated) model while the caller believes its pin/tier was
        //     honored.
        //   - neither was set: the agent is UNTAGGED and only got routed through
        //     the implicit default "medium" tier because *some other* agent's tier
        //     is configured (see resolveAgentModelSpec). This agent never asked for
        //     that model, so a broken default tier degrades to the session default
        //     instead of failing every untagged agent in the run — but the degrade
        //     still needs to be loud (onModelFallback), not a silent continuation.
        const isExplicitRequest = Boolean(options.model || options.tier);
        let resolvedModel;
        let resolvedThinkingLevel;
        if (modelSpec) {
            const resolved = resolveModelSpecWithThinking(modelSpec, modelRegistry);
            if (resolved.warning)
                console.warn(`[workflow] ${resolved.warning}`);
            if (!resolved.model) {
                if (isExplicitRequest) {
                    // The resolver's error already names the spec and the remedy; the tier
                    // branch swaps in its own message so the config source is named too.
                    const message = options.model
                        ? (resolved.error ?? `Model "${modelSpec}" not found. Use /workflows-models to choose an available model.`)
                        : `tier "${options.tier}" from model-tiers.json resolves to "${modelSpec}", which is not available. Use /workflows-models to choose an available model.`;
                    throw new WorkflowError(message, WorkflowErrorCode.MODEL_NOT_FOUND, {
                        recoverable: false,
                        agentLabel: options.label,
                    });
                }
                if (!this.warnedDefaultTierUnavailable) {
                    this.warnedDefaultTierUnavailable = true;
                    try {
                        options.onModelFallback?.({ tier: "medium", requestedSpec: modelSpec });
                    }
                    catch {
                        // Routing diagnostics cannot turn a valid fallback into a failure.
                    }
                }
            }
            else {
                resolvedModel = resolved.model;
                resolvedThinkingLevel = resolved.thinkingLevel;
                try {
                    options.onModelResolved?.(resolved.resolvedSpec ?? canonicalModelSpec(resolved.model));
                }
                catch {
                    // Display/telemetry callback only.
                }
            }
        }
        const agentDir = getAgentDir();
        // The runtime behind the resolved registry, handed to the subagent session
        // below so it shares the host session's exact catalog and auth.
        const modelRuntime = runtimeOf(modelRegistry);
        // Key persisted sessions by the runner's project cwd (this.cwd), NOT the
        // per-call runCwd: agents working in short-lived git worktrees should still
        // group under the project's session dir instead of scattering across
        // temporary worktree paths.
        const sessionManager = this.createSessionManager();
        const { session } = await createAgentSession({
            cwd: runCwd,
            agentDir,
            sessionManager,
            // Use real SettingsManager to inherit user's default provider/model settings.
            // SettingsManager.inMemory() doesn't load ~/.pi/settings.json, so subagents
            // would fall back to the first available model (e.g. openai-codex) which may
            // not have valid auth, causing silent empty responses.
            settingsManager: SettingsManager.create(this.cwd, agentDir),
            customTools,
            // Shared per-run loader with no host extensions (#109) — see
            // getSharedResourceLoader. An injected resourceLoader (tests / embedders)
            // wins and skips the shared build entirely; the ...this.sessionOptions
            // spread below re-applies the same injected value harmlessly.
            resourceLoader: this.sessionOptions.resourceLoader ?? (await this.getSharedResourceLoader(agentDir)),
            // Share the resolved registry's ModelRuntime (catalog + auth, including
            // extension-registered providers) with the subagent session. pi >= 0.80.8
            // takes modelRuntime here; the old modelRegistry option is gone.
            ...(modelRuntime ? { modelRuntime } : {}),
            ...this.sessionOptions,
            // Per-call model/thinking wins over any sessionOptions defaults.
            ...(resolvedModel ? { model: resolvedModel } : {}),
            ...(resolvedThinkingLevel ? { thinkingLevel: resolvedThinkingLevel } : {}),
            // Pi enables read/bash/edit/write by default when no active-name
            // allowlist is supplied, even if customTools is a complete replacement
            // toolset (for example web-research). Pin the provider-visible surface to
            // the policy-filtered definitions assembled above.
            tools: [...new Set(customTools.map((tool) => tool.name))],
            // Deny recursive-orchestration tools in the subagent (#107). Placed after
            // the sessionOptions spread so it always applies; folds in any denylist
            // the caller set on sessionOptions rather than dropping it.
            excludeTools: subagentExcludedTools(this.excludeTools, this.sessionOptions.excludeTools),
        });
        // Name the persisted session so it's identifiable in session pickers.
        // Skip when an injected session.sessionManager override won (tests/embedders).
        if (this.persistAgentSessions && !this.sessionOptions.sessionManager && options.sessionName) {
            try {
                sessionManager.appendSessionInfo(options.sessionName);
            }
            catch {
                // Naming is best-effort; never fail the run over it.
            }
        }
        let removeAbortListener;
        let removeHistoryListener;
        let removeCacheWarmListener;
        let firstAssistantMessageSeen = false;
        let cacheWarmOwner = false;
        let cacheWarmSettled = false;
        let promptCompleted = false;
        let lastHistoryEmit = 0;
        const emitHistory = () => options.onHistory?.(compactAgentHistory(session.messages));
        const maybeEmitHistory = () => {
            if (!options.onHistory)
                return;
            const now = Date.now();
            if (now - lastHistoryEmit < 250)
                return;
            lastHistoryEmit = now;
            // History is diagnostic only. It is invoked from a synchronous AgentSession
            // subscriber dispatch; an unguarded throw would be turned into a terminal
            // provider error by the SDK and could corrupt a successful turn (AS-002).
            try {
                emitHistory();
            }
            catch {
                // Best-effort: never let a diagnostic sink failure mask the real result/error.
            }
        };
        try {
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            if (options.signal) {
                const onAbort = () => void session.abort();
                options.signal.addEventListener("abort", onAbort, { once: true });
                removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
            }
            if (options.onHistory) {
                removeHistoryListener = session.subscribe(() => maybeEmitHistory());
            }
            if (options.onFirstAssistantMessage || options.cacheWarmGate) {
                removeCacheWarmListener = session.subscribe((event) => {
                    if (firstAssistantMessageSeen || event.type !== "message_start" || event.message.role !== "assistant")
                        return;
                    firstAssistantMessageSeen = true;
                    // Anthropic makes an automatic prompt-cache entry available as soon
                    // as the first response begins. Release same-prefix followers here,
                    // not after the owner finishes generating its potentially long answer.
                    if (cacheWarmOwner && options.cacheWarmGate) {
                        cacheWarmSettled = true;
                        options.cacheWarmGate.warm();
                    }
                    try {
                        options.onFirstAssistantMessage?.();
                    }
                    catch {
                        // best-effort observer
                    }
                    removeCacheWarmListener?.();
                    removeCacheWarmListener = undefined;
                });
            }
            cacheWarmOwner = options.cacheWarmGate ? await options.cacheWarmGate.wait(options.signal) : false;
            try {
                options.onCacheWarmOwner?.(cacheWarmOwner);
            }
            catch {
                // Cache telemetry is diagnostic only.
            }
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            const promptPromise = session.prompt(this.buildPrompt(prompt, options, Boolean(options.schema)));
            try {
                options.onSessionReady?.(session);
            }
            catch {
                // Session visibility is observer-only; the provider request is already live.
            }
            await promptPromise;
            promptCompleted = true;
            if (options.signal?.aborted)
                throw new Error("Subagent was aborted");
            // The SDK buries a provider usage/quota limit in the assistant message rather
            // than throwing; detect it here (before the schema/empty-text branches) so it
            // is classified as a recoverable checkpoint, not a SCHEMA_NONCOMPLIANCE failure
            // (schema path) or a silent empty-output null (non-schema path).
            throwIfProviderLimit(session.messages, options.label);
            // Non-limit provider/streaming errors (connection reset, 5xx, invalid request)
            // must surface as AGENT_EXECUTION_ERROR instead of AGENT_EMPTY_OUTPUT or a
            // wasted schema-repair round (AS-001). Do this before both branches.
            throwIfProviderExecutionError(session.messages, options.label);
            if (options.schema) {
                return (await resolveStructuredOutput(session, capture, options.schema, options, (m) => this.lastAssistantText(m)));
            }
            // Unstructured result: require assistant text AFTER the last tool result.
            // Text emitted before it is stale progress (the agent's last real action was
            // a tool call) — accepting it would report an incomplete run as successful
            // and suppress the AGENT_EMPTY_OUTPUT retry (#111).
            const text = this.finalAssistantText(session.messages);
            if (!text.trim()) {
                throw new WorkflowError("Subagent produced no assistant output", WorkflowErrorCode.AGENT_EMPTY_OUTPUT, {
                    recoverable: true,
                    agentLabel: options.label,
                });
            }
            return text;
        }
        finally {
            removeAbortListener?.();
            removeHistoryListener?.();
            removeCacheWarmListener?.();
            // A provider/SDK that omits message_start still gets a safe completion
            // fallback. Failure before any response promotes exactly one follower.
            if (cacheWarmOwner && !cacheWarmSettled) {
                cacheWarmSettled = true;
                if (promptCompleted || firstAssistantMessageSeen)
                    options.cacheWarmGate?.warm();
                else
                    options.cacheWarmGate?.release();
            }
            try {
                emitHistory();
            }
            catch {
                // History is diagnostic only; never let it mask the real result/error.
            }
            // Read real usage before disposing — dispose tears down the session state.
            if (options.onUsage) {
                try {
                    const usage = usageFromStats(session.getSessionStats());
                    if (usage)
                        options.onUsage(usage);
                }
                catch {
                    // Usage is best-effort; never let stats failure mask the real result/error.
                }
            }
            session.dispose();
            try {
                options.onSessionEnd?.(session);
            }
            catch {
                // Session teardown observers cannot change the agent result.
            }
        }
    }
    buildPrompt(prompt, options, structured) {
        const parts = [
            this.instructions,
            options.instructions,
            options.label ? `Task label: ${options.label}` : undefined,
            prompt,
        ].filter(Boolean);
        if (structured) {
            parts.push("Return the final result by calling structured_output.");
        }
        return parts.join("\n\n");
    }
    lastAssistantText(messages) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (message?.role !== "assistant" || !Array.isArray(message.content))
                continue;
            const text = message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
            if (text.trim())
                return text;
        }
        return "";
    }
    /**
     * The unstructured agent's FINAL answer: assistant text that appears after the
     * last tool result. Text before the final tool result is stale progress (the
     * agent's last real action was a tool call, not answering), so returning it
     * would mask an incomplete run and suppress AGENT_EMPTY_OUTPUT retries (#111).
     *
     * Distinct from lastAssistantText(), which stays deliberately lenient — the
     * schema path's prose-JSON recovery (resolveStructuredOutput) may need to read
     * the structured payload out of any assistant message, not only the terminal one.
     */
    finalAssistantText(messages) {
        // Locate the last tool result; only assistant text strictly after it counts.
        let lastToolResult = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]?.role === "toolResult") {
                lastToolResult = i;
                break;
            }
        }
        for (let i = messages.length - 1; i > lastToolResult; i--) {
            const message = messages[i];
            if (message?.role !== "assistant" || !Array.isArray(message.content))
                continue;
            const text = message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("");
            if (text.trim())
                return text;
        }
        return "";
    }
}
