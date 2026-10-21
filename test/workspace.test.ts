import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { parseWorktreeList, samePath } from "../src/workspace/git.ts";
import { normalizePath, ProjectStore } from "../src/workspace/store.ts";
import { createWorkspace, describeProject, headOf, removeWorkspace, workspaceNames, worktreeRoot } from "../src/workspace/worktrees.ts";
import { tempWorkspace } from "./helpers.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });

// A repo with one commit, an app/ subdirectory, an ignored .env and a .worktreeinclude listing it.
function repo(): string {
  const dir = samePath(join(tempWorkspace(), "repo"));
  mkdirSync(join(dir, "app"), { recursive: true });
  sh(dir, "init", "-q");
  sh(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(dir, "app", "main.py"), "print(1)\n");
  writeFileSync(join(dir, ".gitignore"), ".env\n");
  writeFileSync(join(dir, ".worktreeinclude"), "# copied into new worktrees\n.env\n");
  writeFileSync(join(dir, ".env"), "KEY=1\n");
  sh(dir, "add", "-A");
  sh(dir, "commit", "-qm", "init");
  return dir;
}

const stores = () => {
  const dir = tempWorkspace();
  return new ProjectStore(join(dir, "projects.json"), join(dir, "worktrees.json"));
};

test("project store adds, dedupes, persists and removes; .workspaces.json is migrated", () => {
  const root = tempWorkspace();
  const dir = join(root, "my-repo");
  mkdirSync(dir);
  writeFileSync(join(root, "workspaces.json"), JSON.stringify([{ path: dir, name: "my-repo", addedAt: "t" }]));
  const store = new ProjectStore(join(root, "projects.json"), join(root, "worktrees.json"), join(root, "workspaces.json"));
  assert.equal(store.list().length, 1);
  assert.equal(existsSync(join(root, "workspaces.json")), false);
  assert.equal(store.add(dir + "/").addedAt, "t");
  assert.throws(() => store.add(join(root, "missing")), /not a directory/);
  assert.equal(store.remove(dir), true);
  assert.equal(store.remove(dir), false);
  assert.deepEqual(store.list(), []);
});

test("a corrupt project file reads as empty; ~ expands", () => {
  const dir = tempWorkspace();
  writeFileSync(join(dir, "p.json"), "{not json");
  assert.deepEqual(new ProjectStore(join(dir, "p.json"), join(dir, "w.json")).list(), []);
  assert.equal(normalizePath("~"), normalizePath(homedir()));
  assert.equal(normalizePath("~/x"), normalizePath(join(homedir(), "x")));
});

test("parseWorktreeList: main first, detached and prunable entries, bare skipped", () => {
  const text = [
    "worktree /r/main", "HEAD abc", "branch refs/heads/main", "",
    "worktree /r/x", "HEAD def", "detached", "prunable gitdir file points to non-existent location", "",
  ].join("\n");
  const list = parseWorktreeList(text);
  assert.deepEqual(list.map((w) => [w.main, w.branch, w.prunable]), [[true, "main", false], [false, null, true]]);
  assert.deepEqual(parseWorktreeList("worktree /r/bare.git\nbare\n"), []);
});

test("a non-git project has only its main workspace", async () => {
  const store = stores();
  const project = store.add(tempWorkspace());
  const view = await describeProject(project, store);
  assert.equal(view.repo, null);
  assert.deepEqual(view.workspaces.map((w) => [w.name, w.main]), [["主目录", true]]);
  await assert.rejects(createWorkspace(project, store, {}), /不在 git 仓库里/);
});

