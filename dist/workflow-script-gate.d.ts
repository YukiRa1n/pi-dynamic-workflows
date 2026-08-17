export type WorkflowScriptAuditViolation = {
    /** Short machine-stable rule id, e.g. "computed-member-access". */
    rule: string;
    /** Human-facing detail with the offending construct. */
    message: string;
    /** 1-based source line when the parser provided one. */
    line?: number;
};
export type WorkflowScriptGateDecision = {
    action: "allow";
    via: "static-audit" | "not-required";
} | {
    action: "block";
    reason: string;
    violations: WorkflowScriptAuditViolation[];
};
/**
 * Statically audit a workflow script. Returns the violation list; empty means
 * the script is inside the orchestration subset. Never throws on unparseable
 * input — parse errors are reported as a violation (the runner would reject
 * them anyway).
 */
export declare function auditWorkflowScript(script: string): WorkflowScriptAuditViolation[];
/**
 * Gate a tool call's custom script through the static audit. Synchronous and
 * side-effect free; the caller turns a block decision into a tool error.
 */
export declare function decideWorkflowScriptGate(script: string | undefined): WorkflowScriptGateDecision;
