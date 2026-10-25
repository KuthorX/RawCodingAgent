import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { git, GitError, isValidBranchName, listWorktrees, localBranches, repoRoot } from "./git.ts";
import { copyWorktreeInclude, workspaceNames, worktreeRoot } from "./worktrees.ts";

// A child agent's own checkout: a git worktree next to the repository, on a fresh branch from the current commit.
export interface WorkerWorkspace {
  path: string; // what the child uses as its workspace (the project subdirectory, when there is one)
  root: string; // the worktree's top directory
  branch: string;
  base: string; // short commit the branch started from
  copied: string[]; // .worktreeinclude files carried over
}

export class WorkerWorkspaceError extends Error {}

// Files the worker added, changed or committed, for the parent's summary line.
export async function workerChangeCount(workspace: WorkerWorkspace): Promise<number> {
  const status = (await git(workspace.root, ["status", "--porcelain"]).catch(() => "")).trim();
  const dirty = status ? status.split("\n").length : 0;
  const head = (await git(workspace.root, ["rev-parse", "--short", "HEAD"]).catch(() => "")).trim();
  if (!head || head === workspace.base) return dirty;
  const committed = (await git(workspace.root, ["diff", "--name-only", workspace.base, "HEAD"]).catch(() => "")).trim();
  return dirty + (committed ? committed.split("\n").length : 0);
}

// The parent session's uncommitted changes are deliberately not copied: a worktree shares only commits, so a
// worker starts from HEAD and the parent must commit or merge deliberately.
export async function createWorkerWorkspace(workspace: string, label: string): Promise<WorkerWorkspace> {
  const root = await repoRoot(workspace);
  if (!root) throw new WorkerWorkspaceError(`worker needs a git repository; "${workspace}" is not inside one`);
  await git(root, ["rev-parse", "--verify", "HEAD"]).catch(() => {
    throw new WorkerWorkspaceError("worker needs at least one commit; this repository has none");
  });
  const mainRoot = (await listWorktrees(root)).find((entry) => entry.main)?.path ?? root;
  const { dir, branch } = workspaceNames(`multi-${label}`);
  const path = worktreeRoot(mainRoot, dir);
  if (existsSync(path)) throw new WorkerWorkspaceError(`worktree directory already exists: ${path}`);
  if ((await localBranches(mainRoot)).includes(branch)) throw new WorkerWorkspaceError(`branch already exists: ${branch}`);
  if (!(await isValidBranchName(mainRoot, branch))) throw new WorkerWorkspaceError(`not a valid branch name: ${branch}`);
  const base = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  try {
    await git(mainRoot, ["worktree", "add", "-b", branch, path, "HEAD"]);
  } catch (err) {
    throw new WorkerWorkspaceError(err instanceof GitError ? err.message : String(err));
  }
  // The project may only be a subdirectory of the repository; the child should land in the same one.
  const sub = relative(root, workspace);
  const inside = sub && !sub.startsWith("..") && sub !== "." ? join(path, ...sub.split(sep)) : path;
  return { path: existsSync(inside) ? inside : path, root: path, branch, base, copied: copyWorktreeInclude(root, path) };
}
