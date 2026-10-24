import assert from "node:assert/strict";
import { test } from "node:test";
import { isReadOnlyBashCommand, needsApproval } from "../src/agent/permissions.ts";
import { bashTool } from "../src/tools/bash.ts";
import { editFileTool } from "../src/tools/edit-file.ts";
import { writeFileTool } from "../src/tools/write-file.ts";
import type { ToolCall } from "../src/types.ts";

const call = (command: string): ToolCall => ({ id: "c", name: "bash", input: { command } });

test("clearly read-only commands run without a prompt in ask mode", () => {
  for (const command of [
    "ls -la",
    "cat a.txt",
    'grep -rn "TODO" src',
    "git status",
    "git diff --stat",
    "git log --oneline -5",
    "git branch --show-current",
    'find . -name "*.ts"',
    "pwd",
    "wc -l a.txt",
    "sort a.txt",
    "cat a | grep b",
    "ls && pwd",
  ]) {
    assert.equal(isReadOnlyBashCommand(command), true, command);
    assert.equal(needsApproval(bashTool, "ask", call(command)), false, command);
  }
});

test("writes, network, execution, redirection and hidden commands still ask", () => {
  for (const command of [
    "rm -rf build",
    "echo hi > a.txt",
    "cat a | tee b",
    "git commit -m x",
    "git branch new",
    "git config user.email x",
    "git diff --output=x",
    "git -c core.pager=rm log",
    "git remote add origin url",
    "git worktree add ../x",
    "find . -delete",
    "sed -i s/a/b/ f",
    "npm test",
    "$(whoami)",
    "ls &",
    "python x.py",
    "xargs rm",
    "rg --pre 'sh -c rm' foo",
    "date -s 2026-01-01",
    "yq -i '.a = 1' f.yml",
    "sort --compress-program=rm f",
  ]) {
    assert.equal(isReadOnlyBashCommand(command), false, command);
    assert.equal(needsApproval(bashTool, "ask", call(command)), true, command);
  }
});

test("auto mode still runs everything without asking", () => {
  assert.equal(needsApproval(bashTool, "auto", call("rm -rf build")), false);
});

test("ask mode also protects file mutations", () => {
  assert.equal(needsApproval(writeFileTool, "ask"), true);
  assert.equal(needsApproval(editFileTool, "ask"), true);
  assert.equal(needsApproval(writeFileTool, "auto"), false);
});
