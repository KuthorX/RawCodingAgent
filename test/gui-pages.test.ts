import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { PROJECT_ROOT } from "../src/app.ts";

const GUI = join(PROJECT_ROOT, "src", "gui");

test("a delayed command response preserves the next draft and ignores a session switched in flight", async () => {
  const page = readFileSync(join(GUI, "index.html"), "utf8");
  const source = page.match(/\$\("form"\)\.addEventListener\("submit", async \(ev\) => \{[^]*?^\}\);/m)?.[0];
  assert.ok(source);
  let submit: (event: { preventDefault(): void }) => Promise<void>;
  let respond: (result: unknown) => void;
  const context = vm.createContext({
    $: () => ({ addEventListener: (_name: string, callback: typeof submit) => { submit = callback; } }),
    api: () => new Promise((resolve) => { respond = resolve; }),
    input: { value: "/help", style: { height: "" } },
    attachments: [], current: "old", location: { hash: "old" },
    hideSlashMenu() {}, renderAttachments() {}, refreshSessions() {}, setBusy() {}, append() {}, el() {},
  });
  vm.runInContext(source, context);
  const pending = submit!({ preventDefault() {} });
  context.input.value = "/skills";
  context.attachments = ["new image"];
  respond!({ message: "help text" });
  await pending;
  assert.equal(context.input.value, "/skills");
  assert.deepEqual(context.attachments, ["new image"]);

  context.input.value = "/clear";
  context.attachments = [];
  const switching = submit!({ preventDefault() {} });
  context.current = "other";
  context.input.value = "other draft";
  respond!({ session: { id: "fresh" } });
  await switching;
  assert.equal(context.input.value, "other draft");
  assert.equal(context.location.hash, "old");
});

// A syntax error in a page script silently breaks the whole page (no sessions, dead buttons), and the
// HTTP tests can't see it. Compile every inline <script> and common.js without running them.
for (const file of readdirSync(GUI).filter((f) => f.endsWith(".html") || f.endsWith(".js"))) {
  test(`${file}: scripts compile`, () => {
    const text = readFileSync(join(GUI, file), "utf8");
    const scripts = file.endsWith(".js") ? [text] : [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    if (file.endsWith(".html")) assert.ok(scripts.length > 0, "no inline script found");
    for (const source of scripts) assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
  });
}

test("every settings block sits in a section and the section list matches the nav", () => {
  const page = readFileSync(join(GUI, "index.html"), "utf8");
  const view = page.slice(page.indexOf('id="view-settings"'), page.indexOf('<div class="view layout"'));
  const nav = [...view.matchAll(/<button type="button" data-section="(\w+)">/g)].map((m) => m[1]);
  const sections = [...view.matchAll(/<section class="settings-section" data-section="(\w+)">/g)].map((m) => m[1]);
  assert.ok(nav.length >= 3, "expected several settings sections");
  assert.deepEqual(sections, nav, "sections must match the nav, in the same order");
  assert.equal((view.match(/<section/g) ?? []).length, (view.match(/<\/section>/g) ?? []).length);
  // Nothing may escape a section: every .setting block appears after a section opens.
  const beforeFirst = view.slice(0, view.indexOf("<section"));
  assert.doesNotMatch(beforeFirst, /class="setting"/);
  assert.match(view, /data-section="(\w+)">\s*<div class="setting">/);
});

test("model controls preserve old session choices and only offer supported effort levels", () => {
  const page = readFileSync(join(GUI, "index.html"), "utf8");
  const labels = page.match(/^const THINK_LABELS = .+;$/m)?.[0];
  assert.ok(labels);
  const functions = ["modelSelection", "option", "supportedEfforts", "effortLabel", "fillEffortOptions"].map((name) => {
    const source = page.match(new RegExp(`^function ${name}\\([^]*?^}`, "m"))?.[0];
    assert.ok(source, name);
    return source;
  });
  const context = vm.createContext({ el: (_tag: string, _class: string, text: string) => ({ textContent: text, value: "", disabled: false }) });
  vm.runInContext([labels, ...functions].join("\n"), context);
  const selected = context.modelSelection({ model: "existing-model" });
  assert.equal(selected.provider, "legacy");
  assert.equal(selected.model, "existing-model");
  assert.equal(selected.thinkEffort, "off");

  const select = {
    value: "", options: [] as { value: string; disabled: boolean; textContent: string }[],
    replaceChildren(...options: { value: string; disabled: boolean; textContent: string }[]) { this.options = options; },
    prepend(option: { value: string; disabled: boolean; textContent: string }) { this.options.unshift(option); },
  };
  const models = [{ id: "reasoning", thinkingLevels: ["low", "high", "ultra"] }];
  context.fillEffortOptions(select, models, "reasoning", "off", false);
  assert.deepEqual(select.options.map((entry) => entry.value), ["low", "high"]);
  assert.equal(select.value, "low");
  context.fillEffortOptions(select, models, "reasoning", "high", false);
  assert.equal(select.value, "high");
  context.fillEffortOptions(select, models, "reasoning", "off", true);
  assert.equal(select.value, "off", "loading an old session must not silently change its saved setting");
  assert.equal(select.options[0]?.disabled, true);

  context.fillEffortOptions(select, [], "deepseek-reasoner", "off", true, "legacy");
  assert.equal(select.options[0]?.textContent, "接口默认");
  context.fillEffortOptions(select, [{ id: "native", provider: "deepseek", thinkingLevels: ["off"] }], "native", "off");
  assert.equal(select.options[0]?.textContent, "关闭");
});

test("plan panel renders items with status, edit and delete actions", () => {
  const page = readFileSync(join(GUI, "index.html"), "utf8");
  const constants = ["PLAN_MARK", "NEXT_STATUS"].map((name) => {
    const source = page.match(new RegExp(`^const ${name} = .+;$`, "m"))?.[0];
    assert.ok(source, name);
    return source;
  });
  const renderPlan = page.match(/^function renderPlan\([^]*?^}/m)?.[0];
  assert.ok(renderPlan);

  const nodes = new Map();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: "", children: [] as unknown[], append(...items: unknown[]) { (this as { children: unknown[] }).children.push(...items); }, replaceChildren(...items: unknown[]) { (this as { children: unknown[] }).children = items; } });
    return nodes.get(id);
  };
  const el = (tag: string, className?: string, text?: string) => ({ tag, className: className ?? "", textContent: text ?? "", children: [] as unknown[], value: "", type: "", title: "", hidden: false,
    append(...items: unknown[]) { this.children.push(...items); }, replaceChildren(...items: unknown[]) { this.children = items; }, addEventListener() {}, setAttribute() {}, focus() {}, select() {} });
  const context = vm.createContext({
    $: (id: string) => node(id), el, queueMicrotask: (fn: () => void) => fn(), notice() {}, savePlan() {}, savePlanEdit() {},
    sessionMode: { mode: "plan", prompt: "", max: 10, count: 0 },
    planItems: [{ text: "read", status: "completed" }, { text: "edit", status: "in_progress" }],
    planEditing: 1,
  });
  vm.runInContext([...constants, renderPlan].join("\n"), context);
  context.renderPlan();
  assert.equal(node("plan-panel").hidden, false);
  assert.equal(node("plan-count").textContent, "1/2");
  assert.equal(node("plan-run").hidden, false);
  assert.equal(node("plan-exit").hidden, false);
  const rows = node("plan-items").children as { className: string; children: { tag?: string; value?: string }[] }[];
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.className, /plan-item completed/);
  const editing = rows[1]!.children.find((child) => child.tag === "input");
  assert.equal(editing?.value, "edit");
});
