/**
 * Real web tools for research workflows. These execute in the extension host
 * process (which has network access), not in a subagent sandbox, so they perform
 * genuine HTTP requests via Node's fetch.
 *
 * - web_search: best-effort Bing HTML scrape -> result {url, title}
 * - web_fetch:  fetch a URL and return readable text (HTML stripped, truncated)
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
function blockedAddress(address) {
    const normalized = address.replace(/^\[|\]$/g, "").toLowerCase();
    if (isIP(normalized) === 4) {
        const octets = normalized.split(".").map(Number);
        const [a, b] = octets;
        return (a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 0 || b === 168)) ||
            (a === 198 && b >= 18 && b <= 19) ||
            (a === 203 && b === 0) ||
            a >= 224);
    }
    if (isIP(normalized) === 6) {
        return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
    }
    return true;
}
async function assertSafeFetchUrl(raw) {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        throw new Error("web_fetch only permits http(s) URLs");
    if (parsed.username || parsed.password)
        throw new Error("web_fetch rejects URLs with embedded credentials");
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "metadata.google.internal") {
        throw new Error("web_fetch rejects local hostnames");
    }
    const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
    if (addresses.length === 0 || addresses.some(blockedAddress))
        throw new Error("web_fetch rejects private or local network targets");
    return parsed;
}
async function fetchText(url, timeoutMs = 15000, maxBytes = 2_000_000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let current = await assertSafeFetchUrl(url);
        for (let hop = 0; hop <= 5; hop++) {
            const res = await fetch(current, { headers: { "user-agent": UA }, signal: controller.signal, redirect: "manual" });
            if (res.status >= 300 && res.status < 400) {
                const location = res.headers.get("location");
                if (!location)
                    throw new Error(`redirect ${res.status} has no location`);
                current = await assertSafeFetchUrl(new URL(location, current).toString());
                continue;
            }
            if (!res.body)
                return { status: res.status, body: "" };
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let body = "";
            let bytes = 0;
            try {
                while (true) {
                    const part = await reader.read();
                    if (part.done)
                        break;
                    bytes += part.value.byteLength;
                    if (bytes > maxBytes)
                        throw new Error(`web response exceeds ${maxBytes} bytes`);
                    body += decoder.decode(part.value, { stream: true });
                }
                body += decoder.decode();
            }
            finally {
                reader.releaseLock();
            }
            return { status: res.status, body };
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
        description: "Fetch a URL and return its readable text content (HTML stripped, truncated).",
        promptSnippet: "Fetch a URL's text",
        parameters: Type.Object({
            url: Type.String({ description: "The absolute URL to fetch." }),
        }),
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
/** Both web tools, for injecting into a research workflow's agents. */
export function createWebTools() {
    return [createWebSearchTool(), createWebFetchTool()];
}
