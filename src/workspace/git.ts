import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const TIMEOUT_MS = 60_000;

export class GitError extends Error {}

// Runs git without a shell; rejects with git's own stderr so it can be shown as is.
export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("git", args, { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) fail(new GitError((stderr || err.message).trim()));
      else done(stdout);
    });
  });
}

// git prints E:/code/x on Windows; the rest of the app uses E:\code\x. Drive letters are compared upper-case.
export function samePath(path: string): string {
  const absolute = resolve(path);
  let current = absolute;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute.replace(/^[a-z]:/, (d) => d.toUpperCase());
    tail.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync.native(current), ...tail).replace(/^[a-z]:/, (d) => d.toUpperCase());
}

// Top of the repository containing `path`, or null when it isn't inside a git work tree.
export async function repoRoot(path: string): Promise<string | null> {
  try {
    return samePath((await git(path, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return null;
  }
}

export interface GitWorktree {
  path: string;
  head: string | null; // commit, null for a fresh repo without commits
  branch: string | null; // short name, null when detached
  main: boolean; // the repository's own checkout (first entry)
  prunable: boolean; // directory is gone; `git worktree prune` would drop it
}

// `git worktree list --porcelain`: blocks separated by blank lines, the first one is the main worktree.
export function parseWorktreeList(text: string): GitWorktree[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").filter(Boolean))
    .filter((lines) => lines.some((l) => l.startsWith("worktree ")))
    .map((lines, i) => ({ lines, main: i === 0 }))
    // A bare repository has no files to work in.
    .filter(({ lines }) => !lines.includes("bare"))
    .map(({ lines, main }) => {
      const field = (name: string) => lines.find((l) => l === name || l.startsWith(name + " "))?.slice(name.length + 1);
      const branch = field("branch");
      return {
        path: samePath(field("worktree")!),
        head: field("HEAD") ?? null,
        branch: branch ? branch.replace(/^refs\/heads\//, "") : null,
        main,
        prunable: lines.some((l) => l.startsWith("prunable")),
      };
    });
}

export async function listWorktrees(root: string): Promise<GitWorktree[]> {
  return parseWorktreeList(await git(root, ["worktree", "list", "--porcelain"]));
}

// Files that `git status` reports: changed, staged or untracked. null when git can't tell (e.g. directory gone).
export async function dirtyCount(path: string): Promise<number | null> {
  try {
    const out = await git(path, ["status", "--porcelain", "--untracked-files=all"]);
    return out.split("\n").filter(Boolean).length;
  } catch {
    return null;
  }
}

export async function localBranches(root: string): Promise<string[]> {
  const out = await git(root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function refExists(root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// Same order as Orca: the remote's default branch first, then the usual names, else whatever is checked out.
export async function defaultBaseRef(root: string): Promise<string> {
  for (const ref of ["origin/HEAD", "origin/main", "origin/master", "main", "master"]) {
    if (await refExists(root, ref)) return ref === "origin/HEAD" ? (await git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"])).trim() : ref;
  }
  return "HEAD";
}

export async function isValidBranchName(root: string, name: string): Promise<boolean> {
  try {
    await git(root, ["check-ref-format", "--branch", name]);
    return true;
  } catch {
    return false;
  }
}

export interface WorkingTreeDiff {
  isRepo: boolean;
  diff: string;
  files: { path: string; status: string }[];
  truncated: boolean;
}

const MAX_DIFF_CHARS = 200_000;

// Uncommitted changes in a workspace, for the review panel. Untracked files are listed but not expanded:
// they are exactly the files the agent created, and a huge generated file should not bloat the response.
export async function workingTreeDiff(path: string): Promise<WorkingTreeDiff> {
  if (!(await repoRoot(path))) return { isRepo: false, diff: "", files: [], truncated: false };
  const [status, tracked] = await Promise.all([
    git(path, ["status", "--porcelain=v1", "--untracked-files=all"]),
    git(path, ["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/"]),
  ]);
  const files = status
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ status: line.slice(0, 2).trim() || "M", path: line.slice(3) }));
  const untracked = files.filter((f) => f.status === "??");
  const extra = untracked.length > 0 ? `\n\n# untracked files (not shown in the diff above)\n${untracked.map((f) => `?? ${f.path}`).join("\n")}\n` : "";
  const all = tracked + extra;
  return { isRepo: true, diff: all.slice(0, MAX_DIFF_CHARS), files, truncated: all.length > MAX_DIFF_CHARS };
}
