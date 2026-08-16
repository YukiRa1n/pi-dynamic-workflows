import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_MAX_TEAM_MEMBERS, DEFAULT_MAX_TEAM_MESSAGES, DEFAULT_MAX_TEAM_TASKS } from "./config.js";
import { serializeBounded } from "./safe-serialize.js";
const MODEL_FACING_MESSAGE_KINDS = new Set(["blocker", "task_changing_fact", "decision"]);
/**
 * In-process coordination state for one workflow agent team.
 *
 * The team is deliberately a workflow-scoped object: it coordinates peer
 * subagents during one run, but it does not create a second scheduler or a
 * second token/concurrency budget. Agent() remains the lifecycle primitive and
 * the workflow runtime remains the authoritative controller.
 */
export class WorkflowAgentTeam {
    id;
    name;
    members = new Map();
    inboxes = new Map();
    tasks = new Map();
    memberSeq = 0;
    messageSeq = 0;
    taskSeq = 0;
    messageCount = 0;
    maxMembers;
    maxTasks;
    maxMessages;
    quota;
    quotaSuppressed = false;
    spawnReservations = new WeakMap();
    spawnCommits = new WeakMap();
    constructor(id, name, maxMembers = DEFAULT_MAX_TEAM_MEMBERS, options = {}) {
        this.id = id;
        this.name = name;
        this.quota = options.quota;
        this.maxMembers = positiveLimit(maxMembers, DEFAULT_MAX_TEAM_MEMBERS);
        this.maxTasks = positiveLimit(options.maxTasks, DEFAULT_MAX_TEAM_TASKS);
        this.maxMessages = positiveLimit(options.maxMessages, DEFAULT_MAX_TEAM_MESSAGES);
    }
    addMember(label, role, requestedId) {
        const cleanLabel = String(label || "member").trim() || "member";
        const cleanRole = role == null ? undefined : String(role).trim() || undefined;
        if (Buffer.byteLength(cleanLabel, "utf8") > 16_384 ||
            (cleanRole !== undefined && Buffer.byteLength(cleanRole, "utf8") > 16_384)) {
            throw new Error("Team member metadata exceeds its resource limit");
        }
        const id = requestedId?.trim() || `${this.id}:member:${++this.memberSeq}`;
        const existing = this.members.get(id);
        if (existing) {
            existing.label = cleanLabel;
            existing.role = cleanRole;
            return id;
        }
        if (this.members.size >= this.maxMembers)
            throw new Error(`Team ${this.name} reached its member limit`);
        if (!this.quotaSuppressed)
            this.quota?.reserveMembers(1);
        this.members.set(id, { id, label: cleanLabel, role: cleanRole, status: "registered", attemptGen: 0 });
        this.inboxes.set(id, []);
        return id;
    }
    /** Register a new attempt for a member; only this generation may mutate status. */
    beginAttempt(memberId) {
        const member = this.member(memberId);
        member.attemptGen += 1;
        member.status = "running";
        return member.attemptGen;
    }
    /** Mark running only if the caller is the current attempt generation. */
    markRunning(memberId, attemptGen) {
        const member = this.member(memberId);
        if (attemptGen !== undefined && attemptGen !== member.attemptGen)
            return false;
        member.status = "running";
        return true;
    }
    /** Mark done only if the caller is the current attempt generation. */
    markDone(memberId, attemptGen) {
        const member = this.member(memberId);
        if (attemptGen !== undefined && attemptGen !== member.attemptGen)
            return false;
        member.status = "done";
        return true;
    }
    /** Mark a member failed after retry exhaustion or a non-recoverable error. */
    markFailed(memberId, attemptGen) {
        const member = this.member(memberId);
        if (attemptGen !== undefined && member.attemptGen !== attemptGen)
            return false;
        member.status = "failed";
        return true;
    }
    /** Mark a member aborted (external abort / run stop). */
    markAborted(memberId, attemptGen) {
        const member = this.member(memberId);
        if (attemptGen !== undefined && member.attemptGen !== attemptGen)
            return false;
        member.status = "aborted";
        return true;
    }
    /**
     * Release a claimed task back to pending so another member can claim it
     * (TEAM-RETRY-002 — a claimant that fails/exhausts/aborts must not strand
     * the task forever). No-op unless the caller currently holds the claim.
     */
    releaseClaim(memberId, taskId) {
        const task = this.tasks.get(taskId);
        if (!task || task.assignee !== memberId || task.status === "completed")
            return false;
        task.assignee = undefined;
        task.status = "pending";
        return true;
    }
    /**
     * Release every non-completed task currently held by a member (failed
     * attempt / abort cleanup). Completed tasks stay completed (irreversible).
     */
    releaseClaims(memberId, attemptGen) {
        const member = this.member(memberId);
        if (attemptGen !== undefined && member.attemptGen !== attemptGen)
            return;
        for (const task of this.tasks.values()) {
            if (task.assignee === memberId && task.status !== "completed") {
                task.assignee = undefined;
                task.status = "pending";
            }
        }
    }
    /** Whether a member with this ID is already registered. */
    hasMember(memberId) {
        return this.members.has(memberId);
    }
    /**
     * Preflight a spawn batch WITHOUT mutating team state (TEAM-SPAWN-005):
     * validates input, duplicate IDs within the batch, and member capacity.
     * Returns planned entries; callers must check cross-team ownership of any
     * requestedId against their own registry, then {@link commitSpawn}.
     */
    planSpawn(specs) {
        const seen = new Set();
        let newCount = 0;
        const planned = [];
        for (let index = 0; index < specs.length; index++) {
            const spec = specs[index];
            if (!spec || typeof spec !== "object")
                throw new TypeError(`team.spawn member ${index} must be an object`);
            if (typeof spec.prompt !== "string" || !spec.prompt.trim()) {
                throw new TypeError(`team.spawn member ${index} requires a prompt`);
            }
            if (Buffer.byteLength(spec.prompt, "utf8") > 512 * 1024)
                throw new Error(`team.spawn member ${index} prompt is too large`);
            const label = String(spec.label ?? `member-${index + 1}`).trim() || `member-${index + 1}`;
            const role = spec.role == null ? undefined : String(spec.role).trim() || undefined;
            const requestedId = spec.memberId?.trim();
            if (requestedId) {
                if (seen.has(requestedId))
                    throw new Error(`Duplicate team member ID ${requestedId} within one spawn batch`);
                seen.add(requestedId);
            }
            const isNew = !requestedId || !this.members.has(requestedId);
            if (isNew)
                newCount++;
            planned.push({ memberId: requestedId ?? "", label, role, isNew });
        }
        if (this.members.size + newCount > this.maxMembers) {
            throw new Error(`Team ${this.name} reached its member limit`);
        }
        for (const entry of planned) {
            if (Buffer.byteLength(entry.label, "utf8") > 16_384 ||
                (entry.role && Buffer.byteLength(entry.role, "utf8") > 16_384))
                throw new Error("Team member metadata exceeds its resource limit");
        }
        if (newCount > 0) {
            // The plan owns the complete quota reservation until commit succeeds or
            // the caller explicitly rolls this plan back. Weak identity prevents a
            // concurrent spawn from releasing this batch's members.
            this.quota?.reserveMembers(newCount);
        }
        this.spawnReservations.set(planned, newCount);
        return planned;
    }
    /** Roll back a planned batch that never reached commit. */
    releaseSpawnReservation(planned) {
        const reserved = this.spawnReservations.get(planned);
        if (reserved === undefined)
            return;
        this.spawnReservations.delete(planned);
        this.quota?.releaseMembers?.(reserved);
    }
    /** Commit a previously planned spawn batch; no validation happens here. */
    commitSpawn(planned) {
        const reserved = this.spawnReservations.get(planned);
        if (reserved === undefined)
            throw new Error("Agent Team spawn plan is no longer reserved");
        this.spawnReservations.delete(planned);
        const rollback = {
            reserved,
            memberSeq: this.memberSeq,
            created: [],
            updated: [],
        };
        try {
            const memberIds = planned.map((entry) => {
                const memberId = entry.memberId || `${this.id}:member:${++this.memberSeq}`;
                const existing = this.members.get(memberId);
                if (existing) {
                    rollback.updated.push({ id: memberId, label: existing.label, role: existing.role });
                    existing.label = entry.label;
                    existing.role = entry.role;
                    return memberId;
                }
                this.members.set(memberId, {
                    id: memberId,
                    label: entry.label,
                    role: entry.role,
                    status: "registered",
                    attemptGen: 0,
                });
                this.inboxes.set(memberId, []);
                rollback.created.push(memberId);
                return memberId;
            });
            this.spawnCommits.set(planned, rollback);
            return memberIds;
        }
        catch (error) {
            this.restoreSpawnCommit(rollback);
            throw error;
        }
    }
    /** Roll back a committed batch when the scheduler rejects it synchronously. */
    rollbackCommittedSpawn(planned) {
        const rollback = this.spawnCommits.get(planned);
        if (!rollback)
            return [];
        this.spawnCommits.delete(planned);
        this.restoreSpawnCommit(rollback);
        return [...rollback.created];
    }
    /** The scheduler accepted the batch; membership and quota now belong to the team. */
    finalizeCommittedSpawn(planned) {
        this.spawnCommits.delete(planned);
    }
    restoreSpawnCommit(rollback) {
        for (const previous of rollback.updated) {
            const member = this.members.get(previous.id);
            if (member) {
                member.label = previous.label;
                member.role = previous.role;
            }
        }
        for (const id of rollback.created) {
            this.members.delete(id);
            this.inboxes.delete(id);
        }
        this.memberSeq = rollback.memberSeq;
        if (rollback.reserved > 0)
            this.quota?.releaseMembers?.(rollback.reserved);
    }
    memberPrompt(memberId) {
        const member = this.member(memberId);
        const role = member.role ? ` role=${member.role}` : "";
        return `[team:${this.name}] member=${member.label} id=${member.id}${role}. Complete the assigned task; use team tools for blockers, task-changing facts, and decisions.`;
    }
    addTask(title, description, assignee) {
        const cleanTitle = String(title ?? "").trim();
        if (!cleanTitle)
            throw new Error("Team task title must not be empty");
        if (this.tasks.size >= this.maxTasks)
            throw new Error(`Team ${this.name} reached its task limit`);
        const cleanDescription = description == null ? undefined : String(description);
        if (Buffer.byteLength(cleanTitle, "utf8") > 16_384 ||
            (cleanDescription !== undefined && Buffer.byteLength(cleanDescription, "utf8") > 64_000)) {
            throw new Error("Team task text exceeds its resource limit");
        }
        if (assignee)
            this.member(assignee);
        if (!this.quotaSuppressed)
            this.quota?.reserveTasks(1);
        const id = `${this.id}:task:${++this.taskSeq}`;
        this.tasks.set(id, {
            id,
            title: cleanTitle,
            description: cleanDescription,
            status: assignee ? "claimed" : "pending",
            assignee,
        });
        return id;
    }
    addTasks(tasks) {
        if (!Array.isArray(tasks))
            throw new TypeError("team.addTasks expects an array");
        // Preflight the complete batch so a late oversized task cannot leave an
        // earlier task committed.
        if (this.tasks.size + tasks.length > this.maxTasks)
            throw new Error(`Team ${this.name} reached its task limit`);
        this.quota?.reserveTasks(tasks.length);
        this.quotaSuppressed = true;
        try {
            for (const task of tasks) {
                const title = String(task?.title ?? "").trim();
                const description = task?.description == null ? undefined : String(task.description);
                if (!title)
                    throw new Error("Team task title must not be empty");
                if (Buffer.byteLength(title, "utf8") > 16_384 ||
                    (description !== undefined && Buffer.byteLength(description, "utf8") > 64_000)) {
                    throw new Error("Team task text exceeds its resource limit");
                }
                if (task?.assignee)
                    this.member(task.assignee);
            }
            return tasks.map((task) => this.addTask(task.title, task.description, task.assignee));
        }
        catch (error) {
            this.quota?.releaseTasks?.(tasks.length);
            throw error;
        }
        finally {
            this.quotaSuppressed = false;
        }
    }
    send(from, to, kind, message, attemptGen) {
        this.assertMemberAttempt(from, attemptGen);
        this.member(to);
        assertModelFacingMessageKind(kind);
        const text = String(message ?? "").trim();
        if (!text || text.length > 8_000)
            throw new Error("Team message is empty or exceeds 8000 characters");
        this.ensureMessageCapacity(to, text);
        if (!this.quotaSuppressed)
            this.quota?.reserveMessages(1);
        const entry = { id: `${this.id}:message:${++this.messageSeq}`, from, to, kind, message: text };
        this.inboxes.get(to)?.push(entry);
        this.messageCount++;
        return entry;
    }
    broadcast(from, kind, message, attemptGen) {
        this.assertMemberAttempt(from, attemptGen);
        assertModelFacingMessageKind(kind);
        const recipients = [...this.members.keys()].filter((id) => id !== from);
        this.ensureBroadcastCapacity(recipients, message);
        this.quota?.reserveMessages(recipients.length);
        let count = 0;
        this.quotaSuppressed = true;
        try {
            for (const memberId of recipients) {
                this.send(from, memberId, kind, message, attemptGen);
                count++;
            }
            return count;
        }
        finally {
            this.quotaSuppressed = false;
        }
    }
    sendFromWorkflow(to, message) {
        const text = String(message ?? "").trim();
        if (!text || Buffer.byteLength(text, "utf8") > 100_000)
            throw new Error("Team message is empty or too large");
        this.ensureMessageCapacity(to, text);
        if (!this.quotaSuppressed)
            this.quota?.reserveMessages(1);
        const entry = {
            id: `${this.id}:message:${++this.messageSeq}`,
            from: "workflow",
            to,
            kind: "workflow_instruction",
            message: text,
        };
        this.inboxes.get(to)?.push(entry);
        this.messageCount++;
        return entry;
    }
    broadcastFromWorkflow(message) {
        const text = String(message ?? "").trim();
        if (!text)
            throw new Error("Team message must not be empty");
        const recipients = [...this.members.keys()];
        this.ensureBroadcastCapacity(recipients, text);
        this.quota?.reserveMessages(recipients.length);
        let count = 0;
        this.quotaSuppressed = true;
        try {
            for (const memberId of recipients) {
                this.sendFromWorkflow(memberId, text);
                count++;
            }
            return count;
        }
        finally {
            this.quotaSuppressed = false;
        }
    }
    readInbox(memberId, attemptGen) {
        this.assertMemberAttempt(memberId, attemptGen);
        const inbox = this.inboxes.get(memberId) ?? [];
        this.inboxes.set(memberId, []);
        this.messageCount = Math.max(0, this.messageCount - inbox.length);
        this.quota?.releaseMessages?.(inbox.length);
        return inbox;
    }
    listMembers() {
        return [...this.members.values()].map(({ id, label, role, status }) => ({ id, label, role, status }));
    }
    listTasks() {
        return [...this.tasks.values()].map(({ id, title, description, status, assignee, result }) => ({
            id,
            title,
            description,
            status,
            assignee,
            result,
        }));
    }
    claimTask(memberId, taskId, attemptGen) {
        this.assertMemberAttempt(memberId, attemptGen);
        const task = this.task(taskId);
        if (task.status === "completed")
            throw new Error(`Task ${taskId} is already completed`);
        if (task.assignee && task.assignee !== memberId)
            throw new Error(`Task ${taskId} is assigned to ${task.assignee}`);
        task.assignee = memberId;
        task.status = "claimed";
        return { ...task };
    }
    completeTask(memberId, taskId, result, attemptGen) {
        this.assertMemberAttempt(memberId, attemptGen);
        const task = this.task(taskId);
        if (task.status === "completed")
            throw new Error(`Task ${taskId} is already completed`);
        if (task.assignee && task.assignee !== memberId)
            throw new Error(`Task ${taskId} is assigned to ${task.assignee}`);
        const cleanResult = result == null ? undefined : String(result);
        if (cleanResult !== undefined && Buffer.byteLength(cleanResult, "utf8") > 64_000) {
            throw new Error("Team task result exceeds its resource limit");
        }
        task.assignee = memberId;
        task.status = "completed";
        task.result = cleanResult;
        return { ...task };
    }
    snapshot() {
        let pendingMessages = 0;
        for (const inbox of this.inboxes.values())
            pendingMessages += inbox.length;
        return { id: this.id, name: this.name, members: this.listMembers(), tasks: this.listTasks(), pendingMessages };
    }
    /** Static tool schemas; dynamic team/member identity stays in closures. */
    createTools(memberId, attemptGen, isAdmitted) {
        this.assertMemberAttempt(memberId, attemptGen);
        const thisTeam = this;
        const assertAdmitted = () => {
            if (isAdmitted && !isAdmitted())
                throw new Error("workflow attempt is no longer admitted");
        };
        return [
            defineTool({
                name: "team_send_message",
                label: "Team Send",
                description: "Send a blocker, task-changing fact, or decision to one teammate.",
                parameters: Type.Object({
                    to: Type.String({ minLength: 1, description: "Teammate ID." }),
                    kind: Type.Union([Type.Literal("blocker"), Type.Literal("task_changing_fact"), Type.Literal("decision")], {
                        description: "Update type.",
                    }),
                    message: Type.String({
                        minLength: 1,
                        maxLength: 8_000,
                        description: "Concise update.",
                    }),
                }),
                async execute(_toolCallId, params) {
                    assertAdmitted();
                    const entry = thisTeam.send(memberId, params.to, params.kind, params.message, attemptGen);
                    return toolResult(`Message sent to ${entry.to}.`, entry);
                },
            }),
            defineTool({
                name: "team_inbox",
                label: "Team Inbox",
                description: "Read and consume the team inbox.",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                    assertAdmitted();
                    const messages = thisTeam.readInbox(memberId, attemptGen);
                    return toolResult(serializeBounded(messages, { maxBytes: 16_000, pretty: false }), { messages });
                },
            }),
            defineTool({
                name: "team_members",
                label: "Team Members",
                description: "List team members and status.",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                    assertAdmitted();
                    thisTeam.assertMemberAttempt(memberId, attemptGen);
                    const members = thisTeam.listMembers();
                    return toolResult(serializeBounded(members, { maxBytes: 16_000, pretty: false }), { members });
                },
            }),
            defineTool({
                name: "team_tasks",
                label: "Team Tasks",
                description: "List shared team tasks.",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                    assertAdmitted();
                    thisTeam.assertMemberAttempt(memberId, attemptGen);
                    const tasks = thisTeam.listTasks();
                    return toolResult(serializeBounded(tasks, { maxBytes: 16_000, pretty: false }), { tasks });
                },
            }),
            defineTool({
                name: "team_add_task",
                label: "Team Add Task",
                description: "Add a shared team task.",
                parameters: Type.Object({
                    title: Type.String({ minLength: 1, description: "Task title." }),
                    description: Type.Optional(Type.String({ description: "Task details." })),
                }),
                async execute(_toolCallId, params) {
                    assertAdmitted();
                    thisTeam.assertMemberAttempt(memberId, attemptGen);
                    const taskId = thisTeam.addTask(params.title, params.description);
                    return toolResult(`Created team task ${taskId}.`, { taskId });
                },
            }),
            defineTool({
                name: "team_claim_task",
                label: "Team Claim Task",
                description: "Claim a shared task.",
                parameters: Type.Object({ taskId: Type.String({ minLength: 1, description: "Task ID." }) }),
                async execute(_toolCallId, params) {
                    assertAdmitted();
                    const task = thisTeam.claimTask(memberId, params.taskId, attemptGen);
                    return toolResult(`Claimed team task ${task.id}.`, task);
                },
            }),
            defineTool({
                name: "team_complete_task",
                label: "Team Complete Task",
                description: "Complete a shared task with a result.",
                parameters: Type.Object({
                    taskId: Type.String({ minLength: 1, description: "Task ID." }),
                    result: Type.Optional(Type.String({ description: "Completion summary." })),
                }),
                async execute(_toolCallId, params) {
                    assertAdmitted();
                    const task = thisTeam.completeTask(memberId, params.taskId, params.result, attemptGen);
                    return toolResult(`Completed team task ${task.id}.`, task);
                },
            }),
        ];
        // The tools above intentionally close over the exact team/member. This
        // binding is assigned once per createTools() call and never appears in the
        // provider-visible schema.
        function toolResult(text, details) {
            return { content: [{ type: "text", text }], details };
        }
    }
    assertMemberAttempt(memberId, attemptGen, requireRunning = true) {
        const member = this.member(memberId);
        // Agent-bound tool surfaces always pass a generation. Public workflow-side
        // methods may omit it deliberately; supplied generations are strict and,
        // for tool operations, require the member to remain live/running.
        if (attemptGen !== undefined &&
            (member.attemptGen !== attemptGen || (requireRunning && member.status !== "running"))) {
            throw new Error(`Team member ${memberId} attempt is no longer current`);
        }
        return member;
    }
    ensureMessageCapacity(to, text) {
        const inbox = this.inboxes.get(to);
        const bytes = inbox?.reduce((total, item) => total + Buffer.byteLength(item.message, "utf8"), 0) ?? 0;
        if (!inbox ||
            inbox.length >= 256 ||
            bytes + Buffer.byteLength(text, "utf8") > 1_000_000 ||
            this.messageCount >= this.maxMessages) {
            throw new Error(`Team inbox for ${to} is full`);
        }
    }
    ensureBroadcastCapacity(recipients, message) {
        const text = String(message ?? "").trim();
        for (const recipient of recipients)
            this.ensureMessageCapacity(recipient, text);
        if (this.messageCount + recipients.length > this.maxMessages)
            throw new Error(`Team ${this.name} reached its message limit`);
    }
    member(id) {
        const member = this.members.get(id);
        if (!member)
            throw new Error(`Unknown team member ${id}`);
        return member;
    }
    task(id) {
        const task = this.tasks.get(id);
        if (!task)
            throw new Error(`Unknown team task ${id}`);
        return task;
    }
}
function assertModelFacingMessageKind(value) {
    if (typeof value !== "string" || !MODEL_FACING_MESSAGE_KINDS.has(value)) {
        throw new Error("Team message requires kind: blocker, task_changing_fact, or decision");
    }
}
function positiveLimit(value, fallback) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
