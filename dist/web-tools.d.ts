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
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
export declare function blockedAddress(address: string): boolean;
export declare function htmlToText(html: string): string;
export declare function parseBingResults(html: string, limit: number): Array<{
    url: string;
    title: string;
}>;
/** A tool that searches the web (best-effort) and returns result URLs + titles. */
export declare function createWebSearchTool(): ToolDefinition;
/** A tool that fetches a URL and returns readable text. */
export declare function createWebFetchTool(maxChars?: number): ToolDefinition;
/** Both web tools, intentionally without shell/filesystem coding tools. */
export declare function createWebTools(): ToolDefinition[];
