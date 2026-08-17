/**
 * Pure boundaries for untrusted text that is shown in a terminal or sent to a
 * model/provider. Terminal control sequences are removed before host rendering;
 * model-bound text also has common credential and home-directory forms redacted.
 */
const DEFAULT_MODEL_MAX_BYTES = 8_192;
const TRUNCATION_MARKER = "[truncated]";
const REDACTION_MARKER = "[REDACTED]";
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const C1_CSI = String.fromCharCode(0x9b);
const C1_DCS = String.fromCharCode(0x90);
const C1_SOS = String.fromCharCode(0x98);
const C1_PM = String.fromCharCode(0x9e);
const C1_APC = String.fromCharCode(0x9f);
const C1_OSC = String.fromCharCode(0x9d);
const C1_ST = String.fromCharCode(0x9c);
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const ESCAPE = escapeRegExp(ESC);
const ST = escapeRegExp(`${ESC}\\`);
const BEL_PATTERN = escapeRegExp(BEL);
const C1_ST_PATTERN = escapeRegExp(C1_ST);
/** CSI, OSC, DCS, SOS, PM, and APC sequence forms (including 8-bit C1 forms). */
const CONTROL_SEQUENCE_PATTERNS = [
    new RegExp(`${ESCAPE}][\\s\\S]*?(?:${BEL_PATTERN}|${ST}|$)`, "g"),
    new RegExp(`${ESCAPE}(?:P|X|\\^|_)[\\s\\S]*?(?:${ST}|$)`, "g"),
    new RegExp(`${ESCAPE}\\[[0-?]*[ -/]*[@-~]`, "g"),
    new RegExp(`${escapeRegExp(C1_OSC)}[\\s\\S]*?(?:${BEL_PATTERN}|${C1_ST_PATTERN}|$)`, "g"),
    new RegExp(`${escapeRegExp(C1_DCS)}[\\s\\S]*?(?:${ST}|${C1_ST_PATTERN}|$)`, "g"),
    new RegExp(`${escapeRegExp(C1_SOS)}[\\s\\S]*?(?:${ST}|${C1_ST_PATTERN}|$)`, "g"),
    new RegExp(`${escapeRegExp(C1_PM)}[\\s\\S]*?(?:${ST}|${C1_ST_PATTERN}|$)`, "g"),
    new RegExp(`${escapeRegExp(C1_APC)}[\\s\\S]*?(?:${ST}|${C1_ST_PATTERN}|$)`, "g"),
    new RegExp(`${escapeRegExp(C1_CSI)}[0-?]*[ -/]*[@-~]`, "g"),
];
const ST_PATTERN = new RegExp(ST, "g");
const ESC_PATTERN = new RegExp(ESCAPE, "g");
const C0_AND_C1_PATTERN = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}${String.fromCharCode(128)}-${String.fromCharCode(159)}]`, "g");
const COMMON_TOKEN_PATTERN = /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_-]+\b|\bgithub_pat_[A-Za-z0-9_-]+\b|\bsk-[A-Za-z0-9][A-Za-z0-9_-]*\b/g;
// The value group consumes an optional Bearer prefix and an optional surrounding
// quote so the whole secret — not just the "Bearer" keyword or an empty quoted
// prefix — is replaced in one pass. This must run before BEARER_PATTERN so an
// "Authorization: Bearer <token>" header does not leak the token.
const SECRET_ASSIGNMENT_PATTERN = /((?:authorization|api[-_]?key|access[-_]?token|password)["']?\s*[:=]\s*)(?:"(?:Bearer\s+)?(?:\\.|[^"\\])*"|'(?:Bearer\s+)?(?:\\.|[^'\\])*'|(?:Bearer\s+)?[^\s;'"`]+)/gi;
const URL_USERINFO_PATTERN = /(\bhttps?:\/\/)[^/\s@]+@/gi;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\b/g;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;
const NPM_TOKEN_PATTERN = /\bnpm_[A-Za-z0-9_-]+\b/g;
function byteLength(text) {
    return Buffer.byteLength(text, "utf8");
}
function prefixUtf8(text, maxBytes) {
    if (maxBytes <= 0)
        return "";
    let used = 0;
    let end = 0;
    for (const character of text) {
        const size = byteLength(character);
        if (used + size > maxBytes)
            break;
        used += size;
        end += character.length;
    }
    return text.slice(0, end);
}
function normalizeMaxBytes(maxBytes) {
    return typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes >= 0
        ? Math.floor(maxBytes)
        : DEFAULT_MODEL_MAX_BYTES;
}
function truncateUtf8(text, maxBytes) {
    if (byteLength(text) <= maxBytes)
        return text;
    const markerBytes = byteLength(TRUNCATION_MARKER);
    if (maxBytes <= 0)
        return "";
    if (markerBytes >= maxBytes)
        return prefixUtf8(TRUNCATION_MARKER, maxBytes);
    return `${prefixUtf8(text, maxBytes - markerBytes)}${TRUNCATION_MARKER}`;
}
function redactSecretShapes(text) {
    return text
        .replace(COMMON_TOKEN_PATTERN, REDACTION_MARKER)
        .replace(SECRET_ASSIGNMENT_PATTERN, `$1${REDACTION_MARKER}`)
        .replace(URL_USERINFO_PATTERN, "$1***@")
        .replace(BEARER_PATTERN, "Bearer [REDACTED]")
        .replace(JWT_PATTERN, REDACTION_MARKER)
        .replace(AWS_ACCESS_KEY_PATTERN, REDACTION_MARKER)
        .replace(NPM_TOKEN_PATTERN, REDACTION_MARKER);
}
/**
 * Preserve the historical command redaction behavior while sharing its patterns
 * with redactForModel. This remains intentionally unbounded: callers that need
 * a model-size limit should use redactForModel instead.
 */
