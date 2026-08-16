import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEFAULT_MAX_TEAM_MEMBERS, DEFAULT_MAX_TEAM_MESSAGES, DEFAULT_MAX_TEAM_TASKS } from "./config.js";
import { serializeBounded } from "./safe-serialize.js";

export type AgentTeamMemberStatus = "registered" | "running" | "done" | "failed" | "aborted";
export type AgentTeamTaskStatus = "pending" | "claimed" | "completed";

/** Classification retained on every team message, including workflow-side instructions. */
export type AgentTeamMessageKind = "blocker" | "task_changing_fact" | "decision" | "workflow_instruction";
type ModelFacingAgentTeamMessageKind = Exclude<AgentTeamMessageKind, "workflow_instruction">;

const MODEL_FACING_MESSAGE_KINDS: ReadonlySet<string> = new Set(["blocker", "task_changing_fact", "decision"]);

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
  kind: AgentTeamMessageKind;
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

interface SpawnPlanEntry {
  memberId: string;
  label: string;
  role?: string;
  isNew: boolean;
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

interface SpawnCommitRollback {
  reserved: number;
  memberSeq: number;
  created: string[];
  updated: Array<{ id: string; label: string; role?: string }>;
}

export interface AgentTeamQuota {
  reserveMembers(count: number): void;
  reserveTasks(count: number): void;
  reserveMessages(count: number): void;
  releaseMembers?(count: number): void;
  releaseTasks?(count: number): void;
  releaseMessages?(count: number): void;
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
  private messageCount = 0;
  private readonly maxMembers: number;
  private readonly maxTasks: number;
  private readonly maxMessages: number;
  private readonly quota?: AgentTeamQuota;
  private quotaSuppressed = false;
  private readonly spawnReservations = new WeakMap<object, number>();
  private readonly spawnCommits = new WeakMap<object, SpawnCommitRollback>();

  constructor(
    public readonly id: string,
    public readonly name: string,
    maxMembers = DEFAULT_MAX_TEAM_MEMBERS,
    options: { maxTasks?: number; maxMessages?: number; quota?: AgentTeamQuota } = {},
  ) {
    this.quota = options.quota;
    this.maxMembers = positiveLimit(maxMembers, DEFAULT_MAX_TEAM_MEMBERS);
    this.maxTasks = positiveLimit(options.maxTasks, DEFAULT_MAX_TEAM_TASKS);
    this.maxMessages = positiveLimit(options.maxMessages, DEFAULT_MAX_TEAM_MESSAGES);
  }

  addMember(label: string, role?: string, requestedId?: string): string {
    const cleanLabel = String(label || "member").trim() || "member";
    const cleanRole = role == null ? undefined : String(role).trim() || undefined;
    if (
      Buffer.byteLength(cleanLabel, "utf8") > 16_384 ||
      (cleanRole !== undefined && Buffer.byteLength(cleanRole, "utf8") > 16_384)
    ) {
      throw new Error("Team member metadata exceeds its resource limit");
    }
    const id = requestedId?.trim() || `${this.id}:member:${++this.memberSeq}`;
    const existing = this.members.get(id);
    if (existing) {
      existing.label = cleanLabel;
      existing.role = cleanRole;
      return id;
    }
    if (this.members.size >= this.maxMembers) throw new Error(`Team ${this.name} reached its member limit`);
    if (!this.quotaSuppressed) this.quota?.reserveMembers(1);
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
    const member = this.member(memberId);
    if (attemptGen !== undefined && member.attemptGen !== attemptGen) return false;
    member.status = "failed";
    return true;
  }

