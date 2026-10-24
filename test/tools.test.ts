import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { test } from "node:test";
import { truncateOutput } from "../src/agent/truncate.ts";
import { bashTool, decodeOutput } from "../src/tools/bash.ts";
import { editFileTool } from "../src/tools/edit-file.ts";
import { globTool } from "../src/tools/glob.ts";
import { grepTool } from "../src/tools/grep.ts";
import { listDirTool } from "../src/tools/list-dir.ts";
import { readFileTool } from "../src/tools/read-file.ts";
import { delegateTool } from "../src/tools/delegate.ts";
import { planTool, type PlanItem } from "../src/tools/plan.ts";
import { ToolError } from "../src/tools/types.ts";
import { webFetchTool, htmlToText } from "../src/tools/web-fetch.ts";
import { writeFileTool } from "../src/tools/write-file.ts";
import { tempWorkspace } from "./helpers.ts";

test("read_file prefixes line numbers", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.txt"), "a\nb");
  const out = await readFileTool.run({ path: "f.txt" }, { workspace });
  assert.equal(out, "    1\ta\n    2\tb");
});

test("plan tool validates and persists a bounded checklist", async () => {
  let items: PlanItem[] = [];
  const tool = planTool({ get: () => items, replace: (next) => { items = next; return next.map((item) => item.text).join("\n"); } });
  const result = await tool.run({ items: [{ text: "Inspect", status: "in_progress" }, { text: "Test", status: "pending" }] }, { workspace: tempWorkspace() });
  assert.match(result, /Inspect/);
  assert.equal(items[0].status, "in_progress");
  await assert.rejects(tool.run({ items: [{ text: "a", status: "in_progress" }, { text: "b", status: "in_progress" }] }, { workspace: tempWorkspace() }), /at most one/);
});

test("delegate tool forwards a focused bounded investigation", async () => {
  const tool = delegateTool(async (prompt) => `child:${prompt}`);
  assert.equal(await tool.run({ prompt: "inspect config" }, { workspace: tempWorkspace() }), "child:inspect config");
  await assert.rejects(tool.run({ prompt: "" }, { workspace: tempWorkspace() }), /1-2000/);
});

test("paths outside the workspace are rejected", async () => {
  const workspace = tempWorkspace();
  await assert.rejects(readFileTool.run({ path: "../etc/passwd" }, { workspace }), ToolError);
  await assert.rejects(writeFileTool.run({ path: "/tmp/x", content: "" }, { workspace }), ToolError);
});

test("symbolic links can't lead the file tools out of the workspace", async (t) => {
  const workspace = tempWorkspace();
  const outside = tempWorkspace();
  writeFileSync(join(outside, "secret.txt"), "token");
  try {
    symlinkSync(outside, join(workspace, "out"));
  } catch (err) {
    // Windows without Developer Mode or admin rights cannot create symlinks; the check itself is covered on
    // platforms that can (and on CI with developer mode enabled).
    if ((err as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks are not permitted on this machine");
    throw err;
  }
  symlinkSync(join(outside, "secret.txt"), join(workspace, "secret-link.txt"));
  await assert.rejects(readFileTool.run({ path: "out/secret.txt" }, { workspace }), /symbolic link/);
  await assert.rejects(readFileTool.run({ path: "secret-link.txt" }, { workspace }), /symbolic link/);
  // Creating a file through the link is refused too, even though the file doesn't exist yet.
  await assert.rejects(writeFileTool.run({ path: "out/new/x.txt", content: "x" }, { workspace }), /symbolic link/);
  await assert.rejects(editFileTool.run({ path: "out/secret.txt", old_string: "token", new_string: "x" }, { workspace }), /symbolic link/);
  assert.equal(readFileSync(join(outside, "secret.txt"), "utf8"), "token");
  assert.equal(existsSync(join(outside, "new")), false);
  // A link that stays inside the workspace is fine.
  writeFileSync(join(workspace, "real.txt"), "ok");
  symlinkSync(join(workspace, "real.txt"), join(workspace, "alias.txt"));
  assert.match(await readFileTool.run({ path: "alias.txt" }, { workspace }), /ok/);
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

test("read_file reads a range with offset/limit and says how to continue", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.txt"), "a\r\nb\r\nc\r\nd\r\n");
  assert.equal(await readFileTool.run({ path: "f.txt" }, { workspace }), "    1\ta\n    2\tb\n    3\tc\n    4\td");
  assert.equal(await readFileTool.run({ path: "f.txt", offset: 2, limit: 2 }, { workspace }), "    2\tb\n    3\tc\n[lines 2-3 of 4; continue with offset 4]");
  assert.equal(await readFileTool.run({ path: "f.txt", offset: 3 }, { workspace }), "    3\tc\n    4\td\n[lines 3-4 of 4]");
  await assert.rejects(readFileTool.run({ path: "f.txt", offset: 9 }, { workspace }), /past the end/);
  await assert.rejects(readFileTool.run({ path: "f.txt", limit: 0 }, { workspace }), /positive integer/);
});

test("edit_file applies several edits in order, or none if one fails", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.py"), "a = 1\r\nb = 2\r\nc = 3\r\n");
  const edit = (edits: unknown) => editFileTool.run({ path: "f.py", edits }, { workspace });
  assert.equal(await edit([{ old_string: "a = 1", new_string: "a = 10" }, { old_string: "a = 10\nb = 2", new_string: "a = 10\nb = 20" }]), "Edited f.py (2 changes)");
  assert.equal(readFileSync(join(workspace, "f.py"), "utf8"), "a = 10\r\nb = 20\r\nc = 3\r\n");
  await assert.rejects(edit([{ old_string: "c = 3", new_string: "c = 30" }, { old_string: "zzz", new_string: "" }]), /edits\[1\], no changes were written/);
  assert.equal(readFileSync(join(workspace, "f.py"), "utf8"), "a = 10\r\nb = 20\r\nc = 3\r\n");
  await assert.rejects(edit([]), /non-empty array/);
  await assert.rejects(edit([{ old_string: "c" }]), /edits\[0\]: "new_string" must be a string/);
  await assert.rejects(editFileTool.run({ path: "f.py", old_string: "c", new_string: "d", edits: [] }, { workspace }), /not both/);
});

test("edit_file matches \\n text in CRLF files and keeps CRLF", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.py"), "def a():\r\n    return 1\r\n\r\ndef b():\r\n    return 2\r\n");
  await editFileTool.run({ path: "f.py", old_string: "def b():\n    return 2", new_string: "def b():\n    x = 2\n    return x" }, { workspace });
  assert.equal(readFileSync(join(workspace, "f.py"), "utf8"), "def a():\r\n    return 1\r\n\r\ndef b():\r\n    x = 2\r\n    return x\r\n");
  // An exact match (here: within one line) is used as-is.
  await editFileTool.run({ path: "f.py", old_string: "return 1", new_string: "return 10" }, { workspace });
  assert.match(readFileSync(join(workspace, "f.py"), "utf8"), /return 10\r\n/);
});

test("write_file keeps the line endings of the CRLF file it overwrites", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "crlf.md"), "a\r\nb\r\n");
  writeFileSync(join(workspace, "lf.md"), "a\nb\n");
  await writeFileTool.run({ path: "crlf.md", content: "x\ny\n" }, { workspace });
  await writeFileTool.run({ path: "lf.md", content: "x\ny\n" }, { workspace });
  assert.equal(readFileSync(join(workspace, "crlf.md"), "utf8"), "x\r\ny\r\n");
  assert.equal(readFileSync(join(workspace, "lf.md"), "utf8"), "x\ny\n");
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