export function redactCommandSecrets(command) {
    if (typeof command !== "string")
        return "";
    try {
        return redactSecretShapes(command);
    }
    catch {
        return "";
    }
}
function homeDirectoryPrefixes() {
    try {
        const environment = typeof process === "undefined" ? undefined : process.env;
        const windowsHome = environment?.HOMEDRIVE && environment.HOMEPATH ? `${environment.HOMEDRIVE}${environment.HOMEPATH}` : "";
        return [...new Set([environment?.HOME, environment?.USERPROFILE, windowsHome])].filter((prefix) => typeof prefix === "string" && prefix.length > 0);
    }
    catch {
        return [];
    }
}
function homePrefixPattern(prefix) {
    const trimmed = prefix.replace(/[\\/]+$/, "");
    let pattern = "";
    for (const character of trimmed) {
        pattern += character === "/" || character === "\\" ? "[\\\\/]+" : escapeRegExp(character);
    }
    return pattern;
}
function redactHomeDirectories(text) {
    let output = text;
    for (const prefix of homeDirectoryPrefixes()) {
        const pattern = homePrefixPattern(prefix);
        if (!pattern)
            continue;
        try {
            const matcher = new RegExp(`(^|[\\s"'(=:/])${pattern}(?=$|[\\\\/])`, "gi");
            output = output.replace(matcher, "$1~");
        }
        catch {
            // A malformed environment value must not make the boundary throw.
        }
    }
    return output;
}
// Absolute filesystem paths and file:// URIs can expose the user's directory
// layout, workspace location, or network shares. Match a Windows drive path
// (C:\...), a UNC path (\\server\share), a POSIX absolute path (/...), or a
// file:// URI after a delimiter that can precede a path in prose/JSON/URIs.
const ABSOLUTE_PATH_PATTERN = /(^|[\s"'`(=:[{,])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))[^\s"'`<>)\]}]*|(?:file:\/\/)[^\s"'`<>)\]}]*/gu;
/**
 * Replace absolute filesystem paths and file:// URIs with a placeholder. This is
 * separate from redactForModel because terminal-rendered text may legitimately
 * contain relative paths, and callers choose whether to hide absolute locations.
 */
export function redactAbsolutePaths(text, placeholder = "[path redacted]") {
    if (typeof text !== "string")
        return "";
    try {
        return text.replace(ABSOLUTE_PATH_PATTERN, (match, prefix) => match.startsWith("file://") ? `${placeholder}` : `${prefix ?? ""}${placeholder}`);
    }
    catch {
        return "";
    }
}
/**
 * Remove terminal control sequences and C0/C1 controls while preserving tabs and
 * newlines. This runs before Markdown/highlighting so renderer-generated ANSI
 * styling remains available without allowing raw input to control the terminal.
 */
export function sanitizeForTerminal(text) {
    if (typeof text !== "string")
        return "";
    try {
        let output = text;
        for (const pattern of CONTROL_SEQUENCE_PATTERNS)
            output = output.replace(pattern, "");
        return output.replace(ST_PATTERN, "").replace(ESC_PATTERN, "").replace(C0_AND_C1_PATTERN, "");
    }
    catch {
        return "";
    }
}
/**
 * Redact common credentials and user-home paths, strip terminal control
 * sequences, then cap the UTF-8 byte length. Text bound for a model/provider or
 * a terminal both must not carry credentials or raw control sequences, so this
 * single boundary handles both. It is deliberately pure and defensive: no
 * filesystem calls are made and a hostile runtime value cannot escape by
 * throwing.
 */
export function redactForModel(text, maxBytes) {
    if (typeof text !== "string")
        return "";
    try {
        const redacted = sanitizeForTerminal(redactHomeDirectories(redactSecretShapes(text)));
        return truncateUtf8(redacted, normalizeMaxBytes(maxBytes));
    }
    catch {
        return "";
    }
}
/** Small shared helper for callers rendering untrusted text in terminal UIs. */
export function sanitizeAndRedact(text, maxBytes) {
    return sanitizeForTerminal(redactForModel(text, maxBytes));
}
