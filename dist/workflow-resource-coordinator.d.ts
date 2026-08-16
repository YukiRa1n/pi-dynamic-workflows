/** Bounded process-local resource coordination shared by workflow executions. */
export interface LateAttemptMetadata {
    attemptId: string;
    runId: string;
    callId: string;
    generation: number;
    /** Execution-generation fence. A resumed execution must not share late IDs. */
    executionGeneration?: string;
    resourceGeneration?: string;
    label?: string;
    startedAt: number;
    lateAt?: number;
    usage?: unknown;
    usageState: "unknown" | "reported";
}
export interface ResourceDiagnostics {
    activeExecutions: number;
    maxActiveExecutions: number;
    queuedProviderAttempts: number;
    providerAttempts: number;
    lateProviderAttempts: number;
    activeAgentSenders: number;
    pendingMessageRuns: number;
    pendingMessageCount: number;
    pendingMessageBytes: number;
    retainedPausedRuns: number;
    persistenceBlockedRuns: number;
    lateAttempts: LateAttemptMetadata[];
}
export interface WorkflowResourceCoordinatorOptions {
    maxActiveExecutions?: number;
    maxProviderConcurrency?: number;
    maxQueuedProviderAttempts?: number;
    maxLateAttempts?: number;
}
/** Opaque, single-use execution admission capability. */
export interface ExecutionReservation {
    readonly runId: string;
    readonly namespace: string;
    readonly generation: string;
    readonly token: string;
}
export interface LateAttemptScope {
    runId?: string;
    executionGeneration?: string;
    resourceGeneration?: string;
}
/**
 * Execution admission and provider-attempt accounting. Provider permits are
 * deliberately released only by the release closure, which callers invoke in
 * the provider promise's finally (not when a logical timeout fires).
 */
export declare class WorkflowResourceCoordinator {
    readonly maxActiveExecutions: number;
    readonly maxProviderConcurrency: number;
    readonly maxQueuedProviderAttempts: number;
    readonly maxLateAttempts: number;
    private readonly executions;
    private readonly activeProviders;
    private readonly waiters;
    private readonly late;
    private sequence;
    constructor(options?: WorkflowResourceCoordinatorOptions);
    private executionKey;
    /** Acquire a generation-fenced capability. Callers must retain this exact
     * token; the key is intentionally not reconstructible as a release API. */
    acquireExecution(runId: string, namespace?: string, generation?: string): ExecutionReservation | null;
    /** Backwards-compatible, non-mutating eligibility probe. Actual admission
     * must use acquireExecution() and retain its opaque reservation. */
    tryAcquireExecution(runId: string, namespace?: string, generation?: string): boolean;
    releaseExecution(reservation: ExecutionReservation): void;
    /** @deprecated direct callers should retain the opaque reservation. */
    releaseExecution(runId: string, namespace?: string, generation?: string): void;
    /** Number of provider waiters, useful for deterministic admission tests. */
    get queuedProviderAttempts(): number;
    /** Return null if this waiter was cancelled or the bounded queue is full. */
    acquireProvider(runId: string, signal?: AbortSignal, namespace?: string, generation?: string): Promise<(() => void) | null>;
    private grant;
    private pump;
    registerLateAttempt(metadata: Omit<LateAttemptMetadata, "usageState" | "startedAt"> & {
        startedAt?: number;
        usageState?: "unknown" | "reported";
    }): {
        update: (patch: Partial<LateAttemptMetadata>) => void;
        settle: () => void;
    } | null;
    markLate(attemptId: string): void;
    markLateScope(scope: LateAttemptScope): void;
    getLateAttempts(): LateAttemptMetadata[];
    snapshot(extra?: Partial<ResourceDiagnostics>): ResourceDiagnostics;
}
/** Default process-wide budget used by managers created during extension reload. */
export declare const defaultWorkflowResourceCoordinator: WorkflowResourceCoordinator;
