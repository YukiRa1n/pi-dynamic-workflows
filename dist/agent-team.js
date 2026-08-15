import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
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
    maxMembers;
    members = new Map();
    inboxes = new Map();
    tasks = new Map();
    memberSeq = 0;
    messageSeq = 0;
    taskSeq = 0;
    constructor(id, name, maxMembers = 100) {
        this.id = id;
        this.name = name;
        this.maxMembers = maxMembers;
    }
    addMember(label, role, requestedId) {
        const cleanLabel = String(label || "member").trim() || "member";
        const cleanRole = role == null ? undefined : String(role).trim() || undefined;
        const id = requestedId?.trim() || `${this.id}:member:${++this.memberSeq}`;
        const existing = this.members.get(id);
        if (existing) {
            existing.label = cleanLabel;
            existing.role = cleanRole;
            return id;
        }
        if (this.members.size >= this.maxMembers)
            throw new Error(`Team ${this.name} reached its member limit`);
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
        const member = this.assertMemberAttempt(memberId, attemptGen, false);
        member.status = "failed";
        return true;
    }
    /** Mark a member aborted (external abort / run stop). */
    markAborted(memberId, attemptGen) {
        const member = this.assertMemberAttempt(memberId, attemptGen, false);
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
        this.assertMemberAttempt(memberId, attemptGen, false);
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
        return planned;
    }
    /** Commit a previously planned spawn batch; no validation happens here. */
    commitSpawn(planned) {
        return planned.map((entry) => {
            const memberId = entry.memberId || `${this.id}:member:${++this.memberSeq}`;
            const existing = this.members.get(memberId);
            if (existing) {
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
            return memberId;
        });
    }
    memberPrompt(memberId) {
        const member = this.member(memberId);
        const role = member.role ? ` Role: ${member.role}.` : "";
        return `[Agent team: ${this.name}] You are team member "${member.label}" (${member.id}).${role} Use the team tools for peer messages and shared tasks; report your own result normally when finished.`;
    }
    addTask(title, description, assignee) {
        const cleanTitle = String(title ?? "").trim();
        if (!cleanTitle)
            throw new Error("Team task title must not be empty");
        if (assignee)
            this.member(assignee);
        const id = `${this.id}:task:${++this.taskSeq}`;
        this.tasks.set(id, {
            id,
            title: cleanTitle,
            description: description == null ? undefined : String(description),
            status: assignee ? "claimed" : "pending",
            assignee,
        });
        return id;
    }
    addTasks(tasks) {
        if (!Array.isArray(tasks))
            throw new TypeError("team.addTasks expects an array");
        return tasks.map((task) => this.addTask(task.title, task.description, task.assignee));
    }
    send(from, to, message, attemptGen) {
        this.assertMemberAttempt(from, attemptGen);
        this.member(to);
        const text = String(message ?? "").trim();
        if (!text || text.length > 100_000)
            throw new Error("Team message must be 1..100000 characters");
        const inbox = this.inboxes.get(to);
        if (!inbox || inbox.length >= 256 || inbox.reduce((total, item) => total + item.message.length, 0) + text.length > 1_000_000) {
            throw new Error(`Team inbox for ${to} is full`);
        }
        const entry = { id: `${this.id}:message:${++this.messageSeq}`, from, to, message: text };
        inbox.push(entry);
        return entry;
    }
    broadcast(from, message, attemptGen) {
        this.assertMemberAttempt(from, attemptGen);
        let count = 0;
        for (const member of this.members.values()) {
            if (member.id === from)
                continue;
            this.send(from, member.id, message, attemptGen);
            count++;
        }
        return count;
    }
    sendFromWorkflow(to, message) {
        const text = String(message ?? "").trim();
        if (!text || text.length > 100_000)
            throw new Error("Team message must be 1..100000 characters");
        this.member(to);
        const inbox = this.inboxes.get(to);
        if (!inbox || inbox.length >= 256 || inbox.reduce((total, item) => total + item.message.length, 0) + text.length > 1_000_000) {
            throw new Error(`Team inbox for ${to} is full`);
        }
        const entry = { id: `${this.id}:message:${++this.messageSeq}`, from: "workflow", to, message: text };
        inbox.push(entry);
        return entry;
    }
    broadcastFromWorkflow(message) {
        const text = String(message ?? "").trim();
        if (!text)
            throw new Error("Team message must not be empty");
        let count = 0;
        for (const member of this.members.values()) {
            this.sendFromWorkflow(member.id, text);
            count++;
        }
        return count;
    }
    readInbox(memberId, attemptGen) {
        this.assertMemberAttempt(memberId, attemptGen);
        const inbox = this.inboxes.get(memberId) ?? [];
        this.inboxes.set(memberId, []);
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
        task.assignee = memberId;
        task.status = "completed";
        task.result = result == null ? undefined : String(result);
        return { ...task };
    }
    snapshot() {
        let pendingMessages = 0;
        for (const inbox of this.inboxes.values())
            pendingMessages += inbox.length;
        return { id: this.id, name: this.name, members: this.listMembers(), tasks: this.listTasks(), pendingMessages };
    }
    /** Static tool schemas; dynamic team/member identity stays in closures. */
    createTools(memberId, attemptGen) {
        this.assertMemberAttempt(memberId, attemptGen);
        const thisTeam = this;
        return [
            defineTool({
                name: "team_send_message",
                label: "Team Send",
                description: "Send a message to one peer in the current agent team.",
                parameters: Type.Object({
                    to: Type.String({ minLength: 1, description: "Target team member ID." }),
                    message: Type.String({ minLength: 1, description: "Message for the target peer." }),
                }),
                async execute(_toolCallId, params) {
                    const entry = thisTeam.send(memberId, params.to, params.message, attemptGen);
                    return toolResult(`Message sent to ${entry.to}.`, entry);
                },
            }),
            defineTool({
                name: "team_broadcast",
                label: "Team Broadcast",
                description: "Broadcast a message to every other member of the current agent team.",
                parameters: Type.Object({ message: Type.String({ minLength: 1, description: "Message for peers." }) }),
                async execute(_toolCallId, params) {
                    const count = thisTeam.broadcast(memberId, params.message, attemptGen);
                    return toolResult(`Message broadcast to ${count} peer(s).`, { count });
                },
            }),
            defineTool({
                name: "team_inbox",
                label: "Team Inbox",
                description: "Read and consume messages currently waiting in your team inbox.",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                    const messages = thisTeam.readInbox(memberId, attemptGen);
                    return toolResult(JSON.stringify(messages), { messages });
                },
            }),
            defineTool({
                name: "team_members",
                label: "Team Members",
                description: "List members and their current status in the current agent team.",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                    thisTeam.assertMemberAttempt(memberId, attemptGen);
                    const members = thisTeam.listMembers();
                    return toolResult(JSON.stringify(members), { members });
                },
            }),
            defineTool({
                name: "team_tasks",
                label: "Team Tasks",
                description: "List shared tasks in the current agent team.",
                parameters: Type.Object({}, { additionalProperties: false }),
                async execute() {
                    thisTeam.assertMemberAttempt(memberId, attemptGen);
                    const tasks = thisTeam.listTasks();
                    return toolResult(JSON.stringify(tasks), { tasks });
                },
            }),
            defineTool({
                name: "team_add_task",
                label: "Team Add Task",
                description: "Add a task to the shared team task list.",
                parameters: Type.Object({
                    title: Type.String({ minLength: 1, description: "Short task title." }),
                    description: Type.Optional(Type.String({ description: "Task details." })),
                }),
                async execute(_toolCallId, params) {
                    thisTeam.assertMemberAttempt(memberId, attemptGen);
                    const taskId = thisTeam.addTask(params.title, params.description);
                    return toolResult(`Created team task ${taskId}.`, { taskId });
                },
            }),
            defineTool({
                name: "team_claim_task",
                label: "Team Claim Task",
                description: "Claim an unassigned shared team task.",
                parameters: Type.Object({ taskId: Type.String({ minLength: 1, description: "Shared task ID." }) }),
                async execute(_toolCallId, params) {
                    const task = thisTeam.claimTask(memberId, params.taskId, attemptGen);
                    return toolResult(`Claimed team task ${task.id}.`, task);
                },
            }),
            defineTool({
                name: "team_complete_task",
                label: "Team Complete Task",
                description: "Mark a shared team task complete and attach a result summary.",
                parameters: Type.Object({
                    taskId: Type.String({ minLength: 1, description: "Shared task ID." }),
                    result: Type.Optional(Type.String({ description: "Completion summary." })),
                }),
                async execute(_toolCallId, params) {
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
        if (attemptGen !== undefined && (member.attemptGen !== attemptGen || (requireRunning && member.status !== "running"))) {
            throw new Error(`Team member ${memberId} attempt is no longer current`);
        }
        return member;
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
