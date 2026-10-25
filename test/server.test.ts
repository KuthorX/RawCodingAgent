import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SessionManager } from "../src/gui/manager.ts";
import { createGuiServers, listen } from "../src/gui/server.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

const TOKEN = "test-token";
let port = 0;
let close: () => void = () => {};
let workspace = "";
let runtime: ReturnType<typeof testRuntime>;
// Stands in for the native dialog: each test sets what the next "user choice" is.
let nextPick: () => Promise<string | null> = async () => null;

before(async () => {
  runtime = testRuntime(new ScriptedProvider([reply("hello")]));
  workspace = runtime.store.root;
  const server = createGuiServers(new SessionManager(runtime), TOKEN, { pickFolder: () => nextPick() }).local;
  port = await listen(server, 0);
  close = () => server.close();
});
after(() => close());

interface Res {
  status: number;
  body: string;
}

function call(method: string, path: string, opts: { body?: unknown; token?: string | null; host?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: opts.host ?? `127.0.0.1:${port}` };
    const token = opts.token === undefined ? TOKEN : opts.token;
    if (token) headers["x-agent-token"] = token;
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

function readSsePrefix(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = request({ host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (!settled && body.includes("event: replay_done")) {
          settled = true;
          req.destroy();
          resolve(body);
        }
      });
      res.on("error", (err) => { if (!settled) reject(err); });
    });
    req.on("error", (err) => { if (!settled) reject(err); });
    req.end();
  });
}

test("rejects foreign Host headers (DNS rebinding)", async () => {
  assert.equal((await call("GET", "/api/sessions", { host: `evil.example:${port}` })).status, 403);
});

test("pages load without a token, APIs require it", async () => {
  assert.equal((await call("GET", "/", { token: null })).status, 200);
  assert.equal((await call("GET", "/stats", { token: null })).status, 200);
  assert.equal((await call("GET", "/raw", { token: null })).status, 200);
  assert.equal((await call("GET", "/api/sessions", { token: null })).status, 401);
  assert.equal((await call("GET", "/api/sessions", { token: "wrong" })).status, 401);
  assert.equal((await call("GET", `/api/sessions?token=${TOKEN}`, { token: null })).status, 200);
  assert.equal((await call("POST", `/api/sessions?token=${TOKEN}`, { token: null, body: {} })).status, 401);
});

