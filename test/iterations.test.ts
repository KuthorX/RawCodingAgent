import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PROJECT_ROOT } from "../src/app.ts";
import { commitDetail, loadIterations, webUrl } from "../src/gui/iterations.ts";
import { tempWorkspace } from "./helpers.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

test("webUrl: ssh and https remotes", () => {
  assert.equal(webUrl("git@github.com:KuthorX/learn-ai.git\n"), "https://github.com/KuthorX/learn-ai");
  assert.equal(webUrl("https://github.com/a/b.git"), "https://github.com/a/b");
  assert.equal(webUrl("https://gitlab.example.com/g/sub/repo"), "https://gitlab.example.com/g/sub/repo");
  assert.equal(webUrl("/local/path"), null);
});

test("loadIterations: commits resolved from git, unknown ones flagged, bookkeeping and filed commits not listed as unfiled", async () => {
  const dir = join(tempWorkspace(), "repo");
  mkdirSync(join(dir, "docs"), { recursive: true });
  sh(dir, "init", "-q");
  writeFileSync(join(dir, "a.txt"), "1");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "feat: first");
  const first = sh(dir, "rev-parse", "--short", "HEAD");
  writeFileSync(join(dir, "b.txt"), "2");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "fix: second");
  const write = (commits: string[]) => writeFileSync(join(dir, "docs", "iterations.json"), JSON.stringify({
    modules: { gui: "界面" },
    entries: [{ module: "gui", title: "t", problem: "p", change: "c", commits }, { module: "gui", title: "new", problem: "p", change: "c", commits: [] }],
  }));
  write([first, "deadbeef"]);
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "docs: iterations");

  const d = await loadIterations(dir);
  assert.equal(d.repoUrl, null);
  const [filed, pending] = d.entries;
  assert.equal(filed!.commits.length, 2);
  assert.equal((filed!.commits[0] as { subject: string }).subject, "feat: first");
  assert.deepEqual(filed!.commits[1], { sha: "deadbeef", missing: true });
  assert.equal(filed!.date, (filed!.commits[0] as { date: string }).date);
  assert.equal(pending!.date, null);
  // "fix: second" isn't filed; the commit that only touched docs/iterations.json is bookkeeping.
  assert.deepEqual(d.unfiled.map((c) => c.subject), ["fix: second"]);

  const detail = await commitDetail(dir, first);
  assert.match(detail.text, /feat: first[\s\S]*a\.txt/);
  await assert.rejects(commitDetail(dir, "not-a-sha"), /invalid commit/);
  await assert.rejects(commitDetail(dir, "0000000"), /not a commit of this project/);
});

test("docs/iterations.json: valid modules, and every listed commit exists", async () => {
  const d = await loadIterations(PROJECT_ROOT);
  for (const e of d.entries) {
    assert.ok(d.modules[e.module], `unknown module "${e.module}" in "${e.title}"`);
    assert.ok(e.title && e.problem && e.change, `"${e.title}" needs a title, problem and change`);
    for (const c of e.commits) assert.ok(!("missing" in c), `"${e.title}": commit ${c.sha} not found`);
  }
});
