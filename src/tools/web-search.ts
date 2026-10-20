import { requireString, ToolError, type Tool } from "./types.ts";

const TIMEOUT_MS = 20_000;
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchBackend {
  name: string;
  search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]>;
}

type Fetch = typeof fetch;

async function getJson(fetchImpl: Fetch, url: string, init: RequestInit, backend: string): Promise<unknown> {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  if (!res.ok) throw new ToolError(`${backend} search failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError(`${backend} search returned invalid JSON: ${text.slice(0, 300)}`);
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

// https://docs.tavily.com/documentation/api-reference/endpoint/search
export function tavilyBackend(apiKey: string, fetchImpl: Fetch = fetch): SearchBackend {
  return {
    name: "Tavily",
    async search(query, count, signal) {
      const data = (await getJson(fetchImpl, "https://api.tavily.com/search", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
        signal,
      }, "Tavily")) as { results?: unknown[] };
      return (data.results ?? []).map((r) => {
        const item = r as Record<string, unknown>;
        return { title: str(item.title), url: str(item.url), snippet: str(item.content) };
      });
    },
  };
}

// No TAVILY_API_KEY = no web_search tool.
export function searchBackendFromEnv(env: NodeJS.ProcessEnv, fetchImpl: Fetch = fetch): SearchBackend | null {
  return env.TAVILY_API_KEY ? tavilyBackend(env.TAVILY_API_KEY, fetchImpl) : null;
}

export function formatResults(results: readonly SearchResult[]): string {
  if (results.length === 0) return "No results.";
  return results.map((r, i) => `${i + 1}. ${r.title || "(no title)"}\n   ${r.url}\n   ${r.snippet.replace(/\s+/g, " ").trim()}`).join("\n\n");
}

// Read-only, so no approval (D6); the query does leave the machine, which the description tells the model.
export function webSearchTool(backend: SearchBackend): Tool {
  return {
    spec: {
      name: "web_search",
      description:
        `Search the web (${backend.name}) and return the top results with title, URL and a text snippet. ` +
        "Use it for library documentation, error messages, API changes and other facts that are not in the workspace. " +
        "The query is sent to an external service: never put secrets or private code in it.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          max_results: { type: "integer", description: `Number of results, 1-${MAX_RESULTS} (default ${DEFAULT_RESULTS})` },
        },
        required: ["query"],
      },
    },
    dangerous: false,
    async run(input, ctx) {
      const query = requireString(input, "query").trim();
      if (!query) throw new ToolError('"query" must not be empty');
      const n = input.max_results ?? DEFAULT_RESULTS;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_RESULTS) {
        throw new ToolError(`"max_results" must be an integer from 1 to ${MAX_RESULTS}`);
      }
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      try {
        return formatResults(await backend.search(query, n, signal));
      } catch (err) {
        if (err instanceof ToolError) throw err;
        if (timeout.aborted) throw new ToolError(`${backend.name} search timed out after ${TIMEOUT_MS / 1000}s`);
        if (ctx.signal?.aborted) throw err;
        throw new ToolError(`${backend.name} search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
