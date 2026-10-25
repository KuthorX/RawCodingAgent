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
