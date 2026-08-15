import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

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

interface Member {
  id: string;
  label: string;
  role?: string;
  status: AgentTeamMemberStatus;
  /** Current logical attempt generation; only that generation may mark the
   *  member running/done (TEAM-STATUS-003 — a late older attempt's cleanup
   *  must not mark a newer retry done). */
  attemptGen: number;
}

interface Task {
  id: string;
  title: string;
  description?: string;
  status: AgentTeamTaskStatus;
  assignee?: string;
  result?: string;
}

/**
 * In-process coordination state for one workflow agent team.
 *
 * The team is deliberately a workflow-scoped object: it coordinates peer
 * subagents during one run, but it does not create a second scheduler or a
 * second token/concurrency budget. Agent() remains the lifecycle primitive and
 * the workflow runtime remains the authoritative controller.
 */
export class WorkflowAgentTeam {
  private readonly members = new Map<string, Member>();
  private readonly inboxes = new Map<string, AgentTeamMessage[]>();
  private readonly tasks = new Map<string, Task>();
  private memberSeq = 0;
  private messageSeq = 0;
  private taskSeq = 0;

  constructor(
    public readonly id: string,
    public readonly name: string,
    private readonly maxMembers = 100,
  ) {}

  addMember(label: string, role?: string, requestedId?: string): string {
    const cleanLabel = String(label || "member").trim() || "member";
    const cleanRole = role == null ? undefined : String(role).trim() || undefined;
    const id = requestedId?.trim() || `${this.id}:member:${++this.memberSeq}`;
    const existing = this.members.get(id);
    if (existing) {
      existing.label = cleanLabel;
      existing.role = cleanRole;
      return id;
    }
    if (this.members.size >= this.maxMembers) throw new Error(`Team ${this.name} reached its member limit`);
    this.members.set(id, { id, label: cleanLabel, role: cleanRole, status: "registered", attemptGen: 0 });
    this.inboxes.set(id, []);
    return id;
  }

  /** Register a new attempt for a member; only this generation may mutate status. */
  beginAttempt(memberId: string): number {
    const member = this.member(memberId);
    member.attemptGen += 1;
    member.status = "running";
    return member.attemptGen;
  }

  /** Mark running only if the caller is the current attempt generation. */
  markRunning(memberId: string, attemptGen?: number): boolean {
    const member = this.member(memberId);
    if (attemptGen !== undefined && attemptGen !== member.attemptGen) return false;
    member.status = "running";
    return true;
  }

  /** Mark done only if the caller is the current attempt generation. */
  markDone(memberId: string, attemptGen?: number): boolean {
    const member = this.member(memberId);
    if (attemptGen !== undefined && attemptGen !== member.attemptGen) return false;
    member.status = "done";
    return true;
  }

  /** Mark a member failed after retry exhaustion or a non-recoverable error. */
  markFailed(memberId: string, attemptGen?: number): boolean {
    const member = this.assertMemberAttempt(memberId, attemptGen, false);
    member.status = "failed";
    return true;
  }

  /** Mark a member aborted (external abort / run stop). */
  markAborted(memberId: string, attemptGen?: number): boolean {
    const member = this.assertMemberAttempt(memberId, attemptGen, false);
    member.status = "aborted";
    return true;
  }

  /**
   * Release a claimed task back to pending so another member can claim it
   * (TEAM-RETRY-002 — a claimant that fails/exhausts/aborts must not strand
   * the task forever). No-op unless the caller currently holds the claim.
   */
  releaseClaim(memberId: string, taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (!task || task.assignee !== memberId || task.status === "completed") return false;
    task.assignee = undefined;
    task.status = "pending";
    return true;
  }

  /**
   * Release every non-completed task currently held by a member (failed
   * attempt / abort cleanup). Completed tasks stay completed (irreversible).
   */
  releaseClaims(memberId: string, attemptGen?: number): void {
    this.assertMemberAttempt(memberId, attemptGen, false);
    for (const task of this.tasks.values()) {
      if (task.assignee === memberId && task.status !== "completed") {
        task.assignee = undefined;
        task.status = "pending";
      }
    }
  }

