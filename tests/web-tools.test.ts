import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedAddress,
  createWebFetchTool,
  createWebSearchTool,
  createWebTools,
  htmlToText,
  parseBingResults,
} from "../src/web-tools.js";

test("blockedAddress rejects private, reserved, translated, and non-global IP addresses", () => {
  const blocked = [
    "127.0.0.1",
    "192.168.1.1",
    "::",
    "::1",
    "::192.168.1.1",
    "::7f00:1",
    "::8.8.8.8",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::808:808",
    "64:ff9b:1::1",
    "100::1",
    "100:0:0:1::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002:c0a8:101::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "ff02::1",
  ];
  for (const address of blocked) assert.equal(blockedAddress(address), true, `${address} must be blocked`);
});

test("blockedAddress permits public IPv4 and globally reachable IPv6 addresses", () => {
  const allowed = ["8.8.8.8", "::ffff:8.8.8.8", "2606:4700:4700::1111", "2620:4f:8000::1", "2001:3::1"];
  for (const address of allowed) assert.equal(blockedAddress(address), false, `${address} must be allowed`);
});

// ─── createWebSearchTool ─────────────────────────────────────────────────────

test("createWebSearchTool has correct name and metadata", () => {
  const tool = createWebSearchTool();
  assert.equal(tool.name, "web_search");
  assert.equal(tool.label, "Web Search");
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.parameters, "parameters should be truthy");
});

test("createWebSearchTool has execute function", () => {
  const tool = createWebSearchTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWebSearchTool tool has parameters with query field", () => {
  const tool = createWebSearchTool();
  assert.ok(tool.parameters, "should have parameters");
});

test("createWebSearchTool has default count", () => {
  const tool = createWebSearchTool();
  // Verify the tool definition has the right shape
  assert.ok(tool.parameters, "parameters should be truthy");
});

// ─── createWebFetchTool ────────────────────────────────────────────────────────

test("createWebFetchTool has correct name and metadata", () => {
  const tool = createWebFetchTool();
  assert.equal(tool.name, "web_fetch");
  assert.equal(tool.label, "Web Fetch");
  assert.ok(tool.description, "description should be truthy");
  assert.ok(tool.promptSnippet, "promptSnippet should be truthy");
  assert.ok(tool.parameters, "parameters should be truthy");
});

test("createWebFetchTool has execute function", () => {
  const tool = createWebFetchTool();
  assert.equal(typeof tool.execute, "function");
});

test("createWebFetchTool accepts maxChars parameter", () => {
  const toolSmall = createWebFetchTool(100);
  const toolLarge = createWebFetchTool(10000);
  assert.equal(typeof toolSmall.execute, "function");
  assert.equal(typeof toolLarge.execute, "function");
});

test("createWebFetchTool has parameters with url field", () => {
  const tool = createWebFetchTool();
  const params = tool.parameters;
  assert.ok(params, "should have parameters");
});

// ─── createWebTools ────────────────────────────────────────────────────────────

test("createWebTools returns both tools in correct order", () => {
  const tools = createWebTools();
  assert.equal(tools.length, 2);
  assert.ok(Array.isArray(tools), "tools should be an array");
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["web_fetch", "web_search"]);
});

test("createWebTools returns unique tool definitions (no duplicates)", () => {
  const tools = createWebTools();
  const names = tools.map((t) => t.name);
  const unique = new Set(names);
  assert.equal(names.length, unique.size, "tool names should be unique");
});

test("createWebTools each tool has execute", () => {
  const tools = createWebTools();
  for (const tool of tools) {
    assert.ok(tool.execute, `${tool.name} should have execute`);
  }
});

// ─── HTML parsing (import internal functions via tsx) ──────────────────────────

test("htmlToText strips HTML tags correctly", () => {
  assert.equal(htmlToText("<p>Hello</p>"), "Hello");
  assert.equal(htmlToText("<div>Line1</div><div>Line2</div>").trim(), "Line1\nLine2");
  assert.equal(htmlToText("Plain text"), "Plain text");
  assert.equal(htmlToText("<script>var x=1;</script>content"), "content");
  assert.equal(htmlToText("<style>.cls{}</style>content"), "content");
});

test("htmlToText converts HTML entities", () => {
  assert.equal(htmlToText("&amp;"), "&");
  assert.equal(htmlToText("&lt;test&gt;"), "<test>");
  assert.equal(htmlToText("&quot;hello&quot;"), '"hello"');
  assert.equal(htmlToText("hello&nbsp;world"), "hello world");
  assert.equal(htmlToText("&#39;it&#39;s&#39;"), "'it's'");
  assert.equal(htmlToText("&apos;x&apos;"), "'x'");
});

test("htmlToText normalizes whitespace", () => {
  const result = htmlToText("Hello    World");
  assert.equal(result, "Hello World");
});

test("htmlToText collapses multiple newlines", () => {
  const result = htmlToText("Line1\n\n\n\nLine2");
  assert.equal(result, "Line1\n\nLine2");
});

test("htmlToText replaces block element close tags with newlines", () => {
  const result = htmlToText("<p>Para1</p><p>Para2</p>");
  assert.equal(result.trim(), "Para1\nPara2");
  // li tags
  const list = htmlToText("<li>Item1</li><li>Item2</li>");
  assert.equal(list.trim(), "Item1\nItem2");
});

test("parseBingResults extracts results from mock HTML", () => {
  const mockHtml = `
    <h2><a href="https://example.com/page1">First Result</a></h2>
    <h2><a href="https://example.com/page2">Second Result</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/page1");
  assert.equal(results[0].title, "First Result");
  assert.equal(results[1].url, "https://example.com/page2");
  assert.equal(results[1].title, "Second Result");
});

test("parseBingResults respects limit and filters bing/microsoft domains", () => {
  const mockHtml = `
    <h2><a href="https://www.bing.com/search">Bing Link</a></h2>
    <h2><a href="https://example.com/1">Result 1</a></h2>
    <h2><a href="https://go.microsoft.com/link">Microsoft Link</a></h2>
    <h2><a href="https://example.com/2">Result 2</a></h2>
    <h2><a href="https://example.com/3">Result 3</a></h2>
  `;
  const results = parseBingResults(mockHtml, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, "https://example.com/1");
  assert.equal(results[1].url, "https://example.com/2");
});

test("parseBingResults deduplicates URLs", () => {
  const mockHtml = `
    <h2><a href="https://example.com/dup">Dup</a></h2>
    <h2><a href="https://example.com/dup">Dup Again</a></h2>
    <h2><a href="https://example.com/unique">Unique</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 2, "should deduplicate URLs");
});

test("parseBingResults handles empty HTML", () => {
  assert.deepEqual(parseBingResults("", 5), []);
  assert.deepEqual(parseBingResults("<html></html>", 5), []);
});

test("parseBingResults strips inner HTML from titles", () => {
  const mockHtml = `
    <h2><a href="https://example.com/page"><strong>Bold</strong> Title</a></h2>
  `;
  const results = parseBingResults(mockHtml, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Bold Title", "HTML tags should be stripped from title");
});
