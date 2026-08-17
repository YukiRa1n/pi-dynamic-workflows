/**
 * Pure boundaries for untrusted text that is shown in a terminal or sent to a
 * model/provider. Terminal control sequences are removed before host rendering;
 * model-bound text also has common credential and home-directory forms redacted.
 */
/**
 * Preserve the historical command redaction behavior while sharing its patterns
 * with redactForModel. This remains intentionally unbounded: callers that need
 * a model-size limit should use redactForModel instead.
 */
export declare function redactCommandSecrets(command: string): string;
/**
 * Replace absolute filesystem paths and file:// URIs with a placeholder. This is
 * separate from redactForModel because terminal-rendered text may legitimately
 * contain relative paths, and callers choose whether to hide absolute locations.
 */
export declare function redactAbsolutePaths(text: string, placeholder?: string): string;
/**
 * Remove terminal control sequences and C0/C1 controls while preserving tabs and
 * newlines. This runs before Markdown/highlighting so renderer-generated ANSI
 * styling remains available without allowing raw input to control the terminal.
 */
export declare function sanitizeForTerminal(text: string): string;
/**
 * Redact common credentials and user-home paths, strip terminal control
 * sequences, then cap the UTF-8 byte length. Text bound for a model/provider or
 * a terminal both must not carry credentials or raw control sequences, so this
 * single boundary handles both. It is deliberately pure and defensive: no
 * filesystem calls are made and a hostile runtime value cannot escape by
 * throwing.
 */
export declare function redactForModel(text: string, maxBytes?: number): string;
/** Small shared helper for callers rendering untrusted text in terminal UIs. */
export declare function sanitizeAndRedact(text: string, maxBytes?: number): string;