  /** Whether a member with this ID is already registered. */
  hasMember(memberId: string): boolean {
    return this.members.has(memberId);
  }

  /**
   * Preflight a spawn batch WITHOUT mutating team state (TEAM-SPAWN-005):
   * validates input, duplicate IDs within the batch, and member capacity.
   * Returns planned entries; callers must check cross-team ownership of any
   * requestedId against their own registry, then {@link commitSpawn}.
   */
  planSpawn(specs: AgentTeamSpawnSpec[]): Array<{ memberId: string; label: string; role?: string; isNew: boolean }> {
    const seen = new Set<string>();
    let newCount = 0;
    const planned: Array<{ memberId: string; label: string; role?: string; isNew: boolean }> = [];
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      if (!spec || typeof spec !== "object") throw new TypeError(`team.spawn member ${index} must be an object`);
      if (typeof spec.prompt !== "string" || !spec.prompt.trim()) {
        throw new TypeError(`team.spawn member ${index} requires a prompt`);
      }
      const label = String(spec.label ?? `member-${index + 1}`).trim() || `member-${index + 1}`;
      const role = spec.role == null ? undefined : String(spec.role).trim() || undefined;
      const requestedId = spec.memberId?.trim();
      if (requestedId) {
        if (seen.has(requestedId)) throw new Error(`Duplicate team member ID ${requestedId} within one spawn batch`);
        seen.add(requestedId);
      }
      const isNew = !requestedId || !this.members.has(requestedId);
      if (isNew) newCount++;
      planned.push({ memberId: requestedId ?? "", label, role, isNew });
    }
    if (this.members.size + newCount > this.maxMembers) {
      throw new Error(`Team ${this.name} reached its member limit`);
    }
    return planned;
  }

  /** Commit a previously planned spawn batch; no validation happens here. */
  commitSpawn(planned: Array<{ memberId: string; label: string; role?: string; isNew: boolean }>): string[] {
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

  memberPrompt(memberId: string): string {
    const member = this.member(memberId);
    const role = member.role ? ` Role: ${member.role}.` : "";
    return `[Agent team: ${this.name}] You are team member "${member.label}" (${member.id}).${role} Use the team tools for peer messages and shared tasks; report your own result normally when finished.`;
  }

  addTask(title: string, description?: string, assignee?: string): string {
    const cleanTitle = String(title ?? "").trim();
    if (!cleanTitle) throw new Error("Team task title must not be empty");
    if (assignee) this.member(assignee);
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

  addTasks(tasks: Array<{ title: string; description?: string; assignee?: string }>): string[] {
    if (!Array.isArray(tasks)) throw new TypeError("team.addTasks expects an array");
    return tasks.map((task) => this.addTask(task.title, task.description, task.assignee));
  }

  send(from: string, to: string, message: string, attemptGen?: number): AgentTeamMessage {
    this.assertMemberAttempt(from, attemptGen);
    this.member(to);
    const text = String(message ?? "").trim();
    if (!text || text.length > 100_000) throw new Error("Team message must be 1..100000 characters");
    const inbox = this.inboxes.get(to);
    if (!inbox || inbox.length >= 256 || inbox.reduce((total, item) => total + item.message.length, 0) + text.length > 1_000_000) {
      throw new Error(`Team inbox for ${to} is full`);
    }
    const entry = { id: `${this.id}:message:${++this.messageSeq}`, from, to, message: text };
    inbox.push(entry);
    return entry;
  }

  broadcast(from: string, message: string, attemptGen?: number): number {
    this.assertMemberAttempt(from, attemptGen);
    let count = 0;
    for (const member of this.members.values()) {
      if (member.id === from) continue;
      this.send(from, member.id, message, attemptGen);
      count++;
    }
    return count;
  }

  sendFromWorkflow(to: string, message: string): AgentTeamMessage {
    const text = String(message ?? "").trim();
    if (!text || text.length > 100_000) throw new Error("Team message must be 1..100000 characters");
    this.member(to);
    const inbox = this.inboxes.get(to);
    if (!inbox || inbox.length >= 256 || inbox.reduce((total, item) => total + item.message.length, 0) + text.length > 1_000_000) {
      throw new Error(`Team inbox for ${to} is full`);
    }
    const entry = { id: `${this.id}:message:${++this.messageSeq}`, from: "workflow", to, message: text };
    inbox.push(entry);
    return entry;
  }

  broadcastFromWorkflow(message: string): number {
    const text = String(message ?? "").trim();
    if (!text) throw new Error("Team message must not be empty");
    let count = 0;
    for (const member of this.members.values()) {
      this.sendFromWorkflow(member.id, text);
      count++;
    }
    return count;
  }

  readInbox(memberId: string, attemptGen?: number): AgentTeamMessage[] {
    this.assertMemberAttempt(memberId, attemptGen);
    const inbox = this.inboxes.get(memberId) ?? [];
    this.inboxes.set(memberId, []);
    return inbox;
  }

  listMembers(): AgentTeamMemberSnapshot[] {
    return [...this.members.values()].map(({ id, label, role, status }) => ({ id, label, role, status }));
  }

  listTasks(): AgentTeamTaskSnapshot[] {
    return [...this.tasks.values()].map(({ id, title, description, status, assignee, result }) => ({
      id,
      title,
      description,
      status,
      assignee,
      result,
    }));
  }

  claimTask(memberId: string, taskId: string, attemptGen?: number): AgentTeamTaskSnapshot {
    this.assertMemberAttempt(memberId, attemptGen);
    const task = this.task(taskId);
    if (task.status === "completed") throw new Error(`Task ${taskId} is already completed`);
    if (task.assignee && task.assignee !== memberId) throw new Error(`Task ${taskId} is assigned to ${task.assignee}`);
    task.assignee = memberId;
    task.status = "claimed";
    return { ...task };
  }

  completeTask(memberId: string, taskId: string, result?: string, attemptGen?: number): AgentTeamTaskSnapshot {
    this.assertMemberAttempt(memberId, attemptGen);
    const task = this.task(taskId);
    if (task.status === "completed") throw new Error(`Task ${taskId} is already completed`);
    if (task.assignee && task.assignee !== memberId) throw new Error(`Task ${taskId} is assigned to ${task.assignee}`);
    task.assignee = memberId;
    task.status = "completed";
    task.result = result == null ? undefined : String(result);
    return { ...task };
  }

  snapshot(): AgentTeamSnapshot {
    let pendingMessages = 0;
    for (const inbox of this.inboxes.values()) pendingMessages += inbox.length;
    return { id: this.id, name: this.name, members: this.listMembers(), tasks: this.listTasks(), pendingMessages };
  }

  /** Static tool schemas; dynamic team/member identity stays in closures. */
  createTools(memberId: string, attemptGen?: number): ToolDefinition[] {
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
    function toolResult(text: string, details: unknown) {
      return { content: [{ type: "text" as const, text }], details };
    }
  }

  private assertMemberAttempt(memberId: string, attemptGen?: number, requireRunning = true): Member {
    const member = this.member(memberId);
    // Agent-bound tool surfaces always pass a generation. Public workflow-side
    // methods may omit it deliberately; supplied generations are strict and,
    // for tool operations, require the member to remain live/running.
    if (attemptGen !== undefined && (member.attemptGen !== attemptGen || (requireRunning && member.status !== "running"))) {
      throw new Error(`Team member ${memberId} attempt is no longer current`);
    }
    return member;
  }

  private member(id: string): Member {
    const member = this.members.get(id);
    if (!member) throw new Error(`Unknown team member ${id}`);
    return member;
  }

  private task(id: string): Task {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown team task ${id}`);
    return task;
  }
}
