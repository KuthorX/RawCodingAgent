import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

import { createRuntime } from "../src/app.ts";
import { SessionManager } from "../src/gui/manager.ts";
import { createGuiServers, listen } from "../src/gui/server.ts";
import { SessionStore } from "../src/session/store.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = join(ROOT, "docs", "screenshots");
const VIEWPORT = { width: 1440, height: 1100 };

function git(cwd, ...args) {
  execFileSync("git", ["-c", "user.name=Raw Coding Agent", "-c", "user.email=screenshots@localhost", ...args], { cwd, stdio: "ignore" });
}

function makeRepo(root, name, files) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  for (const [path, contents] of Object.entries(files)) {
    const target = join(repo, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "Initial demo workspace");
  return repo;
}

function iso(day, time) {
  return `2026-10-${day}T${time}`;
}

function span(id, parentId, kind, name, start, durationMs, attrs = {}, status = "ok") {
  return { type: "span", id, parentId, kind, name, start, durationMs, status, attrs };
}

function writeSession(store, session, messages, events, spans) {
  store.saveMessages(session.id, messages);
  writeFileSync(store.filePath(session.id, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  writeFileSync(store.tracePath(session.id), spans.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function createSession(store, id, workspace, model, approvalMode, createdAt) {
  const session = { id, title: "", workspace, model, createdAt, updatedAt: createdAt, turns: 0, approvalMode };
  mkdirSync(join(store.root, id), { recursive: true });
  writeFileSync(store.filePath(id, "meta.json"), JSON.stringify(session, null, 2));
  writeFileSync(store.filePath(id, "messages.json"), "[]\n");
  return store.getMeta(id);
}

function seedData(root) {
  const dataDir = join(root, "data");
  const sessionsDir = join(dataDir, ".sessions");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, ".settings.json"), JSON.stringify({
    newSessionApproval: "ask",
    defaultProvider: "deepseek",
    defaultModel: "deepseek-v4-pro",
    defaultThinkEffort: "high",
    notifications: true,
    compactionTokens: 180000,
    limits: { maxSteps: 12, maxTurnCostUsd: 0.45 },
    budgetUsd: 8,
    customInstructions: "回答用中文。改完代码先运行相关测试，并在结尾列出验证结果。",
  }, null, 2));
  writeFileSync(join(dataDir, ".providers.json"), JSON.stringify({
    deepseek: { apiKey: "demo-screenshot-key-2026", baseURL: "https://api.deepseek.com" },
    openai: { apiKey: "demo-openai-key-2026", baseURL: "https://api.openai.com/v1" },
  }, null, 2));

  const workspace = makeRepo(root, "inventory-dashboard", {
    "src/filter.ts": "export function filterRows(rows, query) { return rows.filter((row) => row.name.includes(query)); }\n",
    "README.md": "# Inventory dashboard\n\nDemo workspace used by the screenshot generator.\n",
  });
  const docsWorkspace = makeRepo(root, "docs-site", {
    "docs/guide.md": "# Release guide\n\nKeep examples runnable.\n",
    "README.md": "# Docs site\n",
  });

  const runtime = createRuntime("ask", { dataDir, sessionsDir, webSearch: false });
  runtime.projects.add(workspace);
  runtime.projects.add(docsWorkspace);
  const store = new SessionStore(sessionsDir);

  const primary = createSession(store, "20261026-081200-18eff4", workspace, "deepseek-v4-pro", "ask", iso("26", "08:12:00.000Z"));
  store.updateMeta(primary.id, {
    title: "优化库存仪表盘筛选逻辑",
    provider: "deepseek",
    thinkEffort: "high",
    turns: 3,
    updatedAt: iso("27", "09:42:00.000Z"),
    notifications: true,
    budgetUsd: 1.5,
    plan: [
      { text: "梳理筛选状态和空结果分支", status: "completed" },
      { text: "修复组合条件的边界行为", status: "completed" },
      { text: "运行测试并记录回归结果", status: "in_progress" },
    ],
  });
  const readCall = { id: "call-read-1", name: "rg", input: { command: "rg -n \"filter|query|empty\" src test" } };
  const inspectCall = { id: "call-read-2", name: "read_file", input: { path: "src/filter.ts", startLine: 1, endLine: 120 } };
  const editCall = { id: "call-edit-1", name: "edit_file", input: { path: "src/filter.ts", oldText: "includes(query)", newText: "matchesQuery(row, query)" } };
  const testCall = { id: "call-test-1", name: "bash", input: { command: "npm test -- --test-name-pattern=filter" } };
  const toolResult = (callId, content, isError = false) => ({ callId, content, isError });
  const events = [
    { type: "user", text: "请检查库存仪表盘的筛选逻辑，修复组合条件边界，并跑一轮回归测试。" },
    { type: "plan", items: [
      { text: "梳理筛选状态和空结果分支", status: "completed" },
      { text: "修复组合条件的边界行为", status: "completed" },
      { text: "运行测试并记录回归结果", status: "in_progress" },
    ] },
    { type: "assistant_text", text: "我先定位筛选入口、空结果处理和现有测试，再用最小改动修复组合条件。" },
    { type: "tool_call", call: readCall },
    { type: "tool_result", call: readCall, result: toolResult(readCall.id, "src/filter.ts:1:export function filterRows\ntest/filter.test.ts:18:empty result keeps the table shell") },
    { type: "tool_call", call: inspectCall },
    { type: "tool_result", call: inspectCall, result: toolResult(inspectCall.id, "query 为空时会误命中所有行；状态筛选和名称筛选没有共享同一条规范化路径。") },
    { type: "tool_call", call: editCall },
    { type: "approval_request", id: "approval-edit-1", call: editCall },
    { type: "approval_resolved", id: "approval-edit-1", allow: true },
    { type: "tool_result", call: editCall, result: toolResult(editCall.id, "已更新 src/filter.ts（12 行）。") },
    { type: "assistant_text", text: "边界已修复：空查询不再吞掉状态条件，组合筛选统一走规范化函数。接着运行针对性测试。" },
    { type: "tool_call", call: testCall },
    { type: "tool_result", call: testCall, result: toolResult(testCall.id, "✓ 14 tests passed\n✓ filter combination keeps empty state\n✓ status + name query are stable") },
    { type: "assistant_text", text: "测试通过。剩余计划项已完成，可以继续看提交前的 diff。" },
    { type: "plan", items: [
      { text: "梳理筛选状态和空结果分支", status: "completed" },
      { text: "修复组合条件的边界行为", status: "completed" },
      { text: "运行测试并记录回归结果", status: "completed" },
    ] },
    { type: "turn_end", finishReason: "end_turn", steps: 4 },
    { type: "user", text: "再看一下这个改动对空状态提示和性能有没有副作用。" },
    { type: "assistant_text", text: "我会检查空状态提示的渲染路径，并确认筛选仍然是单次遍历。" },
    { type: "tool_call", call: { id: "call-read-3", name: "read_file", input: { path: "src/table.tsx", startLine: 40, endLine: 110 } } },
    { type: "tool_result", call: { id: "call-read-3", name: "read_file", input: { path: "src/table.tsx", startLine: 40, endLine: 110 } }, result: toolResult("call-read-3", "空状态由同一个结果数组驱动；没有额外请求，也没有第二次过滤。") },
    { type: "assistant_text", text: "空状态和性能都没有新增风险：仍是一次过滤，提示沿用现有结果数组。" },
    { type: "turn_end", finishReason: "end_turn", steps: 1 },
  ];
  const messages = [
    { role: "user", content: "请检查库存仪表盘的筛选逻辑，修复组合条件边界，并跑一轮回归测试。" },
    { role: "assistant", text: "我先定位筛选入口、空结果处理和现有测试，再用最小改动修复组合条件。", toolCalls: [readCall, inspectCall, editCall, testCall] },
    { role: "tool_results", results: [
      toolResult(readCall.id, "src/filter.ts:1:export function filterRows"),
      toolResult(inspectCall.id, "query 为空时会误命中所有行"),
      toolResult(editCall.id, "已更新 src/filter.ts（12 行）。"),
      toolResult(testCall.id, "14 tests passed"),
    ] },
    { role: "assistant", text: "测试通过。筛选统一走规范化函数，空查询和组合条件现在保持一致。", toolCalls: [] },
  ];
  const spans = [
    span("turn-1", null, "turn", "turn", iso("26", "08:12:05.000Z"), 4200, { input: "请检查库存仪表盘的筛选逻辑" }),
    span("llm-1", "turn-1", "llm", "deepseek-v4-pro", iso("26", "08:12:05.100Z"), 820, { step: 1, inputTokens: 18400, cachedInputTokens: 8200, outputTokens: 480, stopReason: "tool_use", costUsd: 0.0124 }),
    span("tool-1", "turn-1", "tool", "rg", iso("26", "08:12:06.000Z"), 180, { input: readCall.input, outputChars: 1640, approval: "auto" }),
    span("tool-2", "turn-1", "tool", "read_file", iso("26", "08:12:06.300Z"), 320, { input: inspectCall.input, outputChars: 2840, approval: "auto" }),
    span("llm-2", "turn-1", "llm", "deepseek-v4-pro", iso("26", "08:12:07.000Z"), 930, { step: 2, inputTokens: 21500, cachedInputTokens: 11200, outputTokens: 620, stopReason: "tool_use", costUsd: 0.0158 }),
    span("tool-3", "turn-1", "tool", "edit_file", iso("26", "08:12:08.000Z"), 760, { input: editCall.input, outputChars: 420, approval: "allowed", approvalMs: 640 }),
    span("tool-4", "turn-1", "tool", "bash", iso("26", "08:12:09.000Z"), 1240, { input: testCall.input, outputChars: 1280, approval: "auto" }),
    span("llm-3", "turn-1", "llm", "deepseek-v4-pro", iso("26", "08:12:11.000Z"), 540, { step: 3, inputTokens: 23800, cachedInputTokens: 15400, outputTokens: 380, stopReason: "end_turn", costUsd: 0.0121 }),
    span("turn-2", null, "turn", "turn", iso("27", "09:18:10.000Z"), 2200, { input: "再看一下这个改动对空状态提示和性能有没有副作用。" }),
    span("llm-4", "turn-2", "llm", "deepseek-v4-pro", iso("27", "09:18:10.100Z"), 610, { step: 1, inputTokens: 24600, cachedInputTokens: 17800, outputTokens: 260, stopReason: "tool_use", costUsd: 0.0104 }),
    span("tool-5", "turn-2", "tool", "read_file", iso("27", "09:18:11.000Z"), 410, { input: { path: "src/table.tsx", startLine: 40, endLine: 110 }, outputChars: 2100, approval: "auto" }),
    span("llm-5", "turn-2", "llm", "deepseek-v4-pro", iso("27", "09:18:12.000Z"), 490, { step: 2, inputTokens: 25800, cachedInputTokens: 18900, outputTokens: 240, stopReason: "end_turn", costUsd: 0.0091 }),
    span("turn-3", null, "turn", "turn", iso("27", "09:42:00.000Z"), 1600, { input: "整理提交前的验证结果。" }),
    span("llm-6", "turn-3", "llm", "deepseek-v4-pro", iso("27", "09:42:00.100Z"), 480, { step: 1, inputTokens: 26200, cachedInputTokens: 19400, outputTokens: 180, stopReason: "end_turn", costUsd: 0.0084 }),
  ];
  writeSession(store, primary, messages, events, spans);

  const secondary = createSession(store, "20261025-143000-9a4b2c", docsWorkspace, "deepseek-flash", "auto", iso("25", "14:30:00.000Z"));
  store.updateMeta(secondary.id, { title: "补齐发布文档的 CSV 校验", provider: "deepseek", thinkEffort: "medium", turns: 2, updatedAt: iso("26", "16:05:00.000Z"), budgetUsd: 0.8 });
  const secondaryCall = { id: "call-docs-1", name: "bash", input: { command: "npm test -- --test-name-pattern=csv" } };
  writeSession(store, secondary,
    [{ role: "user", content: "补齐 CSV 导出文档的校验说明。" }, { role: "assistant", text: "已补充示例并通过校验。", toolCalls: [secondaryCall] }, { role: "tool_results", results: [toolResult(secondaryCall.id, "8 tests passed")] }],
    [{ type: "user", text: "补齐 CSV 导出文档的校验说明。" }, { type: "assistant_text", text: "我先检查现有示例和校验命令。" }, { type: "tool_call", call: secondaryCall }, { type: "tool_result", call: secondaryCall, result: toolResult(secondaryCall.id, "8 tests passed") }, { type: "assistant_text", text: "已补充示例并通过校验。" }, { type: "turn_end", finishReason: "end_turn", steps: 1 }],
    [
      span("s-turn-1", null, "turn", "turn", iso("25", "14:30:05.000Z"), 1700, { input: "补齐 CSV 导出文档的校验说明。" }),
      span("s-llm-1", "s-turn-1", "llm", "deepseek-flash", iso("25", "14:30:05.100Z"), 430, { step: 1, inputTokens: 6400, cachedInputTokens: 1200, outputTokens: 220, stopReason: "tool_use", costUsd: 0.0027 }),
      span("s-tool-1", "s-turn-1", "tool", "bash", iso("25", "14:30:06.000Z"), 540, { input: secondaryCall.input, outputChars: 840, approval: "auto" }),
      span("s-llm-2", "s-turn-1", "llm", "deepseek-flash", iso("25", "14:30:07.000Z"), 410, { step: 2, inputTokens: 7200, cachedInputTokens: 2200, outputTokens: 180, stopReason: "end_turn", costUsd: 0.0023 }),
      span("s-turn-2", null, "turn", "turn", iso("26", "16:05:00.000Z"), 1200, { input: "确认示例可复制运行。" }),
      span("s-llm-3", "s-turn-2", "llm", "deepseek-flash", iso("26", "16:05:00.100Z"), 390, { step: 1, inputTokens: 7800, cachedInputTokens: 3000, outputTokens: 160, stopReason: "end_turn", costUsd: 0.0021 }),
    ]);

  const archived = createSession(store, "20261022-112000-c0ffee", workspace, "deepseek-flash", "ask", iso("22", "11:20:00.000Z"));
  store.updateMeta(archived.id, { title: "旧版库存导入脚本", provider: "deepseek", thinkEffort: "low", turns: 1, archived: true, updatedAt: iso("23", "10:15:00.000Z") });
  writeSession(store, archived,
    [{ role: "user", content: "检查旧版库存导入脚本。" }, { role: "assistant", text: "已归档这次探索。", toolCalls: [] }],
    [{ type: "user", text: "检查旧版库存导入脚本。" }, { type: "assistant_text", text: "已归档这次探索。" }, { type: "turn_end", finishReason: "end_turn", steps: 1 }],
    [span("a-turn-1", null, "turn", "turn", iso("22", "11:20:05.000Z"), 900, { input: "检查旧版库存导入脚本。" }), span("a-llm-1", "a-turn-1", "llm", "deepseek-flash", iso("22", "11:20:05.100Z"), 300, { step: 1, inputTokens: 2100, cachedInputTokens: 0, outputTokens: 110, stopReason: "end_turn", costUsd: 0.0007 })]);

  return { dataDir, sessionsDir, runtime, primary, secondary, archived };
}

async function capture() {
  mkdirSync(OUTPUT, { recursive: true });
  const fixtureRoot = join(tmpdir(), "raw-coding-agent-screenshots");
  rmSync(fixtureRoot, { recursive: true, force: true });
  const { runtime, primary } = seedData(fixtureRoot);
  const manager = new SessionManager(runtime);
  const token = "screenshot-token";
  const servers = createGuiServers(manager, token);
  const port = await listen(servers.local, 0);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  const base = `http://127.0.0.1:${port}/?token=${token}`;

  async function open(hash = "") {
    await page.goto(`${base}${hash ? `#${hash}` : ""}`, { waitUntil: "networkidle" });
    await page.waitForTimeout(700);
  }

  async function shot(name) {
    await page.screenshot({ path: join(OUTPUT, name), fullPage: false });
    console.log(`captured ${name}`);
  }

  try {
    await open();
    await page.locator("#sessions .item .body").first().waitFor();
    await shot("web-ui.png");

    await open(primary.id);
    await page.locator("#log .msg").first().waitFor();
    await shot("web-ui-session.png");

    await open(`stats/${primary.id}`);
    const stats = page.frameLocator("#view-stats iframe");
    await stats.locator("#root section").first().waitFor();
    await shot("web-ui-stats.png");

    await open("iterations");
    const iterations = page.frameLocator("#view-iterations iframe");
    await iterations.locator("#list .entry").first().waitFor();
    await shot("web-ui-iterations.png");

    await open("settings");
    await page.locator("#model-defaults").waitFor();
    await page.locator("#provider-settings").waitFor();
    await shot("web-ui-settings.png");
  } finally {
    await browser.close();
    servers.local.close();
    await manager.shutdown();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

capture().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
