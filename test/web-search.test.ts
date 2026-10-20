import assert from "node:assert/strict";
import test from "node:test";
import { ToolError } from "../src/tools/types.ts";
import { formatResults, searchBackendFromEnv, tavilyBackend, webSearchTool } from "../src/tools/web-search.ts";

// Records the request and answers with a canned response.
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const ctx = { workspace: "." };

test("web_search: Tavily request and formatted results", async () => {
  const f = fakeFetch(200, { results: [{ title: "Node 24 release", url: "https://nodejs.org/x", content: "Node.js 24\n  is out", score: 0.9 }] });
  const tool = webSearchTool(tavilyBackend("tvly-key", f.impl));
  const out = await tool.run({ query: "node 24 release", max_results: 3 }, ctx);
  assert.equal(out, "1. Node 24 release\n   https://nodejs.org/x\n   Node.js 24 is out");
  assert.equal(f.calls[0].url, "https://api.tavily.com/search");
  assert.equal((f.calls[0].init.headers as Record<string, string>).authorization, "Bearer tvly-key");
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { query: "node 24 release", max_results: 3, search_depth: "basic" });
  assert.equal(tool.dangerous, false);
});

test("web_search: bad input and HTTP errors become tool errors", async () => {
  const ok = webSearchTool(tavilyBackend("k", fakeFetch(200, { results: [] }).impl));
  await assert.rejects(ok.run({ query: "  " }, ctx), ToolError);
  await assert.rejects(ok.run({ query: "x", max_results: 50 }, ctx), ToolError);
  assert.equal(await ok.run({ query: "x" }, ctx), "No results.");
  const denied = webSearchTool(tavilyBackend("k", fakeFetch(401, { detail: "invalid key" }).impl));
  await assert.rejects(denied.run({ query: "x" }, ctx), (err: unknown) => err instanceof ToolError && /HTTP 401.*invalid key/.test(err.message));
});

test("web_search: enabled only when TAVILY_API_KEY is set", () => {
  assert.equal(searchBackendFromEnv({}), null);
  assert.equal(searchBackendFromEnv({ TAVILY_API_KEY: "k" })?.name, "Tavily");
  assert.equal(formatResults([{ title: "", url: "u", snippet: "s" }]), "1. (no title)\n   u\n   s");
});
