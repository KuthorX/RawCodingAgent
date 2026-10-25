import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntime } from "../src/app.ts";
import { BudgetedProvider, runAgentTurn } from "../src/eval/runner.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import type { Provider } from "../src/types.ts";
import { reply, tempWorkspace, testRuntime } from "./helpers.ts";

test("clearing the legacy endpoint applies to model discovery and completion without reviving its environment URL", async (t) => {
  t.mock.method(process, "loadEnvFile", () => {});
  Object.assign(process.env, {
    OPENAI_API_KEY: "fake-endpoint-review-key", OPENAI_BASE_URL: "http://127.0.0.1:1/old-endpoint", OPENAI_MODEL: "test-model",
    OPENAI_STREAM: "false", MODEL_PRICING_JSON: "", MODEL_CONTEXT_WINDOWS_JSON: "", MODEL_VISION_JSON: "", TAVILY_API_KEY: "",
  });
  const urls: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    const body = url.endsWith("/models")
      ? { object: "list", data: [{ id: "test-model", object: "model" }] }
      : { id: "test-completion", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  });
  const root = mkdtempSync(join(tmpdir(), "rca-endpoint-clear-"));
  try {
    const runtime = createRuntime("auto", { dataDir: root, sessionsDir: join(root, "sessions"), webSearch: false });
    runtime.providers!.update("legacy", { baseURL: null });
    assert.equal(runtime.providers!.list().find((entry) => entry.id === "legacy")!.baseURL, "");
    assert.deepEqual(await runtime.listModels!(), ["test-model"]);
    const provider = runtime.makeProvider!({ provider: "legacy", model: "test-model", thinkEffort: "off" });
    assert.equal((await provider.complete({ system: "", messages: [], tools: [] })).message.text, "ok");
    assert.deepEqual(urls, ["https://api.openai.com/v1/models", "https://api.openai.com/v1/chat/completions"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reported native usage on an error contributes to the same budget as later successful requests", async () => {
  let requests = 0;
  let stops = 0;
  const error = Object.assign(new Error("ECONNRESET"), {
    code: "ECONNRESET", usage: { inputTokens: 1000, cachedInputTokens: 500, cacheWriteTokens: 200, outputTokens: 10, costUsd: 0.002 },
  });
  const inner: Provider = {
    name: "native", model: "native",
    async complete() {
      if (++requests === 1) throw error;
      return { ...reply("ok"), usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.002 } };
    },
  };
  const provider = new BudgetedProvider(inner, DEFAULT_PRICING, 0.003, () => { stops++; });
  const request = { system: "", messages: [], tools: [] };
  await assert.rejects(provider.complete(request), (caught) => caught === error);
  assert.equal(provider.spentUsd, 0.002);
  assert.equal(stops, 0);
  await provider.complete(request);
  assert.equal(provider.spentUsd, 0.004);
  assert.equal(stops, 1);
});

test("evaluation does not retry after reported partial usage has exhausted its task budget", async () => {
  let requests = 0;
  const inner: Provider = {
    name: "native", model: "native",
    async complete() {
      if (++requests === 1) throw Object.assign(new Error("ECONNRESET"), {
        code: "ECONNRESET", usage: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 0, costUsd: 0.02, unexpectedSecret: "fake-usage-secret" },
      });
      return reply("must not be requested");
    },
  };
  const runtime = testRuntime(inner);
  const makeDeps = runtime.makeDeps;
  runtime.makeDeps = (meta, hooks) => ({ ...makeDeps(meta, hooks), retryDelaysMs: [0] });
  const turn = await runAgentTurn(runtime, { workspace: tempWorkspace(), title: "partial usage", prompt: "inspect", budget: { maxSteps: 10, maxCostUsd: 0.005 } });
  assert.equal(requests, 1);
  assert.notEqual(turn.finishReason, "end_turn");
  assert.equal(turn.costUsd, 0.02);
  const trace = runtime.store.readFile(turn.sessionId, "trace.jsonl");
  assert.doesNotMatch(trace, /fake-usage-secret|unexpectedSecret/);
});
