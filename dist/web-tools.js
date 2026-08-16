/**
 * Real web tools for research workflows. These execute in the extension host
 * process (which has network access), not in a subagent sandbox.
 *
 * Security properties:
 * - only http(s), no URL credentials
 * - every DNS answer must be globally routable
 * - the validated address is pinned into the actual socket lookup, preventing
 *   DNS rebinding between validation and connection
 * - redirects are revalidated and repinned hop-by-hop
 * - response streams are destroyed on timeout, redirect, size overflow, or error
 *
 * - web_search: best-effort Bing HTML scrape -> result {url, title}
 * - web_fetch:  fetch a URL and return readable text (HTML stripped, truncated)
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const MAX_REDIRECTS = 5;
function blockedIpv4(address) {
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
        return true;
    const [a, b, c] = octets;
    return (a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && (b === 0 || b === 168)) ||
        (a === 198 && b >= 18 && b <= 19) ||
        (a === 198 && b === 51 && c === 100) ||
        (a === 203 && b === 0 && c === 113) ||
        a >= 224);
}
/** Convert every IPv4-mapped IPv6 spelling, including ::ffff:7f00:1, to dotted IPv4. */
function mappedIpv4(address) {
    const normalized = address
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
        .split("%")[0];
    if (!normalized.startsWith("::ffff:"))
        return undefined;
    const tail = normalized.slice("::ffff:".length);
    if (isIP(tail) === 4)
        return tail;
    const words = tail.split(":");
    if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word)))
        return undefined;
    const high = Number.parseInt(words[0], 16);
    const low = Number.parseInt(words[1], 16);
    return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}
