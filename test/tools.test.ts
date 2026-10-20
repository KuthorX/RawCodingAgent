import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { truncateOutput } from "../src/agent/truncate.ts";
import { bashTool, decodeOutput } from "../src/tools/bash.ts";
import { editFileTool } from "../src/tools/edit-file.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
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

// A small tree, including files the search tools must skip.
function searchWorkspace(): string {
  const workspace = tempWorkspace();
  const files: Record<string, string> = {
    "src/app.ts": 'export const answer = 42;\nconst Name = "x";\n',
    "src/util/math.ts": "export function add(a, b) {\r\n  return a + b;\r\n}\r\n",
    "README.md": "answer: see src\n",
    "node_modules/dep/index.ts": "export const answer = 0;\n",
    ".git/config": "answer\n",
    "data.bin": "answer\0\n",
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(workspace, path, ".."), { recursive: true });
    writeFileSync(join(workspace, path), content);
  }
  return workspace;
}

test("glob returns sorted workspace-relative paths and skips node_modules", async () => {
  const workspace = searchWorkspace();
  assert.equal(await globTool.run({ pattern: "**/*.ts" }, { workspace }), "src/app.ts\nsrc/util/math.ts");
  assert.equal(await globTool.run({ pattern: "*.ts", path: "src/util" }, { workspace }), "src/util/math.ts");
  assert.equal(await globTool.run({ pattern: "*.py" }, { workspace }), "no files found");
});

test("glob refuses patterns that leave the workspace", async () => {
  const workspace = searchWorkspace();
  await assert.rejects(globTool.run({ pattern: "../**/*" }, { workspace }), ToolError);
  await assert.rejects(globTool.run({ pattern: "*", path: ".." }, { workspace }), ToolError);
});

test("grep finds matching lines, skipping node_modules, .git and binary files", async () => {
  const workspace = searchWorkspace();
  assert.equal(await grepTool.run({ pattern: "answer" }, { workspace }), "README.md:1: answer: see src\nsrc/app.ts:1: export const answer = 42;");
  // CRLF files: `$` matches before the \r, which is not part of the shown line
  assert.equal(await grepTool.run({ pattern: "a \\+ b;$" }, { workspace }), "src/util/math.ts:2:   return a + b;");
});

test("grep filters by glob and path, and supports ignore_case", async () => {
  const workspace = searchWorkspace();
  assert.equal(await grepTool.run({ pattern: "answer", glob: "*.md" }, { workspace }), "README.md:1: answer: see src");
  assert.equal(await grepTool.run({ pattern: "name", path: "src/app.ts", ignore_case: true }, { workspace }), 'src/app.ts:2: const Name = "x";');
  assert.equal(await grepTool.run({ pattern: "name", path: "src" }, { workspace }), "no matches found");
  await assert.rejects(grepTool.run({ pattern: "(" }, { workspace }), /invalid regular expression/);
});

test("grep caps the number of matches", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "many.txt"), "hit\n".repeat(250));
  const out = await grepTool.run({ pattern: "hit" }, { workspace });
  assert.equal(out.split("\n").length, 201);
  assert.match(out, /\[50 more matches not shown; narrow the search\]$/);
});

test("decodeOutput decodes UTF-8 lines as UTF-8 and the others with the legacy code page", () => {
  const gbk = () => new TextDecoder("gbk");
  // "机器" in GBK, then a UTF-8 line, then an emoji split across what could have been two chunks
  const buf = Buffer.concat([Buffer.from([0xbb, 0xfa, 0xc6, 0xf7, 0x0d, 0x0a]), Buffer.from("你好\n🤖")]);
  assert.equal(decodeOutput(buf, gbk), "机器\r\n你好\n🤖");
  assert.equal(decodeOutput(Buffer.from("a\n\nb\n"), gbk), "a\n\nb\n");
});

test("bash returns combined output and exit code", async () => {
  const out = await bashTool.run({ command: "echo out; echo err >&2; exit 3" }, { workspace: tempWorkspace() });
  assert.match(out, /out/);
  assert.match(out, /err/);
  assert.match(out, /\[exit code: 3\]/);
});

test("bash returns when the shell exits, even if a background process keeps running", async () => {
  // The second form hung a real session: `&` backgrounds the whole `cd && ...` list in a subshell,
  // and the redirect applies only to the inner command, so the subshell keeps the pipe open.
  for (const command of ["sleep 5 & echo started", "cd . && nohup sleep 5 > /dev/null 2>&1 &\necho started"]) {
    const started = Date.now();
    const out = await bashTool.run({ command }, { workspace: tempWorkspace() });
    assert.ok(Date.now() - started < 3000, command);
    assert.match(out, /started/);
    assert.match(out, /background process is still running/);
    assert.match(out, /\[exit code: 0\]/);
  }
});

test("bash runs in the workspace", async () => {
  const workspace = tempWorkspace();
  const out = await bashTool.run({ command: "pwd -P" }, { workspace });
  assert.ok(out.includes(basename(workspace)));
});

test("truncateOutput keeps head and tail", () => {
  assert.equal(truncateOutput("short", 100), "short");
  const out = truncateOutput("a".repeat(50) + "b".repeat(50), 20);
  assert.ok(out.startsWith("a".repeat(10)));
  assert.ok(out.endsWith("b".repeat(10)));
  assert.match(out, /80 chars omitted/);
});
