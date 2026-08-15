/**
 * Real web tools for research workflows. These execute in the extension host
 * process (which has network access), not in a subagent sandbox, so they perform
 * genuine HTTP requests via Node's fetch.
 *
 * - web_search: best-effort Bing HTML scrape -> result {url, title}
 * - web_fetch:  fetch a URL and return readable text (HTML stripped, truncated)
 */
import { type ToolDefinition } from "@earendil-works/pi-coding-agent";
export declare function htmlToText(html: string): string;
export declare function parseBingResults(html: string, limit: number): Array<{
    url: string;
    title: string;
}>;
/** A tool that searches the web (best-effort) and returns result URLs + titles. */
export declare function createWebSearchTool(): ToolDefinition;
/** A tool that fetches a URL and returns readable text. */
export declare function createWebFetchTool(maxChars?: number): ToolDefinition;
/** Both web tools, for injecting into a research workflow's agents. */
export declare function createWebTools(): ToolDefinition[];