test("create a session, run a turn, read stats and raw files", async () => {
  const created = await call("POST", "/api/sessions", { body: { workspace } });
  assert.equal(created.status, 201);
  const { id, workspace: ws } = JSON.parse(created.body) as { id: string; workspace: string };
  assert.equal(ws, workspace);

  assert.equal((await call("POST", `/api/sessions/${id}/message`, { body: { text: "hi" } })).status, 202);
  for (let i = 0; i < 50 && JSON.parse((await call("GET", `/api/sessions/${id}`)).body).busy; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  const stats = JSON.parse((await call("GET", `/api/sessions/${id}/stats`)).body) as { totals: { turns: number } };
  assert.equal(stats.totals.turns, 1);
  const raw = await call("GET", `/api/sessions/${id}/file?name=events.jsonl`);
  assert.match(raw.body, /"type":"turn_end"/);

  const list = JSON.parse((await call("GET", "/api/sessions")).body) as { id: string; title: string }[];
  assert.equal(list.find((s) => s.id === id)?.title, "hi");
});

test("manual compaction of an empty session does not leave it busy", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  assert.equal((await call("POST", `/api/sessions/${id}/message`, { body: { text: "/compact" } })).status, 202);
  for (let i = 0; i < 50 && JSON.parse((await call("GET", `/api/sessions/${id}`)).body).busy; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const info = JSON.parse((await call("GET", `/api/sessions/${id}`)).body) as { busy: boolean };
  assert.equal(info.busy, false);
  const events = (await call("GET", `/api/sessions/${id}/file?name=events.jsonl`)).body;
  assert.match(events, /"type":"compaction_start"/);
  assert.match(events, /"type":"compacted"/);
});

test("notification events use one multiplexed stream", async () => {
  await call("POST", "/api/sessions", { body: { workspace } });
  const stream = await readSsePrefix(`/events?token=${TOKEN}`);
  assert.match(stream, /event: hello/);
  assert.match(stream, /event: replay_done/);
  assert.match(stream, /sessionId":"[0-9a-f-]+"/);
});

test("validates ids, file names and bodies", async () => {
  assert.equal((await call("GET", "/api/sessions/..%2F..%2Fetc/stats")).status, 400);
  assert.equal((await call("GET", "/api/sessions/20260101-000000-abcdef")).status, 404);
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  assert.equal((await call("GET", `/api/sessions/${id}/file?name=../../.env`)).status, 400);
  assert.equal((await call("POST", `/api/sessions/${id}/message`, { body: { text: "" } })).status, 400);
  assert.equal((await call("POST", `/api/sessions/${id}/approve`, { body: { id: "x" } })).status, 400);
  assert.equal((await call("POST", "/api/sessions", { body: { workspace: "/definitely/not/here" } })).status, 400);
  assert.equal((await call("POST", "/api/sessions", { body: {} })).status, 400);
});

test("approval mode can be set at creation and changed per session", async () => {
  const created = JSON.parse((await call("POST", "/api/sessions", { body: { workspace, approvalMode: "auto" } })).body) as {
    id: string;
    approvalMode: string;
  };
  assert.equal(created.approvalMode, "auto");
  const plain = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string; approvalMode: string };
  assert.equal(plain.approvalMode, "ask");

  const changed = await call("POST", `/api/sessions/${plain.id}/settings`, { body: { approvalMode: "auto" } });
  assert.equal(JSON.parse(changed.body).approvalMode, "auto");
  assert.equal((await call("POST", `/api/sessions/${plain.id}/settings`, { body: { approvalMode: "yolo" } })).status, 400);
  assert.equal((await call("POST", "/api/sessions", { body: { approvalMode: 1 } })).status, 400);
  assert.equal((await call("POST", `/api/sessions/${plain.id}/settings`, { token: null, body: { approvalMode: "auto" } })).status, 401);
});

test("stop is a no-op when idle", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  const res = await call("POST", `/api/sessions/${id}/stop`, { body: {} });
  assert.deepEqual(JSON.parse(res.body), { ok: true, stopped: false });
});

test("projects are opened, listed with their workspaces, and removed without touching sessions", async () => {
  const added = await call("POST", "/api/projects", { body: { path: workspace + "/" } });
  assert.equal(added.status, 201);
  assert.equal(JSON.parse(added.body).path, workspace);
  const list = JSON.parse((await call("GET", "/api/projects")).body) as { path: string; repo: string | null; workspaces: { path: string; main: boolean }[] }[];
  const entry = list.find((p) => p.path === workspace)!;
  assert.equal(entry.repo, null);
  assert.deepEqual(entry.workspaces.map((w) => [w.path, w.main]), [[workspace, true]]);
  assert.equal((await call("POST", "/api/projects", { body: { path: "/definitely/not/here" } })).status, 400);
  assert.equal((await call("POST", "/api/projects", { body: {} })).status, 400);
  assert.equal((await call("POST", "/api/projects/workspaces", { body: { project: workspace } })).status, 400); // not a git repo
  assert.equal((await call("POST", "/api/projects/workspaces", { body: { project: "/nope" } })).status, 404);

  const before = (JSON.parse((await call("GET", "/api/sessions")).body) as unknown[]).length;
  const removed = await call("POST", "/api/projects/remove", { body: { path: workspace } });
  assert.deepEqual(JSON.parse(removed.body), { ok: true, removed: true });
  assert.equal((JSON.parse((await call("GET", "/api/sessions")).body) as unknown[]).length, before);
  assert.equal((JSON.parse((await call("GET", "/api/projects")).body) as unknown[]).length, 0);
});

