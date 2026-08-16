import { type CreateAgentSessionOptions, ModelRegistry, ModelRuntime, type ResourceDiagnostic, type Skill, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { type AgentHistoryEntry } from "./agent-history.js";
import { type ModelTierConfig, type RankableModel } from "./model-tier-config.js";
import { type StructuredOutputCapture } from "./structured-output.js";
/**
 * Last-resort structured-output recovery: extract a JSON block from prose, coerce
 * it toward the schema, and accept it only if it then validates. Never fabricates
 * — returns undefined unless the parsed value genuinely satisfies the schema.
 */
export declare function extractValidated<T>(text: string, schema: TSchema): T | undefined;
/**
 * The last assistant message's terminal metadata (stopReason/errorMessage). The pi
 * SDK does NOT throw provider usage/quota limits — it records them as an assistant
 * message with stopReason "error" and an errorMessage. This is the only place that
 * metadata is observable to the workflow layer.
 */
export declare function lastAssistantError(messages: unknown[]): {
    stopReason?: string;
    errorMessage?: string;
} | undefined;
/**
 * If the subagent's turn ended in a provider usage/quota/rate-limit error, throw a
 * PROVIDER_USAGE_LIMIT WorkflowError carrying the real provider message + reset hint.
 * Gated on stopReason === "error" so a successful turn whose text merely mentions
 * "rate limit" is never misclassified. recoverable:false so the run checkpoints
 * (paused) rather than being retried into the same wall or collapsed to a silent null.
 */
export declare function throwIfProviderLimit(messages: unknown[], label?: string): void;
/**
 * If the subagent's turn ended in a terminal provider/streaming error that is NOT a
 * usage/quota limit (connection reset, 5xx, invalid request, ...), throw
 * AGENT_EXECUTION_ERROR carrying the real provider message. The pi SDK encodes these
 * as an assistant message with stopReason "error" and an errorMessage; without this
 * guard a non-schema agent would be misreported as AGENT_EMPTY_OUTPUT and a schema
 * agent would waste repair prompts before reporting SCHEMA_NONCOMPLIANCE.
 */
export declare function throwIfProviderExecutionError(messages: unknown[], label?: string): void;
/** Minimal session surface resolveStructuredOutput needs (real session or a test double). */
export interface StructuredSession {
    prompt(text: string): Promise<void>;
    setActiveToolsByName?(names: string[]): void;
    messages: unknown[];
}
/**
 * Resolve a schema agent's result. If the tool was called, return the captured
 * value. Otherwise re-prompt up to maxSchemaRetries (tools restricted to
 * structured_output), then try strict schema-validated prose extraction, else
 * throw SCHEMA_NONCOMPLIANCE (non-recoverable — surfaced, never a silent null).
 * Module-level with an injected `lastText` so it is unit-testable.
 */
export declare function resolveStructuredOutput<T>(session: StructuredSession, capture: StructuredOutputCapture<T>, schema: TSchema, options: {
    maxSchemaRetries?: number;
    signal?: AbortSignal;
    label?: string;
}, lastText: (messages: unknown[]) => string): Promise<T>;
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
export declare function resolveAgentModelSpec(options: {
    model?: string;
    tier?: string;
}, mainModel: string | undefined, loadConfig?: () => ModelTierConfig | null, onTierWithoutConfig?: (tier: string) => void): string | undefined;
export interface WorkflowAgentOptions {
    cwd?: string;
    /** Extra tools available to the subagent in addition to the structured output tool. */
    tools?: ToolDefinition[];
    /**
     * Extra tool NAMES to deny in the subagent session, on top of the always-on
     * defaults ({@link DEFAULT_EXCLUDED_SUBAGENT_TOOLS}). Lets the host exclude
     * other recursive-orchestration tools it registers (e.g. a pi-subagents tool)
     * so a workflow subagent can't fan out through them either (#107).
     */
    excludeTools?: string[];
    /** Override any createAgentSession option (model, modelRuntime, resourceLoader, etc.). */
    session?: Partial<CreateAgentSessionOptions>;
    /** Extra system guidance prepended to every subagent task. */
    instructions?: string;
    /**
     * The session's main model (`provider/modelId`). Used as a fallback when
     * resolving opts.tier and no model-tiers.json config exists. Without this,
     * a workflow using `{ tier: "small" }` would log a warning and fall through
     * to the session default when no config is saved yet.
     */
    mainModel?: string;
    /**
     * Shared model registry from the host Pi session. When provided, subagents
     * resolve tier/model specs against the same registry the main session uses,
     * including dynamically-registered providers such as ollama-cloud. Without
     * this, the agent builds an isolated registry from disk and may miss models
     * that are only available via extension registration.
     */
    modelRegistry?: ModelRegistry;
    /**
     * Persist each subagent transcript as a real pi session file under the
     * standard sessions directory (keyed by the runner's project cwd), instead
     * of the default in-memory session that is discarded when the run ends.
     * Default: false (current behavior).
     */
    persistAgentSessions?: boolean;
}
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
export declare function runtimeOf(registry: ModelRegistry): ModelRuntime | undefined;
/**
 * List the user's currently available models (those with auth configured) with
 * the minimal fields tier ranking needs: canonical spec, output price, and
 * context window. This is the single place the SDK `Model` is projected into
 * the SDK-agnostic `RankableModel`. Best-effort: returns [] if the registry
 * can't be built (or while the disk-backed fallback is still initializing).
 */
export declare function listAvailableModels(registry?: ModelRegistry): RankableModel[];
/**
 * List the user's currently available models as `provider/modelId` specs. Used
 * to tell the workflow author which models it may route agents to. Best-effort:
 * returns [] if the registry can't be built.
 */
export declare function listAvailableModelSpecs(registry?: ModelRegistry): string[];
/** Real token/cost usage for a single subagent run, read from the SDK session. */
export interface AgentUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    cost: number;
}
/**
 * Map session stats to an AgentUsage, or undefined when the provider reported
 * no usage at all (all-zero stats). Returning undefined — instead of a zero
 * breakdown — lets displays fall back to their scalar token count, so setups
 * on non-reporting providers render the same as before the split existed.
 */
