import { createHash, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";

type FollowUpPriorityKind = "steer" | "followUp";

interface PendingInput {
  text: string;
  kind: FollowUpPriorityKind;
}

interface ActivePriorityItem {
  id: string;
  kind: FollowUpPriorityKind;
  index: number;
}

const FOLLOW_UP_PRIORITY_WAKE_TYPES = new Set(["follow-up-priority-wake", "workflow-steering-wake"]);
const FOLLOW_UP_DONE_MARKER = /<!--\s*pi-follow-up-done:([A-Za-z0-9:._-]+)\s*-->/g;

const FOLLOW_UP_PRIORITY_WAKE_MESSAGE = {
  customType: "follow-up-priority-wake",
  // Pi has no public continue-at-idle API. An empty, hidden custom prompt starts
  // one loop whose initial queue poll drains a real user message that arrived in
  // Pi's final-poll race. The context projection always removes this marker.
  content: [],
  display: false,
};

function userMessageText(message: any): string | undefined {
  if (message?.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const parts = message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function priorityId(message: any): string | undefined {
  if (message?.role !== "user") return undefined;
  if (typeof message.followUpPriorityId === "string") return message.followUpPriorityId;
  if (typeof message.workflowSteeringId === "string") return message.workflowSteeringId;
  if (message.steering !== true) return undefined;
  // Compatibility for histories written before explicit identities existed.
  return `legacy:${createHash("sha256")
    .update(JSON.stringify([message.timestamp ?? null, message.content ?? null]))
    .digest("hex")}`;
}

function priorityKind(message: any): FollowUpPriorityKind {
  return message?.followUpPriorityKind === "followUp" ? "followUp" : "steer";
}

function acknowledgedIds(message: any): string[] {
  if (message?.role !== "assistant") return [];
  const ids = [
    ...(Array.isArray(message.followUpPriorityAcknowledged) ? message.followUpPriorityAcknowledged : []),
    ...(Array.isArray(message.workflowSteeringAcknowledged) ? message.workflowSteeringAcknowledged : []),
  ];
  return ids.filter((id): id is string => typeof id === "string");
}

function priorityState(messages: any[], retired: ReadonlySet<string> = new Set()) {
  const retiredIds = new Set(retired);
  const active = new Map<string, ActivePriorityItem>();

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const id = priorityId(message);
    if (id) active.set(id, { id, kind: priorityKind(message), index });
    for (const acknowledged of acknowledgedIds(message)) retiredIds.add(acknowledged);
  }

  for (const id of retiredIds) active.delete(id);
  const activeItems = [...active.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "steer" ? -1 : 1;
    // A new steer is an intentional interruption, while queued follow-ups keep
    // Pi's normal FIFO semantics.
    return left.kind === "steer" ? right.index - left.index : left.index - right.index;
  });
  return { activeItems, retiredIds };
}

function priorityNotice(item: ActivePriorityItem, rank: number, all: ActivePriorityItem[]): string {
  const tag = `<pending-user-follow-up id="${item.id}" kind="${item.kind}" priority="P${rank}/${all.length}">`;
  const itemRule =
    "Treat this follow-up as an independent obligation. Do not infer that another follow-up explains its text or attachment, and do not merge it with another item unless the user explicitly links them.";
  if (rank !== 1) return `${tag}\n${itemRule}\n</pending-user-follow-up>`;

  const ledger = all.map((entry, index) => `P${index + 1}:${entry.id}:${entry.kind}`).join(" > ");
  return `<system-notice>
User follow-up priority is dynamic. The current order is ${ledger}. Steering items outrank ordinary follow-ups; newer steering items outrank older steering items; ordinary follow-ups remain FIFO. A newer item changes execution priority but never cancels an older unfinished item unless the user explicitly says to replace, cancel, or ignore it.

Keep every pending item distinct. Do not use later text as the description of an earlier image, file, or question unless the user explicitly connects them. Address pending follow-ups before returning to background work.

Do not compact, summarize away, or ctx_reduce an unresolved follow-up or its required attachment. It may leave active context only after its completion receipt is recorded.

Use the available Todo tool (todowrite or equivalent) when there is more than one pending item, or when an item requires multiple tool steps. Maintain one Todo entry per follow-up ID, include its current priority, keep unfinished entries, and update their status as work progresses. Do not create ceremonial Todo entries for a direct one-line answer.

Before stopping, explicitly answer every pending item or state its blocker and keep it pending. Only after fully resolving an item, append this exact hidden receipt to the final visible response: <!-- pi-follow-up-done:FOLLOW_UP_ID -->, replacing FOLLOW_UP_ID with that item's full ID. Never emit a receipt merely for acknowledging, starting, queueing, or planning an item.
</system-notice>
${tag}
${itemRule}
</pending-user-follow-up>`;
}

function prependPriorityNotice(content: any, notice: string): any {
  if (typeof content === "string") return `${notice}\n\n${content}`;
  if (!Array.isArray(content)) return content;

  let inserted = false;
  const output = content.map((part: any) => {
    if (inserted || part?.type !== "text" || typeof part.text !== "string") return part;
    inserted = true;
    return { ...part, text: `${notice}\n\n${part.text}` };
  });
  if (!inserted) output.unshift({ type: "text", text: notice });
  return output;
}

/**
 * Project durable follow-up identities into provider-only priority instructions.
 * Session history keeps the user's original text and attachments unchanged.
 */
export function projectFollowUpPriorityContext(messages: any[], retired: ReadonlySet<string> = new Set()): any[] {
  const providerMessages = messages.some(
    (message) => message?.role === "custom" && FOLLOW_UP_PRIORITY_WAKE_TYPES.has(message.customType),
  )
    ? messages.filter((message) => message?.role !== "custom" || !FOLLOW_UP_PRIORITY_WAKE_TYPES.has(message.customType))
    : messages;
  const { activeItems } = priorityState(providerMessages, retired);
  const priorities = new Map(activeItems.map((item, index) => [item.id, { item, rank: index + 1 }]));

  let projectedMessages: any[] | undefined;
  for (let index = 0; index < providerMessages.length; index++) {
    const message = providerMessages[index];
    const id = priorityId(message);
    if (
      !id &&
      !message?.followUpPriorityAcknowledged &&
      !message?.workflowSteeringAcknowledged &&
      !message?.followUpPriorityKind
    )
      continue;

    const projected = { ...message };
    delete projected.steering;
    delete projected.followUpPriorityId;
    delete projected.followUpPriorityKind;
    delete projected.followUpPriorityAcknowledged;
    delete projected.workflowSteeringId;
    delete projected.workflowSteeringAcknowledged;
    const priority = id ? priorities.get(id) : undefined;
    if (priority) {
      projected.content = prependPriorityNotice(
        message.content,
        priorityNotice(priority.item, priority.rank, activeItems),
      );
    }
    projectedMessages ??= providerMessages.slice();
    projectedMessages[index] = projected;
  }
  return projectedMessages ?? providerMessages;
}

/** Correlate Pi input events with the user messages emitted when its queues drain. */
export function createFollowUpPriorityContinuity() {
  const pendingInputs: PendingInput[] = [];
  const leadingPromptTexts: string[] = [];

  return {
    observeInput(event: Pick<InputEvent, "source" | "streamingBehavior" | "text">): void {
      if (event.source !== "interactive" && event.source !== "rpc") return;
      if (typeof event.text !== "string" || event.text.trim().length === 0) return;
      if (event.streamingBehavior === undefined) {
        // A fresh prompt can be emitted before an older queue entry stranded in
        // Pi's final-poll race. It must not consume the older correlation.
        leadingPromptTexts.length = 0;
        if (pendingInputs.some((input) => input.text === event.text)) leadingPromptTexts.push(event.text);
        return;
      }
      if (event.streamingBehavior !== "steer" && event.streamingBehavior !== "followUp") return;
      // Skill/template commands expand after the input hook, so their eventual
      // user message cannot be correlated without changing visible queue text.
      if (event.text.trimStart().startsWith("/")) return;
      pendingInputs.push({ text: event.text, kind: event.streamingBehavior });
    },

    markMessage(message: any): any | undefined {
      const text = userMessageText(message);
      if (text === undefined) return undefined;
      const leadingIndex = leadingPromptTexts.indexOf(text);
      if (leadingIndex >= 0) {
        leadingPromptTexts.splice(leadingIndex, 1);
        return undefined;
      }
      const pendingIndex = pendingInputs.findIndex((input) => input.text === text);
      if (pendingIndex < 0) return undefined;
      const [pending] = pendingInputs.splice(pendingIndex, 1);
      return {
        ...message,
        ...(pending.kind === "steer" ? { steering: true } : {}),
        followUpPriorityKind: pending.kind,
        followUpPriorityId: randomUUID(),
      };
    },

    hasPendingInput(): boolean {
      return pendingInputs.length > 0;
    },

    pendingCount(): number {
      return pendingInputs.length;
    },

    reset(): void {
      pendingInputs.length = 0;
      leadingPromptTexts.length = 0;
    },

    settle(hasPendingMessages: boolean): void {
      if (!hasPendingMessages) {
        pendingInputs.length = 0;
        leadingPromptTexts.length = 0;
      }
    },
  };
}

function stripDoneMarkers(message: any, allowedIds: ReadonlySet<string>) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return { message, acknowledged: [] as string[], changed: false };
  }

  const acknowledged = new Set<string>();
  let changed = false;
  const content = message.content.map((part: any) => {
    if (part?.type !== "text" || typeof part.text !== "string") return part;
    FOLLOW_UP_DONE_MARKER.lastIndex = 0;
    const text = part.text.replace(FOLLOW_UP_DONE_MARKER, (_match: string, id: string) => {
      changed = true;
      if (message.stopReason === "stop" && allowedIds.has(id)) acknowledged.add(id);
      return "";
    });
    return text === part.text ? part : { ...part, text: text.replace(/[ \t]+\n/g, "\n").trimEnd() };
  });
  return { message: changed ? { ...message, content } : message, acknowledged: [...acknowledged], changed };
}

