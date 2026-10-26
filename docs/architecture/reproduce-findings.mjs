// Regression snapshot for docs/agent-architecture.md.
// These assertions cover two previously reproduced defects; they are not full correctness proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runTurn } from "../../src/agent/loop.ts";
import { nullTracer } from "../../src/agent/trace.ts";
import { createWorkerWorkspace } from "../../src/workspace/worker.ts";
import { ScriptedProvider, reply } from "../../test/helpers.ts";

async function mixedToolBatch() {
  let value = "before";
  const order = [];
  const tool = (name, dangerous, run) => ({
    spec: { name, description: "architecture probe", inputSchema: { type: "object", properties: {} } },
    dangerous,
    run,
  });
  const provider = new ScriptedProvider([
    reply("", [
      { id: "w", name: "write_file", input: {} },
      { id: "r", name: "read_file", input: {} },
    ]),
    reply("done"),
  ]);
  const result = await runTurn([], "write then read", {
    provider, system: "probe", workspace: process.cwd(), maxSteps: 3,
    approvalMode: () => "auto", confirm: async () => true, tracer: nullTracer,
    tools: [
      tool("write_file", true, async () => {
        order.push("write started");
        await delay(20);
        value = "after";
        order.push("write finished");
        return value;
      }),
      tool("read_file", false, async () => {
        order.push(`read observed ${value}`);
        return value;
      }),
    ],
  });
  const batch = result.messages.find((message) => message.role === "tool_results");
  assert.ok(batch, "The model must receive the tool results");
  assert.equal(batch.results[1].content, "after");
  assert.deepEqual(order, ["write started", "write finished", "read observed after"]);
  return { order, results: batch.results.map((item) => item.content), finishReason: result.finishReason };
}

async function workerBase() {
  const root = mkdtempSync(join(tmpdir(), "rca-architecture-base-"));
  const repo = join(root, "repo");
  const feature = join(root, "feature");
  const git = (cwd, ...args) => execFileSync("git", [
    "-c", "user.name=Architecture Probe", "-c", "user.email=probe@example.invalid", ...args,
  ], { cwd, encoding: "utf8" }).trim();
  try {
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "version.txt"), "main\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "main");
    const main = git(repo, "rev-parse", "--short", "HEAD");
    git(repo, "worktree", "add", "-q", "-b", "feature", feature);
    writeFileSync(join(feature, "version.txt"), "feature\n");
    git(feature, "add", ".");
    git(feature, "commit", "-qm", "feature");
    const parent = git(feature, "rev-parse", "--short", "HEAD");
    const worker = await createWorkerWorkspace(feature, "base-probe");
    const actual = git(worker.root, "rev-parse", "--short", "HEAD");
    assert.equal(worker.base, parent);
    assert.equal(actual, parent);
    assert.notEqual(actual, main);
    return {
      reportedBase: worker.base, parentHead: parent, mainHead: main, workerHead: actual,
      workerFile: readFileSync(join(worker.root, "version.txt"), "utf8").trim(),
    };
  } finally {
    // All probe repositories and generated worktrees are inside this newly created temporary directory.
    rmSync(root, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ mixedToolBatch: await mixedToolBatch(), workerBase: await workerBase() }, null, 2));
