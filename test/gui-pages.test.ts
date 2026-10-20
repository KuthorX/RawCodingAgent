import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { PROJECT_ROOT } from "../src/app.ts";

const GUI = join(PROJECT_ROOT, "src", "gui");

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