export function installFollowUpPriority(pi: ExtensionAPI): void {
  const continuity = createFollowUpPriorityContinuity();
  let stagedIds: string[] = [];
  let requestIds: string[] = [];
  let retiredIds = new Set<string>();
  let strandedWakeTimer: ReturnType<typeof setTimeout> | undefined;
  let compacting = false;
  let promptPreflightActive = false;
  let sessionMutationActive = false;
  let suppressWakeForAbortedRun = false;

  const showPriority = (ctx: ExtensionContext | undefined, text?: string) => {
    try {
      ctx?.ui?.setStatus?.("follow-up-priority", text);
    } catch {
      // Optional UI state must not affect input or request acknowledgement.
    }
  };
  const cancelStrandedWake = () => {
    if (strandedWakeTimer) clearTimeout(strandedWakeTimer);
    strandedWakeTimer = undefined;
  };
  const scheduleStrandedWake = (ctx: ExtensionContext | undefined) => {
    cancelStrandedWake();
    if (
      compacting ||
      promptPreflightActive ||
      sessionMutationActive ||
      suppressWakeForAbortedRun ||
      !continuity.hasPendingInput()
    )
      return;

    strandedWakeTimer = setTimeout(() => {
      strandedWakeTimer = undefined;
      if (
        compacting ||
        promptPreflightActive ||
        sessionMutationActive ||
        suppressWakeForAbortedRun ||
        !continuity.hasPendingInput()
      )
        return;
      let isIdle = false;
      let hasPendingMessages = false;
      try {
        isIdle = ctx?.isIdle?.() === true;
        hasPendingMessages = ctx?.hasPendingMessages?.() === true;
      } catch {
        return;
      }
      if (!hasPendingMessages) {
        continuity.settle(false);
        return;
      }
      if (!isIdle) return;
      try {
        pi.sendMessage(FOLLOW_UP_PRIORITY_WAKE_MESSAGE, { triggerTurn: true });
      } catch {
        // Keep the real input queued for the next verified boundary.
      }
    }, 0);
  };

  pi.on("input", (event, ctx) => {
    if (event.streamingBehavior === undefined) {
      cancelStrandedWake();
      compacting = false;
      promptPreflightActive = true;
      sessionMutationActive = false;
    }
    continuity.observeInput(event);
    if (continuity.hasPendingInput()) showPriority(ctx, `${continuity.pendingCount()} user follow-up queued`);
    else if (event.streamingBehavior === undefined) showPriority(ctx);
    return undefined;
  });
  pi.on("message_end", (event, ctx) => {
    const marked = continuity.markMessage(event.message);
    if (marked) return { message: marked };

    const stripped = stripDoneMarkers(event.message, new Set(requestIds));
    if (
      event.message.role === "assistant" &&
      requestIds.length > 0 &&
      ["error", "aborted", "length"].includes(event.message.stopReason)
    )
      showPriority(ctx, `${requestIds.length} user follow-up${requestIds.length === 1 ? "" : "s"} pending`);
    if (stripped.acknowledged.length === 0) return stripped.changed ? { message: stripped.message } : undefined;

    const prior = Array.isArray(stripped.message.followUpPriorityAcknowledged)
      ? stripped.message.followUpPriorityAcknowledged.filter((id: unknown): id is string => typeof id === "string")
      : [];
    const acknowledged = [...new Set([...prior, ...stripped.acknowledged])];
    for (const id of stripped.acknowledged) retiredIds.add(id);
    requestIds = requestIds.filter((id) => !retiredIds.has(id));
    stagedIds = stagedIds.filter((id) => !retiredIds.has(id));
    showPriority(
      ctx,
      requestIds.length
        ? `${requestIds.length} user follow-up${requestIds.length === 1 ? "" : "s"} pending`
        : continuity.hasPendingInput()
          ? `${continuity.pendingCount()} user follow-up queued`
          : undefined,
    );
    return { message: { ...stripped.message, followUpPriorityAcknowledged: acknowledged } };
  });
  pi.on("context", (event, ctx) => {
    try {
      const branch = ctx?.sessionManager?.getBranch?.();
      if (Array.isArray(branch)) {
        const history = branch.filter((entry) => entry.type === "message").map((entry: any) => entry.message);
        retiredIds = priorityState(history, retiredIds).retiredIds;
      }
    } catch {
      // Live receipts still protect a host that cannot expose its branch.
    }
    const messages = event.messages as any[];
    const state = priorityState(messages, retiredIds);
    retiredIds = state.retiredIds;
    stagedIds = state.activeItems.map((item) => item.id);
    requestIds = [];
    showPriority(
      ctx,
      stagedIds.length
        ? `Replying to ${stagedIds.length} user follow-up${stagedIds.length === 1 ? "" : "s"}`
        : continuity.hasPendingInput()
          ? `${continuity.pendingCount()} user follow-up queued`
          : undefined,
    );
    return { messages: projectFollowUpPriorityContext(messages, retiredIds) };
  });
  pi.on("before_provider_request", () => {
    if (stagedIds.length) {
      requestIds = stagedIds;
      stagedIds = [];
    }
  });
  pi.on("message_start", (event) => {
    if (event.message.role === "assistant" && stagedIds.length) {
      requestIds = stagedIds;
      stagedIds = [];
    }
  });
  pi.on("before_agent_start", () => {
    cancelStrandedWake();
    promptPreflightActive = true;
  });
  pi.on("agent_start", () => {
    cancelStrandedWake();
    compacting = false;
    promptPreflightActive = false;
    sessionMutationActive = false;
    suppressWakeForAbortedRun = false;
  });
  pi.on("agent_end", (event) => {
    let lastAssistant: any;
    const messages = Array.isArray(event?.messages) ? event.messages : [];
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.role !== "assistant") continue;
      lastAssistant = messages[index];
      break;
    }
    suppressWakeForAbortedRun = lastAssistant?.stopReason === "aborted";
    if (suppressWakeForAbortedRun) cancelStrandedWake();
  });
  pi.on("agent_settled", (_event, ctx) => {
    compacting = false;
    const hasPendingMessages = ctx?.hasPendingMessages?.() === true;
    continuity.settle(hasPendingMessages);
    if (!hasPendingMessages) {
      cancelStrandedWake();
      showPriority(
        ctx,
        requestIds.length
          ? `${requestIds.length} user follow-up${requestIds.length === 1 ? "" : "s"} pending`
          : undefined,
      );
      return;
    }
    scheduleStrandedWake(ctx);
  });
  pi.on("session_before_compact", () => {
    compacting = true;
    cancelStrandedWake();
  });
  const fenceSessionMutation = (_event: unknown, ctx: ExtensionContext) => {
    sessionMutationActive = true;
    stagedIds = [];
    requestIds = [];
    retiredIds.clear();
    showPriority(ctx);
    cancelStrandedWake();
  };
  pi.on("session_before_tree", fenceSessionMutation);
  pi.on("session_before_switch", fenceSessionMutation);
  pi.on("session_before_fork", fenceSessionMutation);
  pi.on("session_shutdown", (_event, ctx) => {
    cancelStrandedWake();
    compacting = false;
    promptPreflightActive = false;
    sessionMutationActive = false;
    suppressWakeForAbortedRun = false;
    stagedIds = [];
    requestIds = [];
    retiredIds.clear();
    showPriority(ctx);
    continuity.reset();
  });
}

export default installFollowUpPriority;
