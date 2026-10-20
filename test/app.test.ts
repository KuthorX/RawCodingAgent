import assert from "node:assert/strict";
import test from "node:test";
import { createRuntime } from "../src/app.ts";
import { tempWorkspace } from "./helpers.ts";

test("createRuntime: the session event records the prompt and tools; the search key leaves process.env", () => {
  process.env.OPENAI_API_KEY ??= "test-key";
  process.env.TAVILY_API_KEY = "tvly-test";
  process.env.AGENT_PROMPT_RULES = "tools";
  try {
    const runtime = createRuntime("ask", { sessionsDir: tempWorkspace() });
    // bash inherits process.env; the key now lives only in the tool.
    assert.equal(process.env.TAVILY_API_KEY, undefined);
    const meta = runtime.store.create(tempWorkspace(), runtime.model, "ask");
    const deps = runtime.makeDeps(meta, { approvalMode: () => "ask", confirm: async () => true });
    assert.ok(deps.tools.some((t) => t.spec.name === "web_search"));
    const session = runtime.store.readFile(meta.id, "trace.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .find((r) => r.type === "event" && r.event === "session");
    assert.deepEqual(session.data.promptRules, ["tools"]);
    assert.ok(session.data.tools.includes("web_search") && session.data.tools.includes("bash"));
    assert.equal(session.data.system, deps.system);
    assert.match(session.data.system, /Use the dedicated tools for files/);

    process.env.TAVILY_API_KEY = "tvly-test";
    const offline = createRuntime("auto", { sessionsDir: tempWorkspace(), webSearch: false });
    const m2 = offline.store.create(tempWorkspace(), offline.model, "auto");
    assert.ok(!offline.makeDeps(m2, { approvalMode: () => "auto", confirm: async () => true }).tools.some((t) => t.spec.name === "web_search"));
  } finally {
    delete process.env.TAVILY_API_KEY;
    delete process.env.AGENT_PROMPT_RULES;
  }
});
