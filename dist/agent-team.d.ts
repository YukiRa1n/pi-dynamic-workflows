import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
export type AgentTeamMemberStatus = "registered" | "running" | "done" | "failed" | "aborted";
export type AgentTeamTaskStatus = "pending" | "claimed" | "completed";
export interface AgentTeamMemberSnapshot {
    id: string;
    label: string;
    role?: string;
    status: AgentTeamMemberStatus;
}
export interface AgentTeamMessage {
    id: string;
    from: string;
    to: string;
    message: string;
}
export interface AgentTeamTaskSnapshot {
    id: string;
    title: string;
    description?: string;
    status: AgentTeamTaskStatus;
    assignee?: string;
    result?: string;
}
export interface AgentTeamSnapshot {
    id: string;
    name: string;
    members: AgentTeamMemberSnapshot[];
    tasks: AgentTeamTaskSnapshot[];
    pendingMessages: number;
}
export interface AgentTeamSpawnSpec {
    prompt: string;
    label?: string;
    role?: string;
    /** Reuse a registered logical member identity for a later team round. */
    memberId?: string;
    /** Regular agent() options such as model, tier, schema, isolation, and retries. */
    options?: Record<string, unknown>;
}
/**
 * In-process coordination state for one workflow agent team.
 *
 * The team is deliberately a workflow-scoped object: it coordinates peer
 * subagents during one run, but it does not create a second scheduler or a
 * second token/concurrency budget. Agent() remains the lifecycle primitive and
 * the workflow runtime remains the authoritative controller.
 */
export declare class WorkflowAgentTeam {
    readonly id: string;
    readonly name: string;
    private readonly maxMembers;
    private readonly members;
    private readonly inboxes;
    private readonly tasks;
    private memberSeq;
    private messageSeq;
    private taskSeq;
    constructor(id: string, name: string, maxMembers?: number);
    addMember(label: string, role?: string, requestedId?: string): string;
    /** Register a new attempt for a member; only this generation may mutate status. */
    beginAttempt(memberId: string): number;
    /** Mark running only if the caller is the current attempt generation. */
    markRunning(memberId: string, attemptGen?: number): boolean;
    /** Mark done only if the caller is the current attempt generation. */
    markDone(memberId: string, attemptGen?: number): boolean;
    /** Mark a member failed after retry exhaustion or a non-recoverable error. */
    markFailed(memberId: string, attemptGen?: number): boolean;
    /** Mark a member aborted (external abort / run stop). */
    markAborted(memberId: string, attemptGen?: number): boolean;
    /**
     * Release a claimed task back to pending so another member can claim it
     * (TEAM-RETRY-002 — a claimant that fails/exhausts/aborts must not strand
     * the task forever). No-op unless the caller currently holds the claim.
     */
    releaseClaim(memberId: string, taskId: string): boolean;
    /**
     * Release every non-completed task currently held by a member (failed
     * attempt / abort cleanup). Completed tasks stay completed (irreversible).
     */
    releaseClaims(memberId: string, attemptGen?: number): void;
    /** Whether a member with this ID is already registered. */
    hasMember(memberId: string): boolean;
    /**
     * Preflight a spawn batch WITHOUT mutating team state (TEAM-SPAWN-005):
     * validates input, duplicate IDs within the batch, and member capacity.
     * Returns planned entries; callers must check cross-team ownership of any
     * requestedId against their own registry, then {@link commitSpawn}.
     */
    planSpawn(specs: AgentTeamSpawnSpec[]): Array<{
        memberId: string;
        label: string;
        role?: string;
        isNew: boolean;
    }>;
    /** Commit a previously planned spawn batch; no validation happens here. */
    commitSpawn(planned: Array<{
        memberId: string;
        label: string;
        role?: string;
        isNew: boolean;
    }>): string[];
    memberPrompt(memberId: string): string;
    addTask(title: string, description?: string, assignee?: string): string;
    addTasks(tasks: Array<{
        title: string;
        description?: string;
        assignee?: string;
    }>): string[];
    send(from: string, to: string, message: string, attemptGen?: number): AgentTeamMessage;
    broadcast(from: string, message: string, attemptGen?: number): number;
    sendFromWorkflow(to: string, message: string): AgentTeamMessage;
    broadcastFromWorkflow(message: string): number;
    readInbox(memberId: string, attemptGen?: number): AgentTeamMessage[];
    listMembers(): AgentTeamMemberSnapshot[];
    listTasks(): AgentTeamTaskSnapshot[];
    claimTask(memberId: string, taskId: string, attemptGen?: number): AgentTeamTaskSnapshot;
    completeTask(memberId: string, taskId: string, result?: string, attemptGen?: number): AgentTeamTaskSnapshot;
    snapshot(): AgentTeamSnapshot;
    /** Static tool schemas; dynamic team/member identity stays in closures. */
    createTools(memberId: string, attemptGen?: number): ToolDefinition[];
    private assertMemberAttempt;
    private member;
    private task;
}
