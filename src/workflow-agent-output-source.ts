import { createHash } from "node:crypto";
import type { WorkflowAgentSnapshot } from "./display.js";
import type { PersistedRunState } from "./run-persistence.js";
import { safeStringify } from "./safe-serialize.js";
import type { WorkflowManager } from "./workflow-manager.js";

/** The identity fields shared by get_workflow_output and live notifications. */
export interface WorkflowAgentOutputIdentity {
  id: number;
  callId?: string;
  label: string;
  phase?: string;
  status: "done" | "error";
}

export interface WorkflowAgentOutputCandidate extends WorkflowAgentOutputIdentity {
  value: unknown;
  fingerprint: string;
  previewOnly?: boolean;
}

type ConsumedAgentOutputStore = WeakMap<WorkflowManager, Map<string, Set<string>>>;

// Pi reloads extension modules in the same process while retaining the live
// WorkflowManager. A module-local WeakMap is recreated by that reload, which
// makes already-returned agent finals look new again. Keep the cursor on a
// process-global symbol instead; the WeakMap still releases it with the
// manager, so this does not turn session state into an unbounded global cache.
const CONSUMED_AGENT_OUTPUT_STORE = Symbol.for("pi-dynamic-workflows.consumed-agent-output-store");

function consumedAgentOutputStore(): ConsumedAgentOutputStore {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const retained = host[CONSUMED_AGENT_OUTPUT_STORE];
  if (retained instanceof WeakMap) return retained as ConsumedAgentOutputStore;
  const created: ConsumedAgentOutputStore = new WeakMap();
  Object.defineProperty(host, CONSUMED_AGENT_OUTPUT_STORE, {
    configurable: true,
    value: created,
  });
  return created;
}
const MAX_AGENT_OUTPUT_FINGERPRINT_BYTES = 256_000;

/** Stable identity used by every consumer of a completed agent result. */
export function workflowAgentOutputFingerprint(identity: WorkflowAgentOutputIdentity, value: unknown): string {
  const serialized = safeStringify(
    { status: identity.status, value },
    { maxBytes: MAX_AGENT_OUTPUT_FINGERPRINT_BYTES, pretty: false },
  );
  const digest = createHash("sha256").update(serialized).digest("hex");
  return `${identity.callId ?? identity.id}:${digest}`;
}

/** Shared session-scoped cursor; the durable run remains the source of truth. */
export function workflowAgentOutputCursor(manager: WorkflowManager, runId: string): Set<string> {
  const consumedAgentOutputs = consumedAgentOutputStore();
  let byRun = consumedAgentOutputs.get(manager);
  if (!byRun) {
    byRun = new Map<string, Set<string>>();
    consumedAgentOutputs.set(manager, byRun);
  }
  let seen = byRun.get(runId);
  if (!seen) {
    seen = new Set<string>();
    byRun.set(runId, seen);
  }
  return seen;
}

/** Claim one result for either the live notification or the output tool. */
export function claimWorkflowAgentOutput(
  manager: WorkflowManager,
  runId: string,
  identity: WorkflowAgentOutputIdentity,
  value: unknown,
): boolean {
  const fingerprint = workflowAgentOutputFingerprint(identity, value);
  const cursor = workflowAgentOutputCursor(manager, runId);
  if (cursor.has(fingerprint)) return false;
  cursor.add(fingerprint);
  return true;
}

export function isWorkflowAgentOutputConsumed(
  manager: WorkflowManager,
  runId: string,
  identity: WorkflowAgentOutputIdentity,
  value: unknown,
): boolean {
  return workflowAgentOutputCursor(manager, runId).has(workflowAgentOutputFingerprint(identity, value));
}

/** Build the tool's candidates from the same live/persisted agent snapshots. */
export function workflowAgentOutputCandidates(
  manager: WorkflowManager,
  run: PersistedRunState,
): WorkflowAgentOutputCandidate[] {
  let live: { snapshot: { agents: WorkflowAgentSnapshot[] } } | undefined;
  try {
    // Retained managers from before the output-source helper may not expose
    // getRun; persisted snapshots remain sufficient for the compatibility path.
    live = typeof manager.getRun === "function" ? manager.getRun(run.runId) : undefined;
  } catch {
    live = undefined;
  }
  const agents = live?.snapshot.agents ?? persistedAgentsWithJournalResults(run);
  return agents.flatMap((agent) => {
    if (agent.status !== "done" && agent.status !== "error") return [];
    const previewOnly = agent.result === undefined;
    const value = agent.result ?? agent.error ?? agent.resultPreview;
    if (value === undefined || (typeof value === "string" && value.trim().length === 0)) return [];
    const identity: WorkflowAgentOutputIdentity = {
      id: agent.id,
      ...(agent.callId ? { callId: agent.callId } : {}),
      label: agent.label,
      ...(agent.phase ? { phase: agent.phase } : {}),
      status: agent.status,
    };
    return [
      {
        ...identity,
        value,
        ...(previewOnly ? { previewOnly: true } : {}),
        fingerprint: workflowAgentOutputFingerprint(identity, value),
      },
    ];
  });
}

function persistedAgentsWithJournalResults(run: PersistedRunState): WorkflowAgentSnapshot[] {
  const journalByIndex = new Map<number, unknown>();
  const journalByCallId = new Map<string, unknown>();
  for (const entry of Array.isArray(run.journal) ? run.journal : []) {
    if (!entry || typeof entry !== "object" || typeof entry.index !== "number") continue;
    journalByIndex.set(entry.index, entry.result);
    if (typeof entry.runId === "string") journalByCallId.set(`${entry.runId}:${entry.index}`, entry.result);
  }
  return run.agents.map((agent, index) => {
    const journalResult = agent.callId ? journalByCallId.get(agent.callId) : journalByIndex.get(index);
    return {
      ...agent,
      result: agent.result === undefined && agent.status === "done" ? journalResult : agent.result,
    };
  });
}