function ipv6Value(address) {
    let normalized = address.toLowerCase();
    if (normalized.includes(".")) {
        const separator = normalized.lastIndexOf(":");
        const octets = normalized
            .slice(separator + 1)
            .split(".")
            .map(Number);
        if (separator < 0 ||
            octets.length !== 4 ||
            octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
            return undefined;
        normalized = `${normalized.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
    }
    const halves = normalized.split("::");
    if (halves.length > 2)
        return undefined;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1))
        return undefined;
    const words = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
    if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word)))
        return undefined;
    return words.reduce((value, word) => (value << 16n) | BigInt(Number.parseInt(word, 16)), 0n);
}
function ipv6Policy(cidr, blocked) {
    const [address, rawBits] = cidr.split("/");
    const prefix = ipv6Value(address);
    const bits = Number(rawBits);
    if (prefix === undefined || !Number.isInteger(bits) || bits < 0 || bits > 128) {
        throw new Error(`Invalid internal IPv6 policy: ${cidr}`);
    }
    return { prefix, bits, blocked };
}
function matchesIpv6Policy(value, policy) {
    const shift = 128n - BigInt(policy.bits);
    return value >> shift === policy.prefix >> shift;
}
// Longest-prefix policy derived from the IANA IPv6 special-purpose registry.
// The broad 2001::/23 reservation is deny-by-default, with only its explicitly
// globally reachable more-specific allocations restored. Translation and
// tunnel prefixes remain blocked because they can encode a different target.
const IPV6_POLICIES = [
    ipv6Policy("2001:1::1/128", false),
    ipv6Policy("2001:1::2/128", false),
    ipv6Policy("2001:1::3/128", false),
    ipv6Policy("2001:4:112::/48", false),
    ipv6Policy("2001:2::/48", true),
    ipv6Policy("64:ff9b:1::/48", true),
    ipv6Policy("2001::/32", true),
    ipv6Policy("2001:3::/32", false),
    ipv6Policy("2001:db8::/32", true),
    ipv6Policy("2001:10::/28", true),
    ipv6Policy("2001:20::/28", false),
    ipv6Policy("2001:30::/28", false),
    ipv6Policy("3fff::/20", true),
    ipv6Policy("5f00::/16", true),
    ipv6Policy("2002::/16", true),
    ipv6Policy("2001::/23", true),
    ipv6Policy("::ffff:0:0/96", true),
    ipv6Policy("64:ff9b::/96", true),
    ipv6Policy("::/96", true),
    ipv6Policy("100:0:0:1::/64", true),
    ipv6Policy("100::/64", true),
    ipv6Policy("fc00::/7", true),
    ipv6Policy("fe80::/10", true),
    ipv6Policy("fec0::/10", true),
    ipv6Policy("ff00::/8", true),
    ipv6Policy("2000::/3", false),
].sort((a, b) => b.bits - a.bits);
export function blockedAddress(address) {
    const normalized = address
        .replace(/^\[|\]$/g, "")
        .toLowerCase()
        .split("%")[0];
    const mapped = mappedIpv4(normalized);
    if (mapped)
        return blockedIpv4(mapped);
    if (isIP(normalized) === 4)
        return blockedIpv4(normalized);
    if (isIP(normalized) !== 6)
        return true;
    const value = ipv6Value(normalized);
    if (value === undefined)
        return true;
    return IPV6_POLICIES.find((policy) => matchesIpv6Policy(value, policy))?.blocked ?? true;
}
async function resolveSafeTarget(raw) {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("web_fetch only permits http(s) URLs");
    }
    if (parsed.username || parsed.password)
        throw new Error("web_fetch rejects URLs with embedded credentials");
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host === "metadata.google.internal") {
        throw new Error("web_fetch rejects local hostnames");
    }
    const literalFamily = isIP(host);
    const answers = literalFamily
        ? [{ address: host, family: literalFamily }]
        : await lookup(host, { all: true, verbatim: true });
    if (answers.length === 0 || answers.some((answer) => blockedAddress(answer.address))) {
        // Fail closed if DNS mixes public and private answers. Picking only a public
        // answer would allow an attacker to steer later retries toward the private one.
        throw new Error("web_fetch rejects private, reserved, or local network targets");
    }
    const selected = answers[0];
    return { url: parsed, address: selected.address, family: selected.family };
}
function requestPinned(target, signal, maxBytes) {
    return new Promise((resolve, reject) => {
        const request = (target.url.protocol === "https:" ? httpsRequest : httpRequest)(target.url, {
            headers: { "user-agent": UA, accept: "text/html,text/plain;q=0.9,*/*;q=0.1", "accept-encoding": "identity" },
            signal,
            // Pin the socket to the exact address that passed validation. The URL's
            // hostname remains intact for Host and TLS SNI/certificate verification.
            lookup: (_hostname, _options, callback) => callback(null, target.address, target.family),
        }, (response) => {
            const status = response.statusCode ?? 0;
            const location = response.headers.location;
            if (status >= 300 && status < 400) {
                response.destroy();
                resolve({ status, body: "", location });
                return;
            }
            const chunks = [];
            let bytes = 0;
            response.on("data", (chunk) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytes += buffer.byteLength;
                if (bytes > maxBytes) {
                    response.destroy(new Error(`web response exceeds ${maxBytes} bytes`));
                    return;
                }
                chunks.push(buffer);
            });
            response.once("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
            response.once("error", reject);
        });
        request.once("error", reject);
        request.end();
    });
}
async function fetchText(url, timeoutMs = 15_000, maxBytes = 2_000_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`web request timed out after ${timeoutMs}ms`)), timeoutMs);
    try {
        let current = await resolveSafeTarget(url);
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const response = await requestPinned(current, controller.signal, maxBytes);
            if (response.status < 300 || response.status >= 400)
                return { status: response.status, body: response.body };
            if (!response.location)
                throw new Error(`redirect ${response.status} has no location`);
            if (hop === MAX_REDIRECTS)
                break;
            current = await resolveSafeTarget(new URL(response.location, current.url).toString());
        }
        throw new Error("web_fetch redirect limit exceeded");
    }
    finally {
        clearTimeout(timer);
    }
}
export function htmlToText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/[ \t]+/g, " ")
        .replace(/\n +/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}
export function parseBingResults(html, limit) {
    const out = [];
    const seen = new Set();
    for (const m of html.matchAll(/<h2[^>]*>\s*<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
        const url = m[1];
        if (/\.bing\.com|go\.microsoft\.com/.test(url) || seen.has(url))
            continue;
        seen.add(url);
        out.push({ url, title: m[2].replace(/<[^>]+>/g, "").trim() });
        if (out.length >= limit)
            break;
    }
    return out;
}
/** A tool that searches the web (best-effort) and returns result URLs + titles. */
export function createWebSearchTool() {
    return defineTool({
        name: "web_search",
        label: "Web Search",
        description: "Search the web and return a list of result URLs and titles. Use before web_fetch to find sources.",
        promptSnippet: "Search the web for sources",
        parameters: Type.Object({
            query: Type.String({ description: "The search query." }),
            count: Type.Optional(Type.Number({ description: "Max results (default 6)." })),
        }),
        async execute(_id, params) {
            const limit = Math.min(Math.max(params.count ?? 6, 1), 10);
            try {
                const { status, body } = await fetchText(`https://www.bing.com/search?q=${encodeURIComponent(params.query)}`);
                const results = parseBingResults(body, limit);
                const text = results.length
                    ? results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n")
                    : `No results parsed (HTTP ${status}). Try a different query or fetch a known URL directly.`;
                return { content: [{ type: "text", text }], details: { results } };
            }
            catch (error) {
                return {
                    content: [{ type: "text", text: `web_search failed: ${error instanceof Error ? error.message : error}` }],
                    details: { results: [] },
                };
            }
        },
    });
}
/** A tool that fetches a URL and returns readable text. */
export function createWebFetchTool(maxChars = 6000) {
    return defineTool({
        name: "web_fetch",
        label: "Web Fetch",
        description: "Fetch a public http(s) URL and return readable text (HTML stripped, truncated).",
        promptSnippet: "Fetch a public URL's text",
        parameters: Type.Object({ url: Type.String({ description: "The absolute public http(s) URL to fetch." }) }),
        async execute(_id, params) {
            try {
                const { status, body } = await fetchText(params.url);
                const text = htmlToText(body).slice(0, maxChars);
                return {
                    content: [{ type: "text", text: `HTTP ${status} ${params.url}\n\n${text}` }],
                    details: { status, url: params.url },
                };
            }
            catch (error) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `web_fetch failed for ${params.url}: ${error instanceof Error ? error.message : error}`,
                        },
                    ],
                    details: { status: 0, url: params.url },
                };
            }
        },
    });
}
/** Both web tools, intentionally without shell/filesystem coding tools. */
export function createWebTools() {
    return [createWebSearchTool(), createWebFetchTool()];
}