test("picking a folder opens it as a project; cancel and a missing folder are handled", async () => {
  nextPick = async () => workspace;
  const picked = await call("POST", "/api/projects/pick", { body: {} });
  assert.equal(picked.status, 201);
  assert.equal((JSON.parse(picked.body) as { path: string }).path, workspace);

  nextPick = async () => null;
  assert.deepEqual(JSON.parse((await call("POST", "/api/projects/pick", { body: {} })).body), { cancelled: true });

  nextPick = async () => "/definitely/not/here";
  assert.equal((await call("POST", "/api/projects/pick", { body: {} })).status, 400);

  assert.equal((await call("POST", "/api/projects/pick", { body: {}, token: null })).status, 401);
  await call("POST", "/api/projects/remove", { body: { path: workspace } });
});

test("only one folder dialog at a time", async () => {
  let release: (path: string | null) => void = () => {};
  nextPick = () => new Promise((resolve) => (release = resolve));
  const first = call("POST", "/api/projects/pick", { body: {} });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await call("POST", "/api/projects/pick", { body: {} })).status, 409);
  release(null);
  assert.equal((await first).status, 200);
});

test("fork creates a new session; 404 for an unknown one; a new workspace needs git", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  const res = await call("POST", `/api/sessions/${id}/fork`, { body: {} });
  assert.equal(res.status, 201);
  const fork = (JSON.parse(res.body) as { meta: { id: string; forkedFrom: { id: string } } }).meta;
  assert.notEqual(fork.id, id);
  assert.equal(fork.forkedFrom.id, id);
  assert.equal((await call("GET", `/api/sessions/${fork.id}`)).status, 200);
  assert.equal((await call("POST", "/api/sessions/20260101-000000-abcdef/fork", { body: {} })).status, 404);
  assert.equal((await call("POST", `/api/sessions/${id}/fork`, { body: { newWorkspace: { name: "x" } } })).status, 400);
});

test("message with pasted images: saved, served back, validated", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  const png = `data:image/png;base64,${Buffer.from("89504e470d0a1a0a", "hex").toString("base64")}`;
  assert.equal((await call("POST", `/api/sessions/${id}/message`, { body: { text: "", images: ["data:text/html;base64,PGI+"] } })).status, 400);
  assert.equal((await call("POST", `/api/sessions/${id}/message`, { body: { text: "x", images: Array(9).fill(png) } })).status, 400);
  assert.equal((await call("POST", `/api/sessions/${id}/message`, { body: { text: "", images: [png] } })).status, 202);
  for (let i = 0; i < 50 && JSON.parse((await call("GET", `/api/sessions/${id}`)).body).busy; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  const events = (await call("GET", `/api/sessions/${id}/file?name=events.jsonl`)).body;
  const name = (JSON.parse(events.split("\n")[0]!) as { images: string[] }).images[0]!;
  const img = await call("GET", `/api/sessions/${id}/attachment?name=${name}`);
  assert.equal(img.status, 200);
  assert.equal((await call("GET", `/api/sessions/${id}/attachment?name=..%2Fmeta.json`)).status, 400);
  assert.equal((await call("GET", `/api/sessions/${id}/attachment?name=1-abcdef.png`)).status, 404);
});

test("settings: per-session limits and budget are validated and stored; caps on projects", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  const set = (body: unknown) => call("POST", `/api/sessions/${id}/settings`, { body });
  assert.equal((await set({})).status, 400);
  assert.equal((await set({ limits: { maxSteps: 0 } })).status, 400);
  assert.equal((await set({ limits: { maxTurnCostUsd: -1 } })).status, 400);
  assert.equal((await set({ budgetUsd: "1" })).status, 400);
  assert.equal((await set({ model: "missing-model" })).status, 400);
  assert.equal((await set({ model: "scripted" })).status, 200);
  const ok = JSON.parse((await set({ limits: { maxSteps: null, maxTurnCostUsd: 1 }, budgetUsd: 3 })).body);
  assert.deepEqual([ok.limits, ok.budgetUsd, ok.budget.scope], [{ maxSteps: null, maxTurnCostUsd: 1 }, 3, "session"]);
  assert.deepEqual(JSON.parse((await call("GET", "/api/projects/limits")).body), { maxSteps: 10, maxTurnCostUsd: null });

  await call("POST", "/api/projects", { body: { path: workspace } });
  assert.equal((await call("POST", "/api/projects/budget", { body: { project: workspace, budgetUsd: -2 } })).status, 400);
  assert.equal((await call("POST", "/api/projects/budget", { body: { project: workspace, budgetUsd: 4 } })).status, 200);
  const project = (JSON.parse((await call("GET", "/api/projects")).body) as { path: string; budgetUsd: number }[]).find((p) => p.path === workspace)!;
  assert.equal(project.budgetUsd, 4);
  await call("POST", "/api/projects/remove", { body: { path: workspace } });
});

