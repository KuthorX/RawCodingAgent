import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { truncateOutput } from "../src/agent/truncate.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editFileTool } from "../src/tools/edit-file.ts";
import { readFileTool } from "../src/tools/read-file.ts";
import { ToolError } from "../src/tools/types.ts";
import { writeFileTool } from "../src/tools/write-file.ts";
import { tempWorkspace } from "./helpers.ts";

test("read_file prefixes line numbers", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.txt"), "a\nb");
  const out = await readFileTool.run({ path: "f.txt" }, { workspace });
  assert.equal(out, "    1\ta\n    2\tb");
});

test("paths outside the workspace are rejected", async () => {
  const workspace = tempWorkspace();
  await assert.rejects(readFileTool.run({ path: "../etc/passwd" }, { workspace }), ToolError);
  await assert.rejects(writeFileTool.run({ path: "/tmp/x", content: "" }, { workspace }), ToolError);
});

test("missing or mistyped arguments raise ToolError", async () => {
  await assert.rejects(readFileTool.run({}, { workspace: tempWorkspace() }), ToolError);
  await assert.rejects(writeFileTool.run({ path: "a", content: 1 }, { workspace: tempWorkspace() }), ToolError);
});

test("write_file creates parent directories", async () => {
  const workspace = tempWorkspace();
  await writeFileTool.run({ path: "a/b/c.txt", content: "x" }, { workspace });
  assert.equal(readFileSync(join(workspace, "a/b/c.txt"), "utf8"), "x");
});

test("edit_file replaces a unique match", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.ts"), "const a = 1;\nconst b = 2;\n");
  await editFileTool.run({ path: "f.ts", old_string: "b = 2", new_string: "b = $&3" }, { workspace });
  assert.equal(readFileSync(join(workspace, "f.ts"), "utf8"), "const a = 1;\nconst b = $&3;\n");
});

test("edit_file rejects zero, multiple and empty matches", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.ts"), "x\nx\n");
  const edit = (old_string: string) => editFileTool.run({ path: "f.ts", old_string, new_string: "y" }, { workspace });
  await assert.rejects(edit("z"), /not found/);
  await assert.rejects(edit("x"), /matches 2 places/);
  await assert.rejects(edit(""), /must not be empty/);
  assert.equal(readFileSync(join(workspace, "f.ts"), "utf8"), "x\nx\n");
});

test("bash returns combined output and exit code", async () => {
  const out = await bashTool.run({ command: "echo out; echo err >&2; exit 3" }, { workspace: tempWorkspace() });
  assert.match(out, /out/);
  assert.match(out, /err/);
  assert.match(out, /\[exit code: 3\]/);
});

test("bash runs in the workspace", async () => {
  const workspace = tempWorkspace();
  const out = await bashTool.run({ command: "pwd -P" }, { workspace });
  assert.ok(out.includes(workspace.split("/").at(-1)!));
});

test("truncateOutput keeps head and tail", () => {
  assert.equal(truncateOutput("short", 100), "short");
  const out = truncateOutput("a".repeat(50) + "b".repeat(50), 20);
  assert.ok(out.startsWith("a".repeat(10)));
  assert.ok(out.endsWith("b".repeat(10)));
  assert.match(out, /80 chars omitted/);
});