  /** Mark a member aborted (external abort / run stop). */
  markAborted(memberId: string, attemptGen?: number): boolean {
    const member = this.member(memberId);
    if (attemptGen !== undefined && member.attemptGen !== attemptGen) return false;
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
    const member = this.member(memberId);
    if (attemptGen !== undefined && member.attemptGen !== attemptGen) return;
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
  planSpawn(specs: AgentTeamSpawnSpec[]): SpawnPlanEntry[] {
    const seen = new Set<string>();
    let newCount = 0;
    const planned: Array<{ memberId: string; label: string; role?: string; isNew: boolean }> = [];
    for (let index = 0; index < specs.length; index++) {
      const spec = specs[index];
      if (!spec || typeof spec !== "object") throw new TypeError(`team.spawn member ${index} must be an object`);
      if (typeof spec.prompt !== "string" || !spec.prompt.trim()) {
        throw new TypeError(`team.spawn member ${index} requires a prompt`);
      }
      if (Buffer.byteLength(spec.prompt, "utf8") > 512 * 1024)
        throw new Error(`team.spawn member ${index} prompt is too large`);
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
    for (const entry of planned) {
      if (
        Buffer.byteLength(entry.label, "utf8") > 16_384 ||
        (entry.role && Buffer.byteLength(entry.role, "utf8") > 16_384)
      )
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
  releaseSpawnReservation(planned: SpawnPlanEntry[]): void {
    const reserved = this.spawnReservations.get(planned);
    if (reserved === undefined) return;
    this.spawnReservations.delete(planned);
    this.quota?.releaseMembers?.(reserved);
  }

  /** Commit a previously planned spawn batch; no validation happens here. */
  commitSpawn(planned: SpawnPlanEntry[]): string[] {
    const reserved = this.spawnReservations.get(planned);
    if (reserved === undefined) throw new Error("Agent Team spawn plan is no longer reserved");
    this.spawnReservations.delete(planned);
    const rollback: SpawnCommitRollback = {
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
    } catch (error) {
      this.restoreSpawnCommit(rollback);
      throw error;
    }
  }

  /** Roll back a committed batch when the scheduler rejects it synchronously. */
  rollbackCommittedSpawn(planned: SpawnPlanEntry[]): string[] {
    const rollback = this.spawnCommits.get(planned);
    if (!rollback) return [];
    this.spawnCommits.delete(planned);
    this.restoreSpawnCommit(rollback);
    return [...rollback.created];
  }

  /** The scheduler accepted the batch; membership and quota now belong to the team. */
  finalizeCommittedSpawn(planned: SpawnPlanEntry[]): void {
    this.spawnCommits.delete(planned);
  }

  private restoreSpawnCommit(rollback: SpawnCommitRollback): void {
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
    if (rollback.reserved > 0) this.quota?.releaseMembers?.(rollback.reserved);
  }

  memberPrompt(memberId: string): string {
    const member = this.member(memberId);
    const role = member.role ? ` role=${member.role}` : "";
    return `[team:${this.name}] member=${member.label} id=${member.id}${role}. Complete the assigned task; use team tools for blockers, task-changing facts, and decisions.`;
  }

  addTask(title: string, description?: string, assignee?: string): string {
    const cleanTitle = String(title ?? "").trim();
    if (!cleanTitle) throw new Error("Team task title must not be empty");
    if (this.tasks.size >= this.maxTasks) throw new Error(`Team ${this.name} reached its task limit`);
    const cleanDescription = description == null ? undefined : String(description);
    if (
      Buffer.byteLength(cleanTitle, "utf8") > 16_384 ||
      (cleanDescription !== undefined && Buffer.byteLength(cleanDescription, "utf8") > 64_000)
    ) {
      throw new Error("Team task text exceeds its resource limit");
    }
    if (assignee) this.member(assignee);
    if (!this.quotaSuppressed) this.quota?.reserveTasks(1);
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

  addTasks(tasks: Array<{ title: string; description?: string; assignee?: string }>): string[] {
    if (!Array.isArray(tasks)) throw new TypeError("team.addTasks expects an array");
    // Preflight the complete batch so a late oversized task cannot leave an
    // earlier task committed.
    if (this.tasks.size + tasks.length > this.maxTasks) throw new Error(`Team ${this.name} reached its task limit`);
    this.quota?.reserveTasks(tasks.length);
    this.quotaSuppressed = true;
    try {
      for (const task of tasks) {
        const title = String(task?.title ?? "").trim();
        const description = task?.description == null ? undefined : String(task.description);
        if (!title) throw new Error("Team task title must not be empty");
        if (
          Buffer.byteLength(title, "utf8") > 16_384 ||
          (description !== undefined && Buffer.byteLength(description, "utf8") > 64_000)
        ) {
          throw new Error("Team task text exceeds its resource limit");
        }
        if (task?.assignee) this.member(task.assignee);
      }
      return tasks.map((task) => this.addTask(task.title, task.description, task.assignee));
    } catch (error) {
      this.quota?.releaseTasks?.(tasks.length);
      throw error;
    } finally {
      this.quotaSuppressed = false;
    }
  }

  send(
    from: string,
    to: string,
    kind: ModelFacingAgentTeamMessageKind,
    message: string,
    attemptGen?: number,
  ): AgentTeamMessage {
    this.assertMemberAttempt(from, attemptGen);
    this.member(to);
    assertModelFacingMessageKind(kind);
    const text = String(message ?? "").trim();
    if (!text || text.length > 8_000) throw new Error("Team message is empty or exceeds 8000 characters");
    this.ensureMessageCapacity(to, text);
    if (!this.quotaSuppressed) this.quota?.reserveMessages(1);
    const entry = { id: `${this.id}:message:${++this.messageSeq}`, from, to, kind, message: text };
    this.inboxes.get(to)?.push(entry);
    this.messageCount++;
    return entry;
  }

  broadcast(from: string, kind: ModelFacingAgentTeamMessageKind, message: string, attemptGen?: number): number {
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
    } finally {
      this.quotaSuppressed = false;
    }
  }

  sendFromWorkflow(to: string, message: string): AgentTeamMessage {
    const text = String(message ?? "").trim();
    if (!text || Buffer.byteLength(text, "utf8") > 100_000) throw new Error("Team message is empty or too large");
    this.ensureMessageCapacity(to, text);
    if (!this.quotaSuppressed) this.quota?.reserveMessages(1);
    const entry = {
      id: `${this.id}:message:${++this.messageSeq}`,
      from: "workflow",
      to,
      kind: "workflow_instruction" as const,
      message: text,
    };
    this.inboxes.get(to)?.push(entry);
    this.messageCount++;
    return entry;
  }

  broadcastFromWorkflow(message: string): number {
    const text = String(message ?? "").trim();
    if (!text) throw new Error("Team message must not be empty");
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
    } finally {
      this.quotaSuppressed = false;
    }
  }

  readInbox(memberId: string, attemptGen?: number): AgentTeamMessage[] {
    this.assertMemberAttempt(memberId, attemptGen);
    const inbox = this.inboxes.get(memberId) ?? [];
    this.inboxes.set(memberId, []);
    this.messageCount = Math.max(0, this.messageCount - inbox.length);
    this.quota?.releaseMessages?.(inbox.length);
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
    const cleanResult = result == null ? undefined : String(result);
    if (cleanResult !== undefined && Buffer.byteLength(cleanResult, "utf8") > 64_000) {
      throw new Error("Team task result exceeds its resource limit");
    }
    task.assignee = memberId;
    task.status = "completed";
    task.result = cleanResult;
    return { ...task };
  }

  snapshot(): AgentTeamSnapshot {
    let pendingMessages = 0;
    for (const inbox of this.inboxes.values()) pendingMessages += inbox.length;
    return { id: this.id, name: this.name, members: this.listMembers(), tasks: this.listTasks(), pendingMessages };
  }

  /** Static tool schemas; dynamic team/member identity stays in closures. */
  createTools(memberId: string, attemptGen?: number, isAdmitted?: () => boolean): ToolDefinition[] {
    this.assertMemberAttempt(memberId, attemptGen);
    const thisTeam = this;
    const assertAdmitted = () => {
      if (isAdmitted && !isAdmitted()) throw new Error("workflow attempt is no longer admitted");
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
    function toolResult(text: string, details: unknown) {
      return { content: [{ type: "text" as const, text }], details };
    }
  }

  private assertMemberAttempt(memberId: string, attemptGen?: number, requireRunning = true): Member {
    const member = this.member(memberId);
    // Agent-bound tool surfaces always pass a generation. Public workflow-side
    // methods may omit it deliberately; supplied generations are strict and,
    // for tool operations, require the member to remain live/running.
    if (
      attemptGen !== undefined &&
      (member.attemptGen !== attemptGen || (requireRunning && member.status !== "running"))
    ) {
      throw new Error(`Team member ${memberId} attempt is no longer current`);
    }
    return member;
  }

  private ensureMessageCapacity(to: string, text: string): void {
    const inbox = this.inboxes.get(to);
    const bytes = inbox?.reduce((total, item) => total + Buffer.byteLength(item.message, "utf8"), 0) ?? 0;
    if (
      !inbox ||
      inbox.length >= 256 ||
      bytes + Buffer.byteLength(text, "utf8") > 1_000_000 ||
      this.messageCount >= this.maxMessages
    ) {
      throw new Error(`Team inbox for ${to} is full`);
    }
  }

  private ensureBroadcastCapacity(recipients: string[], message: string): void {
    const text = String(message ?? "").trim();
    for (const recipient of recipients) this.ensureMessageCapacity(recipient, text);
    if (this.messageCount + recipients.length > this.maxMessages)
      throw new Error(`Team ${this.name} reached its message limit`);
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

function assertModelFacingMessageKind(value: unknown): asserts value is ModelFacingAgentTeamMessageKind {
  if (typeof value !== "string" || !MODEL_FACING_MESSAGE_KINDS.has(value)) {
    throw new Error("Team message requires kind: blocker, task_changing_fact, or decision");
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