export declare function usageFromStats(stats: {
    tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
    cost: number;
}): AgentUsage | undefined;
export interface AgentRunOptions<TSchemaDef extends TSchema | undefined = undefined> {
    label?: string;
    /**
     * Display name recorded on the persisted session (session_info entry) when
     * `persistAgentSessions` is enabled, so transcripts are identifiable in
     * session pickers (e.g. `workflow:<runId> <label>`). Ignored for in-memory
     * sessions or when an explicit session.sessionManager override is injected.
     */
    sessionName?: string;
    schema?: TSchemaDef;
    tools?: ToolDefinition[];
    instructions?: string;
    signal?: AbortSignal;
    /** Called after the child session is created and before its first prompt. */
    onSessionReady?: (session: {
        sendUserMessage(content: string, options?: {
            deliverAs?: "steer" | "followUp";
        }): Promise<void>;
    }) => void;
    /** Release a same-prefix fan-out gate when the first assistant response starts. */
    onFirstAssistantMessage?: () => void;
    /** Receives whether this attempt owns the same-prefix warm-up request. */
    onCacheWarmOwner?: (owner: boolean) => void;
    /** Optional same-prefix fan-out gate; wait before the first API request. */
    cacheWarmGate?: {
        wait: (signal?: AbortSignal) => Promise<boolean>;
        warm: () => void;
        release: () => void;
    };
    /** Called when this child session is disposed, including failed attempts. */
    onSessionEnd?: (session: {
        sendUserMessage(content: string, options?: {
            deliverAs?: "steer" | "followUp";
        }): Promise<void>;
    }) => void;
    /**
     * Called once with this subagent's real usage, read from the session right
     * before disposal. Fires on both the success and error paths so partial
     * usage is never lost — but NOT when the provider reported no usage at all
     * (all-zero stats), so consumers keep their scalar fallback.
     */
    onUsage?: (usage: AgentUsage) => void;
    /**
     * Model spec for this subagent: either `provider/modelId` (unambiguous) or a
     * bare `modelId`, parsed with the same grammar as Pi CLI's `--model`. When it
     * can't be resolved to a known model, `run()` throws MODEL_NOT_FOUND rather
     * than silently substituting the session default — a wrong-model run would
     * otherwise look successful while quietly answering with different (or
     * unauthenticated) weights. When omitted, the session default applies.
     */
    model?: string;
    /**
     * Model tier name (e.g. "small", "medium", "big"). When set (and no explicit
     * `model` is given), the model is resolved from the user's model-tiers.json
     * config before `run()` starts, falling back to the session's main model when
     * the tier has no configured entry. An explicit `model` always takes priority,
     * so workflow scripts can use `{ tier: "small" }` for coarse routing without
     * caring which concrete model backs that tier.
     *
     * A script-requested tier that resolves to an unavailable model spec is just
     * as loud as an explicit `model` pin — `run()` throws MODEL_NOT_FOUND naming
     * the tier and the spec it resolved to, e.g. `tier "big" from
     * model-tiers.json resolves to "deadprov/x", which is not available`.
     *
     * That's deliberately asymmetric with the IMPLICIT default tier an untagged
     * agent (neither `model` nor `tier` set) gets routed through: since the
     * script never asked for that tier, a broken default degrades to the
     * session default instead of failing every untagged agent in the run — see
     * onModelFallback below for how that degrade stays visible.
     */
    tier?: string;
    /** Called with the resolved model id once known (for display/telemetry). */
    onModelResolved?: (modelId: string) => void;
    /**
     * Called (at most once per WorkflowAgent instance) when an UNTAGGED agent's
     * implicit default "medium" tier resolves to a model spec that isn't
     * available. This is the one case that degrades to the session default
     * instead of throwing MODEL_NOT_FOUND (see `tier` above) — but the degrade
     * must still land in the run's own log/event stream, not just a
     * console.warn, or a broken default tier silently drifts every untagged
     * agent's model with zero trace in the run itself.
     */
    onModelFallback?: (info: {
        tier: string;
        requestedSpec: string;
    }) => void;
    /** Called with a compact snapshot of this subagent's message/tool history. */
    onHistory?: (history: AgentHistoryEntry[]) => void;
    /** Run this agent in a different working directory (e.g. an isolated worktree). */
    cwd?: string;
    /**
     * Restrict the subagent's coding tools to these names (an agentType
     * definition's `tools` allowlist). Undefined = all coding tools. The
     * structured_output tool is always added after this filter, so a schema
     * still works under a restrictive allowlist.
     */
    toolNames?: string[];
    /** Remove these coding-tool names after the allowlist (an agentType `disallowedTools` denylist). */
    disallowedToolNames?: string[];
    /**
     * With `schema`: how many extra repair turns to allow if the model finishes
     * without calling structured_output. Each retry re-prompts (tools restricted to
     * structured_output) before falling back to strict prose extraction. Default 2.
     */
    maxSchemaRetries?: number;
    /**
     * Tools that are always injected AFTER the tool-policy filter (`toolNames` /
     * `disallowedToolNames`), so they are available even under a restrictive
     * allowlist. Used by the workflow runtime to inject shared-store tools into
     * every agent regardless of its agentType definition.
     */
    systemTools?: ToolDefinition[];
    /**
     * Per-run model registry override. Takes precedence over the constructor's
     * `modelRegistry` (WorkflowAgentOptions.modelRegistry) for both model
     * resolution and the `createAgentSession` call this run makes. Falls back to
     * the constructor's shared registry, then a lazily-built disk registry, when
     * omitted.
     */
    modelRegistry?: ModelRegistry;
}
export type AgentRunResult<TSchemaDef extends TSchema | undefined> = TSchemaDef extends TSchema ? Static<TSchemaDef> : string;
/**
 * Orchestration tools always denied to workflow subagents. The stock extension
 * exposes only `start_workflow`, but embedders may also register the library,
 * lifecycle, or steering tools. Nested background runs would escape the parent's
 * limits and accounting,
 * so all known orchestration names remain fail-closed here. Callers may deny
 * additional names via WorkflowAgentOptions.excludeTools.
 */