test("archive hides nothing server-side but is listed; delete removes the session for good", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  assert.equal((await call("POST", `/api/sessions/${id}/archive`, { body: {} })).status, 400);
  assert.equal(JSON.parse((await call("POST", `/api/sessions/${id}/archive`, { body: { archived: true } })).body).archived, true);
  const listed = (JSON.parse((await call("GET", "/api/sessions")).body) as { id: string; archived?: boolean }[]).find((s) => s.id === id);
  assert.equal(listed?.archived, true);
  assert.equal(JSON.parse((await call("POST", `/api/sessions/${id}/archive`, { body: { archived: false } })).body).archived, false);

  assert.equal((await call("POST", `/api/sessions/${id}/delete`, { body: {} })).status, 200);
  assert.equal((await call("GET", `/api/sessions/${id}`)).status, 404);
  assert.ok(!(JSON.parse((await call("GET", "/api/sessions")).body) as { id: string }[]).some((s) => s.id === id));
  assert.equal((await call("POST", `/api/sessions/${id}/delete`, { body: {} })).status, 404);
});

test("search matches titles, user messages and replies, not tool calls", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };
  runtime.store.updateMeta(id, { title: "Refactor the Parser" });
  runtime.store.appendEvent(id, { type: "user", text: "please look at zebra handling" });
  runtime.store.appendEvent(id, { type: "assistant_text", text: "Done: the giraffe case is fixed." });
  runtime.store.appendEvent(id, { type: "tool_call", call: { id: "c1", name: "bash", input: { command: "grep okapi" } } });
  const search = async (q: string) => JSON.parse((await call("GET", `/api/sessions/search?q=${encodeURIComponent(q)}`)).body) as {
    id: string;
    matches: { role: string; snippet: string }[];
  }[];
  assert.deepEqual((await search("parser")).map((h) => [h.id, h.matches.length]), [[id, 0]]);
  assert.deepEqual((await search("ZEBRA")).find((h) => h.id === id)?.matches, [{ role: "user", snippet: "please look at zebra handling" }]);
  assert.equal((await search("giraffe")).find((h) => h.id === id)?.matches[0]?.role, "assistant");
  assert.deepEqual(await search("okapi"), []);
  assert.deepEqual(await search("  "), []);
});

test("GUI settings: new sessions auto-approve by default, can be switched off", async () => {
  assert.deepEqual(JSON.parse((await call("GET", "/api/settings")).body), { newSessionApproval: "auto", defaultProvider: "legacy", defaultModel: "scripted", defaultThinkEffort: "off", notifications: false, compactionTokens: 400000 });
  assert.equal((await call("POST", "/api/settings", { body: { newSessionApproval: "yolo" } })).status, 400);
  assert.deepEqual(JSON.parse((await call("POST", "/api/settings", { body: { newSessionApproval: "ask" } })).body), { newSessionApproval: "ask", defaultProvider: "legacy", defaultModel: "scripted", defaultThinkEffort: "off", notifications: false, compactionTokens: 400000 });
  assert.deepEqual(JSON.parse((await call("POST", "/api/settings", { body: { notifications: true, compactionTokens: 123000 } })).body), { newSessionApproval: "ask", defaultProvider: "legacy", defaultModel: "scripted", defaultThinkEffort: "off", notifications: true, compactionTokens: 123000 });
  assert.deepEqual(JSON.parse((await call("GET", "/api/settings")).body), { newSessionApproval: "ask", defaultProvider: "legacy", defaultModel: "scripted", defaultThinkEffort: "off", notifications: true, compactionTokens: 123000 });
  assert.equal((await call("POST", "/api/settings", { body: { defaultModel: "missing-model" } })).status, 400);
  assert.equal((await call("POST", "/api/settings", { body: { defaultModel: "scripted" } })).status, 200);
  assert.equal((await call("GET", "/api/settings", { token: null })).status, 401);
});