test("bash adds no blank line between the output and the exit code", async () => {
  const workspace = tempWorkspace();
  assert.equal(await bashTool.run({ command: "printf 'a\\n'" }, { workspace }), "a\n[exit code: 0]");
  assert.equal(await bashTool.run({ command: "printf 'a'" }, { workspace }), "a\n[exit code: 0]");
  assert.equal(await bashTool.run({ command: "printf 'a\\n\\n'" }, { workspace }), "a\n\n[exit code: 0]");
  assert.equal(await bashTool.run({ command: "true" }, { workspace }), "[exit code: 0]");
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

test("list_dir shows directories first, sizes, and nested levels", async () => {
  const workspace = tempWorkspace();
  mkdirSync(join(workspace, "src", "nested"), { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "abc");
  writeFileSync(join(workspace, "src", "b.ts"), "hello");
  writeFileSync(join(workspace, "src", "nested", "c.ts"), "x");

  const flat = await listDirTool.run({}, { workspace });
  assert.match(flat, /^[^\n]+\/$/m);
  assert.match(flat, /\n  src\/\n/);
  assert.match(flat, /\n  a\.txt \(3 B\)/);
  assert.doesNotMatch(flat, /b\.ts/);

  const deep = await listDirTool.run({ path: "src", depth: 2 }, { workspace });
  assert.match(deep, /^src\/\n/);
  assert.match(deep, /\n  b\.ts \(5 B\)/);
  assert.match(deep, /\n  nested\/\n    c\.ts/);
});

test("grep returns context lines and can list only matching files", async () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "f.txt"), "one\ntwo target\nthree\nfour\nfive\n");
  writeFileSync(join(workspace, "g.txt"), "nothing\n");

  const withContext = await grepTool.run({ pattern: "target", context: 1 }, { workspace });
  assert.match(withContext, /f\.txt-1- one/);
  assert.match(withContext, /f\.txt:2: two target/);
  assert.match(withContext, /f\.txt-3- three/);
  assert.doesNotMatch(withContext, /four/);

  const files = await grepTool.run({ pattern: "target", files_only: true }, { workspace });
  assert.equal(files, "f.txt");
});

test("web_fetch extracts readable text and drops scripts", async () => {
  assert.equal(htmlToText("<title>T</title><p>a &amp; b</p><script>x()</script>"), "T\n\na & b");

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<html><head><title>Doc</title></head><body><h1>Hi</h1><script>bad()</script><p>Hello &amp; bye</p></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const out = await webFetchTool.run({ url: `http://127.0.0.1:${port}/` }, { workspace: tempWorkspace() });
    assert.match(out, /Doc/);
    assert.match(out, /Hi/);
    assert.match(out, /Hello & bye/);
    assert.doesNotMatch(out, /bad\(\)/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("web_fetch refuses non-http URLs, metadata hosts and binary content", async () => {
  const workspace = tempWorkspace();
  await assert.rejects(webFetchTool.run({ url: "file:///etc/passwd" }, { workspace }), /only http/);
  await assert.rejects(webFetchTool.run({ url: "http://169.254.169.254/latest/meta-data" }, { workspace }), /refusing/);
  await assert.rejects(webFetchTool.run({ url: "http://10.0.0.1/" }, { workspace }), /private address/);

  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(webFetchTool.run({ url: `http://127.0.0.1:${port}/` }, { workspace }), /binary/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