export declare const DEFAULT_EXCLUDED_SUBAGENT_TOOLS: string[];
/**
 * The full subagent tool denylist: the always-on defaults plus any names the
 * caller added (via WorkflowAgentOptions.excludeTools) or set on the injected
 * session options. Extracted so the merge — and its order — is unit-testable;
 * a spread-order regression that dropped the defaults would slip past a test
 * that only asserts the constant. The SDK dedupes, so overlap is harmless.
 */
export declare function subagentExcludedTools(extra?: string[], sessionExclude?: string[]): string[];
export declare function filterBundledWorkflowSkills(base: {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
}): {
    skills: Skill[];
    diagnostics: ResourceDiagnostic[];
};
export declare class WorkflowAgent {
    private readonly cwd;
    private readonly baseTools;
    /** Extra subagent tool-name denylist, merged with the always-on defaults. */
    private readonly excludeTools;
    private readonly sessionOptions;
    private readonly persistAgentSessions;
    private readonly instructions?;
    private readonly mainModel?;
    /** Shared registry from the host session, when provided. */
    private readonly sharedRegistry?;
    /** Lazily built once; shares the SDK's agentDir/auth so resolved models are authed. */
    private registry?;
    /**
     * Memoized model-tiers.json snapshot, boxed so a legitimately-null config
     * (file absent/invalid) is distinguishable from "not loaded yet". See
     * loadTierConfig() below for why this is scoped per-instance.
     */
    private tierConfigBox?;
    /**
     * Shared resource loader for every subagent of this run, built once. See
     * getSharedResourceLoader — this is the #109 memory mitigation.
     */
    private sharedResourceLoaderPromise?;
    /**
     * Emitted at most once per instance (~= once per run, see the class-level
     * lifetime note above): the untagged/default "medium" tier resolved to a
     * model spec that isn't available. Deliberately per-instance rather than a
     * MODEL_NOT_FOUND throw — an untagged agent never asked for that specific
     * model, so a broken default tier shouldn't fail every untagged agent in the
     * run. See onModelFallback below for the (still-loud) degrade path.
     */
    private warnedDefaultTierUnavailable;
    constructor(options?: WorkflowAgentOptions);
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
    private getSharedResourceLoader;
    /**
     * Resolve the registry for a run: an explicit per-run registry wins, then the
     * constructor's shared registry, then a lazily-built disk registry (shared
     * across calls once built). Async because pi >= 0.80.8 builds registries from
     * an async-created ModelRuntime.
     */
    private getRegistry;
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
    private loadTierConfig;
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
    private createSessionManager;
    /** Best-effort write probe: throws if the session directory isn't actually writable. */
    private assertSessionDirWritable;
    run<TSchemaDef extends TSchema | undefined = undefined>(prompt: string, options?: AgentRunOptions<TSchemaDef>): Promise<AgentRunResult<TSchemaDef>>;
    private buildPrompt;
    private lastAssistantText;
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
    private finalAssistantText;
}