test("diff: a git workspace returns uncommitted changes; a plain directory says so", async () => {
  const ws = tempWorkspace();
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", ...args], { cwd: ws });
  git("init", "-q");
  writeFileSync(join(ws, "a.txt"), "first\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  writeFileSync(join(ws, "a.txt"), "second\n");
  writeFileSync(join(ws, "new.txt"), "new\n");

  const session = JSON.parse((await call("POST", "/api/sessions", { body: { workspace: ws, approvalMode: "auto" } })).body) as { id: string };
  const diff = JSON.parse((await call("GET", `/api/sessions/${session.id}/diff`)).body) as { isRepo: boolean; diff: string; files: { path: string }[] };
  assert.equal(diff.isRepo, true);
  assert.match(diff.diff, /\+second/);
  assert.match(diff.diff, /new\.txt/);
  assert.deepEqual(diff.files.map((f) => f.path).sort(), ["a.txt", "new.txt"]);

  const plain = tempWorkspace();
  const plainSession = JSON.parse((await call("POST", "/api/sessions", { body: { workspace: plain, approvalMode: "auto" } })).body) as { id: string };
  const none = JSON.parse((await call("GET", `/api/sessions/${plainSession.id}/diff`)).body) as { isRepo: boolean };
  assert.equal(none.isRepo, false);
});

test("plan and loop endpoints edit the plan and switch modes", async () => {
  const { id } = JSON.parse((await call("POST", "/api/sessions", { body: { workspace } })).body) as { id: string };

  const saved = JSON.parse((await call("POST", `/api/sessions/${id}/plan`, { body: { items: [{ text: "read", status: "completed" }, { text: "edit", status: "in_progress" }] } })).body) as { items: { text: string }[] };
  assert.deepEqual(saved.items.map((item) => item.text), ["read", "edit"]);
  assert.deepEqual((JSON.parse((await call("GET", `/api/sessions/${id}`)).body) as { plan: { text: string }[] }).plan.map((item) => item.text), ["read", "edit"]);
  assert.equal((await call("POST", `/api/sessions/${id}/plan`, { body: { items: [{ text: "", status: "pending" }] } })).status, 400);
  assert.equal((await call("POST", `/api/sessions/${id}/plan`, { body: { items: [{ text: "x", status: "nope" }] } })).status, 400);

  assert.equal((JSON.parse((await call("POST", `/api/sessions/${id}/mode`, { body: { mode: "plan" } })).body) as { mode: string }).mode, "plan");
  assert.equal((await call("POST", `/api/sessions/${id}/mode`, { body: { mode: "wat" } })).status, 400);
  assert.equal((await call("POST", `/api/sessions/${id}/mode`, { body: { mode: "loop", max: 0 } })).status, 400);

  const loop = JSON.parse((await call("POST", `/api/sessions/${id}/mode`, { body: { mode: "loop", prompt: "continue please", max: 3 } })).body) as { mode: string; loopPrompt: string; loopMax: number; loopCount: number };
  assert.deepEqual([loop.mode, loop.loopPrompt, loop.loopMax, loop.loopCount], ["loop", "continue please", 3, 0]);
  assert.equal((JSON.parse((await call("POST", `/api/sessions/${id}/mode`, { body: { mode: "normal" } })).body) as { mode?: string }).mode, undefined);
});