test("create a workspace: new branch next to the repo, .worktreeinclude copied, subdirectory followed", async () => {
  const dir = repo();
  const store = stores();
  const project = store.add(join(dir, "app")); // a project inside the repo, like learn-ai/raw-coding-agent
  const { workspace, copied } = await createWorkspace(project, store, { name: "fix login" });
  const root = worktreeRoot(dir, "fix-login");
  assert.equal(root, join(dirname(dir), `${basename(dir)}.worktrees`, "fix-login"));
  assert.equal(workspace.root, samePath(root));
  assert.equal(workspace.path, samePath(join(root, "app")));
  assert.equal(workspace.branch, "agent/fix-login");
  assert.deepEqual(copied, [".env"]);
  assert.equal(readFileSync(join(root, ".env"), "utf8"), "KEY=1\n");

  const view = await describeProject(project, store);
  assert.deepEqual(view.workspaces.map((w) => [w.name, w.main, w.branch, w.managed]), [
    ["主目录", true, "main", false],
    ["fix-login", false, "agent/fix-login", true],
  ]);
  await assert.rejects(createWorkspace(project, store, { name: "fix login" }), /已存在/);
});

test("a workspace name with slashes is the full branch name", async () => {
  assert.deepEqual(workspaceNames("fix login"), { dir: "fix-login", branch: "agent/fix-login" });
  assert.deepEqual(workspaceNames("feat/login page"), { dir: "feat-login-page", branch: "feat/login-page" });
  assert.deepEqual(workspaceNames(" /feat//.x/ "), { dir: "feat-x", branch: "feat/x" });
  assert.match(workspaceNames("").branch, /^agent\/\d{4}-[0-9a-f]+$/);
  const dir = repo();
  const store = stores();
  const { workspace } = await createWorkspace(store.add(dir), store, { name: "feat/login" });
  assert.equal(workspace.branch, "feat/login");
  assert.equal(workspace.name, "feat-login");
  assert.equal(workspace.root, samePath(worktreeRoot(dir, "feat-login")));
});

test("create a workspace on an existing branch; it survives removal", async () => {
  const dir = repo();
  sh(dir, "branch", "feature");
  const store = stores();
  const project = store.add(dir);
  await assert.rejects(createWorkspace(project, store, { branch: "nope" }), /没有本地分支/);
  await assert.rejects(createWorkspace(project, store, { branch: "main" }), /已经在 .* 里检出了/);
  const { workspace } = await createWorkspace(project, store, { name: "f", branch: "feature" });
  assert.equal(workspace.branch, "feature");
  const removed = await removeWorkspace(project, store, workspace.root!, false);
  assert.deepEqual(removed, { branch: "feature", branchDeleted: false, note: null });
  assert.match(sh(dir, "branch"), /feature/);
});

test("remove a workspace: refuses uncommitted files unless forced, deletes a merged branch, keeps an unmerged one", async () => {
  const dir = repo();
  const store = stores();
  const project = store.add(dir);
  await assert.rejects(removeWorkspace(project, store, dir, true), /主目录不能删除/);

  const a = (await createWorkspace(project, store, { name: "a" })).workspace;
  writeFileSync(join(a.root!, "scratch.txt"), "x");
  await assert.rejects(removeWorkspace(project, store, a.root!, false), /1 个未提交或未跟踪的文件/);
  assert.deepEqual(await removeWorkspace(project, store, a.root!, true), { branch: "agent/a", branchDeleted: true, note: null });
  assert.equal(existsSync(a.root!), false);
  assert.doesNotMatch(sh(dir, "branch"), /agent\/a/);

  const b = (await createWorkspace(project, store, { name: "b" })).workspace;
  writeFileSync(join(b.root!, "new.txt"), "x");
  sh(b.root!, "add", "-A");
  sh(b.root!, "commit", "-qm", "work");
  const kept = await removeWorkspace(project, store, b.root!, false);
  assert.equal(kept.branchDeleted, false);
  assert.match(kept.note!, /还没合并的提交/);
  assert.match(sh(dir, "branch"), /agent\/b/);
});

test("headOf: a fork's new workspace starts at the source's commit", async () => {
  const dir = repo();
  const store = stores();
  const project = store.add(dir);
  writeFileSync(join(dir, "dirty.txt"), "x");
  const { commit, dirty } = await headOf(dir);
  assert.equal(dirty, 1);
  const { workspace } = await createWorkspace(project, store, { name: "fork", base: commit });
  assert.equal(sh(workspace.root!, "rev-parse", "HEAD").trim(), commit);
  assert.equal(existsSync(join(workspace.root!, "dirty.txt")), false);
});
