import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createRuntime, type Runtime } from "../src/app.ts";
import { SessionManager } from "../src/gui/manager.ts";
import { createGuiServers, listen } from "../src/gui/server.ts";
import type { GuiSettings } from "../src/gui/settings.ts";
import type { ModelOption, ModelSelection } from "../src/providers/catalog.ts";
import type { ProviderSummary } from "../src/providers/store.ts";
import type { SessionMeta } from "../src/session/store.ts";
import { ManualProvider, reply, ScriptedProvider, testRuntime } from "./helpers.ts";

const TOKEN = "provider-settings-test-token";

function offlineRuntime(t: TestContext) {
  // This worker never loads the developer's .env or reads an existing credential value.
  t.mock.method(process, "loadEnvFile", () => {});
  Object.assign(process.env, {
    OPENAI_API_KEY: "", OPENAI_BASE_URL: "", OPENAI_MODEL: "deepseek-chat", OPENAI_STREAM: "false", OPENAI_VISION: "false",
    ANTHROPIC_API_KEY: "", GOOGLE_API_KEY: "", GEMINI_API_KEY: "", DEEPSEEK_API_KEY: "", OPENROUTER_API_KEY: "", TAVILY_API_KEY: "",
    MODEL_CONTEXT_WINDOWS_JSON: "", MODEL_VISION_JSON: "", MODEL_PRICING_JSON: "", AGENT_PROMPT_RULES: "", AGENT_MAX_STEPS: "10", AGENT_MAX_TURN_COST_USD: "0.5", AGENT_MAX_REPEATS: "3",
    PRICE_INPUT_PER_MTOK: "0.3", PRICE_CACHED_INPUT_PER_MTOK: "0.006", PRICE_OUTPUT_PER_MTOK: "1.2",
  });
  const root = mkdtempSync(join(tmpdir(), "rca-provider-settings-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "data");
  const sessionsDir = join(root, "sessions");
  mkdirSync(workspace);
  mkdirSync(dataDir);
  const options = { dataDir, sessionsDir, webSearch: false };
  const runtime = createRuntime("auto", options);
  runtime.makeProvider = (selection) => ({ name: selection.provider, model: selection.model, async complete() { return reply("offline answer"); } });
  return { runtime, options, root, workspace };
}

async function serve(t: TestContext, runtime: Runtime, root?: string) {
  const manager = new SessionManager(runtime);
  const server = createGuiServers(manager, TOKEN).local;
  const port = await listen(server, 0);
  t.after(async () => {
    await manager.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (root) rmSync(root, { recursive: true, force: true });
  });
  function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${port}`, "x-agent-token": TOKEN };
      if (body !== undefined) headers["content-type"] = "application/json";
      const req = request({ host: "127.0.0.1", port, path, method, headers }, (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => { text += chunk.toString(); });
        response.on("end", () => {
          try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as T, text }); }
          catch (error) { reject(error); }
        });
      });
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { manager, call };
}

function selection(meta: Pick<SessionMeta, "provider" | "model" | "thinkEffort">): ModelSelection {
  return { provider: meta.provider ?? "legacy", model: meta.model, thinkEffort: meta.thinkEffort ?? "off" };
}

async function nativeSelection(api: Awaited<ReturnType<typeof serve>>, provider: string): Promise<ModelSelection> {
  const summaries = await api.call<ProviderSummary[]>("GET", "/api/providers");
  const descriptor = summaries.body.find((entry) => entry.id === provider)!;
  const response = await api.call<{ models: ModelOption[] }>("GET", `/api/models?provider=${provider}`);
  assert.equal(response.status, 200);
  const model = response.body.models.find((entry) => entry.id === descriptor.defaultModel)!;
  assert.ok(model);
  return { provider, model: model.id, thinkEffort: model.thinkingLevels.includes("high") ? "high" : model.thinkingLevels[0]! };
}

test("GUI boots without keys, saves masked credentials, and keeps secrets out of responses and session files", async (t) => {
  const fixture = offlineRuntime(t);
  const api = await serve(t, fixture.runtime, fixture.root);
  const before = await api.call<ProviderSummary[]>("GET", "/api/providers");
  assert.equal(before.status, 200);
  assert.equal(before.body.length, 6);
  assert.ok(before.body.every((entry) => !entry.configured && entry.keyMask === ""));
  const secret = "fake-openai-private-key-7182";
  const saved = await api.call<ProviderSummary>("POST", "/api/providers/openai", { apiKey: secret, baseURL: "https://proxy.invalid/v1" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.configured, true);
  assert.equal(saved.body.keyMask, "••••7182");
  assert.equal(saved.body.baseURL, "https://proxy.invalid/v1");
  assert.equal(saved.text.includes(secret), false);
  const models = await api.call<{ models: ModelOption[] }>("GET", "/api/models?provider=openai");
  assert.equal(models.status, 200);
  assert.ok(models.body.models.length > 0);
  assert.ok(models.body.models.every((entry) => entry.provider === "openai" && Array.isArray(entry.thinkingLevels)));
  const created = await api.call<SessionMeta>("POST", "/api/sessions", { workspace: fixture.workspace });
  assert.equal(created.status, 201);
  const id = created.body.id;
  const chosen = await nativeSelection(api, "openai");
  const switched = await api.call<SessionMeta>("POST", `/api/sessions/${id}/settings`, chosen);
  assert.equal(switched.status, 200);
  const providers = await api.call<ProviderSummary[]>("GET", "/api/providers");
  for (const text of [created.text, switched.text, providers.text, fixture.runtime.store.readFile(id, "meta.json"), fixture.runtime.store.readFile(id, "trace.jsonl")]) assert.equal(text.includes(secret), false);
  assert.equal(fixture.runtime.providers!.get("openai").apiKey, secret);
});

test("global defaults are snapshots for new sessions, while session selections survive fork and reload", async (t) => {
  const fixture = offlineRuntime(t);
  const api = await serve(t, fixture.runtime, fixture.root);
  const first = await nativeSelection(api, "openai");
  const second = await nativeSelection(api, "anthropic");
  const patch = (value: ModelSelection) => ({ defaultProvider: value.provider, defaultModel: value.model, defaultThinkEffort: value.thinkEffort });
  assert.equal((await api.call("POST", "/api/settings", patch(first))).status, 200);
  const a = await api.call<SessionMeta>("POST", "/api/sessions", { workspace: fixture.workspace });
  assert.equal(a.status, 201);
  assert.deepEqual(selection(a.body), first);
  assert.equal((await api.call("POST", "/api/settings", patch(second))).status, 200);
  assert.deepEqual(selection((await api.call<SessionMeta>("GET", `/api/sessions/${a.body.id}`)).body), first);
  const b = await api.call<SessionMeta>("POST", "/api/sessions", { workspace: fixture.workspace });
  assert.deepEqual(selection(b.body), second);
  const third = await nativeSelection(api, "google");
  assert.equal((await api.call("POST", `/api/sessions/${a.body.id}/settings`, third)).status, 200);
  assert.deepEqual(selection((await api.call<SessionMeta>("GET", `/api/sessions/${b.body.id}`)).body), second);
  const forked = await api.call<{ meta: SessionMeta }>("POST", `/api/sessions/${a.body.id}/fork`, {});
  assert.equal(forked.status, 201);
  assert.deepEqual(selection(forked.body.meta), third);
  await api.manager.shutdown();
  const reloaded = createRuntime("auto", fixture.options);
  const reopened = new SessionManager(reloaded);
  try {
    assert.deepEqual(selection(reopened.get(forked.body.meta.id).info), third);
    const settings = reloaded.settings.get();
    assert.deepEqual({ provider: settings.defaultProvider, model: settings.defaultModel, thinkEffort: settings.defaultThinkEffort }, second);
  } finally { await reopened.shutdown(); }
});

test("invalid provider, model and effort settings reject the entire update", async (t) => {
  const fixture = offlineRuntime(t);
  const api = await serve(t, fixture.runtime, fixture.root);
  const created = await api.call<SessionMeta>("POST", "/api/sessions", { workspace: fixture.workspace });
  const id = created.body.id;
  const original = fixture.runtime.store.getMeta(id);
  const chosen = await nativeSelection(api, "openai");
  const invalid = [{ provider: "unknown" }, { provider: null }, { ...chosen, model: "not-a-real-model" }, { ...chosen, thinkEffort: "ultra" }, { ...chosen, thinkEffort: 2 }];
  for (const update of invalid) {
    const response = await api.call("POST", `/api/sessions/${id}/settings`, { ...update, approvalMode: "ask", notifications: true, budgetUsd: 123 });
    assert.equal(response.status, 400);
    assert.deepEqual(fixture.runtime.store.getMeta(id), original);
  }
  const before = (await api.call<GuiSettings>("GET", "/api/settings")).body;
  for (const update of [{ defaultProvider: "unknown" }, { defaultProvider: chosen.provider, defaultModel: "missing" }, { defaultProvider: chosen.provider, defaultModel: chosen.model, defaultThinkEffort: "ultra" }]) {
    assert.equal((await api.call("POST", "/api/settings", { ...update, notifications: !before.notifications })).status, 400);
    assert.deepEqual((await api.call<GuiSettings>("GET", "/api/settings")).body, before);
  }
  assert.equal((await api.call("GET", "/api/models?provider=unknown")).status, 400);
});

test("a busy session rejects selection changes without mutating its settings", async (t) => {
  const fixture = offlineRuntime(t);
  const controlled = new ManualProvider();
  fixture.runtime.makeProvider = () => controlled;
  const api = await serve(t, fixture.runtime, fixture.root);
  const created = await api.call<SessionMeta>("POST", "/api/sessions", { workspace: fixture.workspace });
  const id = created.body.id;
  assert.equal((await api.call("POST", `/api/sessions/${id}/message`, { text: "wait for a response" })).status, 202);
  await controlled.requested(1);
  const before = fixture.runtime.store.getMeta(id);
  const chosen = await nativeSelection(api, "openai");
  const response = await api.call("POST", `/api/sessions/${id}/settings`, { ...chosen, approvalMode: "ask", notifications: true });
  assert.equal(response.status, 409);
  assert.deepEqual(fixture.runtime.store.getMeta(id), before);
  assert.equal((await api.call("POST", `/api/sessions/${id}/stop`, {})).status, 200);
  await api.manager.get(id).whenIdle();
  assert.equal((await api.call("POST", `/api/sessions/${id}/settings`, chosen)).status, 200);
});

test("credential updates refresh an existing session's provider on the next turn", async (t) => {
  const fixture = offlineRuntime(t);
  const executions: { selection: ModelSelection; key: string }[] = [];
  fixture.runtime.makeProvider = (value) => {
    const connection = fixture.runtime.providers!.get(value.provider);
    return { name: value.provider, model: value.model, async complete() { executions.push({ selection: { ...value }, key: connection.apiKey }); return reply("offline answer"); } };
  };
  const api = await serve(t, fixture.runtime, fixture.root);
  const chosen = await nativeSelection(api, "openai");
  assert.equal((await api.call("POST", "/api/providers/openai", { apiKey: "fake-first-key-1001" })).status, 200);
  assert.equal((await api.call("POST", "/api/settings", { defaultProvider: chosen.provider, defaultModel: chosen.model, defaultThinkEffort: chosen.thinkEffort })).status, 200);
  const created = await api.call<SessionMeta>("POST", "/api/sessions", { workspace: fixture.workspace });
  const id = created.body.id;
  assert.equal((await api.call("POST", `/api/sessions/${id}/message`, { text: "first" })).status, 202);
  await api.manager.get(id).whenIdle();
  assert.equal((await api.call("POST", "/api/providers/openai", { apiKey: "fake-second-key-1002" })).status, 200);
  assert.equal((await api.call("POST", `/api/sessions/${id}/message`, { text: "second" })).status, 202);
  await api.manager.get(id).whenIdle();
  assert.deepEqual(executions, [{ selection: chosen, key: "fake-first-key-1001" }, { selection: chosen, key: "fake-second-key-1002" }]);
  const stored = fixture.runtime.store.readFile(id, "meta.json") + fixture.runtime.store.readFile(id, "trace.jsonl");
  assert.doesNotMatch(stored, /fake-first-key-1001|fake-second-key-1002/);
});

test("legacy model-only settings remain compatible with the old runtime model-list API", async (t) => {
  const runtime = testRuntime(new ScriptedProvider([]));
  runtime.listModels = async () => ["scripted", "legacy-next"];
  const api = await serve(t, runtime);
  assert.deepEqual((await api.call<{ models: string[] }>("GET", "/api/models")).body.models, ["scripted", "legacy-next"]);
  assert.equal((await api.call("POST", "/api/settings", { defaultModel: "legacy-next" })).status, 200);
  const created = await api.call<SessionMeta>("POST", "/api/sessions", { workspace: runtime.store.root });
  assert.deepEqual(selection(created.body), { provider: "legacy", model: "legacy-next", thinkEffort: "off" });
  const updated = await api.call<SessionMeta>("POST", `/api/sessions/${created.body.id}/settings`, { model: "scripted" });
  assert.equal(updated.status, 200);
  assert.deepEqual(selection(updated.body), { provider: "legacy", model: "scripted", thinkEffort: "off" });
  assert.equal((await api.call<GuiSettings>("GET", "/api/settings")).body.defaultModel, "legacy-next");
});
