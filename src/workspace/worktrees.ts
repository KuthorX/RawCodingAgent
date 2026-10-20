import { cpSync, existsSync, globSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { defaultBaseRef, dirtyCount, git, GitError, isValidBranchName, listWorktrees, localBranches, repoRoot, samePath, type GitWorktree } from "./git.ts";
import type { Project, ProjectStore } from "./store.ts";

// One place an agent can work in: the project directory itself, or the same directory inside another worktree.
export interface WorkspaceView {
  path: string; // what sessions use as their workspace
  root: string | null; // the git worktree's top directory; null outside git
  name: string;
  branch: string | null;
  main: boolean; // the project's own directory
  dirty: number | null; // files git status reports; null when unknown
  managed: boolean; // created by this app (its branch may be deleted with it)
  missing: boolean; // the directory is gone (deleted by hand, or the branch lacks the project's subdirectory)
}

export interface ProjectView extends Project {
  repo: string | null; // top of the repository checkout the project lives in; null when not in git
  subdir: string; // project path relative to that checkout ("" when the project is the repo root)
  workspaces: WorkspaceView[];
}

export class WorkspaceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function slug(name: string, now = new Date()): string {
  const s = name.trim().replace(/\s+/g, "-").replace(/[^\w.-]/g, "").replace(/^[.-]+/, "");
  if (s) return s.slice(0, 60);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(now.getMonth() + 1)}${p(now.getDate())}-${Math.random().toString(16).slice(2, 5)}`;
}

// <repo>.worktrees/<name>, next to the main checkout: outside the repository, so the main checkout's
// glob/grep and git status never see it, and on the same disk.
export function worktreeRoot(mainRoot: string, name: string): string {
  return join(dirname(mainRoot), `${basename(mainRoot)}.worktrees`, name);
}

async function gitContext(project: Project): Promise<{ repo: string; subdir: string; worktrees: GitWorktree[] }> {
  const repo = await repoRoot(project.path);
  if (!repo) throw new WorkspaceError(400, `"${project.path}" 不在 git 仓库里，不能新建工作区`);
  return { repo, subdir: relative(repo, project.path), worktrees: await listWorktrees(repo) };
}

export async function describeProject(project: Project, store: ProjectStore): Promise<ProjectView> {
  const repo = await repoRoot(project.path);
  if (!repo) {
    const main: WorkspaceView = { path: project.path, root: null, name: "主目录", branch: null, main: true, dirty: null, managed: false, missing: false };
    return { ...project, repo: null, subdir: "", workspaces: [main] };
  }
  const subdir = relative(repo, project.path);
  const worktrees = await listWorktrees(repo).catch(() => [] as GitWorktree[]);
  // The project's own checkout first (it may itself be a linked worktree), then the others in git's order.
  const own = worktrees.find((w) => w.path === repo);
  const others = worktrees.filter((w) => w !== own);
  const views = await Promise.all(
    [own, ...others].map(async (w): Promise<WorkspaceView> => {
      const main = w === own;
      const root = w?.path ?? repo;
      const path = main ? project.path : samePath(join(root, subdir));
      const missing = !statSync(path, { throwIfNoEntry: false })?.isDirectory();
      return {
        path,
        root,
        name: main ? "主目录" : basename(root),
        branch: w?.branch ?? null,
        main,
        dirty: missing ? null : await dirtyCount(path),
        managed: !main && store.worktreeRecord(root) !== undefined,
        missing,
      };
    }),
  );
  return { ...project, repo, subdir, workspaces: views };
}

export interface CreateOptions {
  name?: string;
  // Check out this existing branch instead of creating agent/<name>. It is never deleted with the worktree.
  branch?: string;
  // Start point of the new branch (default: the repository's default branch, see defaultBaseRef).
  base?: string;
}

export interface Created {
  workspace: WorkspaceView;
  copied: string[]; // files copied because .worktreeinclude lists them
}

// Gitignored files a new worktree needs (.env and the like), one path or glob per line, like Orca's .worktreeinclude.
export function copyWorktreeInclude(from: string, to: string): string[] {
  const list = join(from, ".worktreeinclude");
  if (!existsSync(list)) return [];
  const patterns = readFileSync(list, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const copied: string[] = [];
  for (const pattern of patterns) {
    for (const rel of globSync(pattern, { cwd: from })) {
      const target = join(to, rel);
      if (existsSync(target)) continue; // tracked files already came with the checkout
      cpSync(join(from, rel), target, { recursive: true });
      copied.push(rel.replace(/\\/g, "/"));
    }
  }
  return copied;
}

export async function createWorkspace(project: Project, store: ProjectStore, options: CreateOptions, now = new Date()): Promise<Created> {
  const { repo, subdir, worktrees } = await gitContext(project);
  const mainRoot = worktrees.find((w) => w.main)?.path ?? repo;
  const name = slug(options.name ?? "", now);
  const root = worktreeRoot(mainRoot, name);
  if (existsSync(root)) throw new WorkspaceError(409, `目录 "${root}" 已存在，换个名字`);

  let branch: string;
  let base: string | null = null;
  if (options.branch) {
    branch = options.branch;
    if (!(await localBranches(repo)).includes(branch)) throw new WorkspaceError(400, `没有本地分支 "${branch}"`);
    const holder = worktrees.find((w) => w.branch === branch);
    if (holder) throw new WorkspaceError(409, `分支 "${branch}" 已经在 ${holder.path} 里检出了`);
    await run(git(repo, ["worktree", "add", root, branch]));
  } else {
    branch = `agent/${name}`;
    if (!(await isValidBranchName(repo, branch))) throw new WorkspaceError(400, `"${branch}" 不是合法的分支名`);
    if ((await localBranches(repo)).includes(branch)) throw new WorkspaceError(409, `分支 "${branch}" 已存在，换个名字或选"使用已有分支"`);
    base = options.base?.trim() || (await defaultBaseRef(repo));
    await run(git(repo, ["worktree", "add", "--no-track", "-b", branch, root, base]));
  }

  const copied = copyWorktreeInclude(repo, samePath(root));
  const path = samePath(join(root, subdir));
  store.addWorktreeRecord({ path, root: samePath(root), project: project.path, branch, base, createdBranch: !options.branch, createdAt: now.toISOString() });
  const missing = !existsSync(path);
  return {
    workspace: { path, root: samePath(root), name, branch, main: false, dirty: missing ? null : await dirtyCount(path), managed: true, missing },
    copied,
  };
}

export interface Removed {
  branch: string | null;
  branchDeleted: boolean;
  note: string | null; // why the branch was kept, for the user
}

// Refuses a worktree with uncommitted or untracked files unless forced (like Orca).
// A branch this app created is deleted with `git branch -d`, which keeps it when it has unmerged commits.
export async function removeWorkspace(project: Project, store: ProjectStore, root: string, force: boolean): Promise<Removed> {
  const { repo, worktrees } = await gitContext(project);
  const target = worktrees.find((w) => w.path === samePath(root));
  if (!target) throw new WorkspaceError(404, `"${root}" 不是这个项目的工作区`);
  if (target.main || target.path === repo) throw new WorkspaceError(400, "项目的主目录不能删除");
  // Directory deleted by hand. git < 2.31 doesn't mark such entries "prunable", so check the disk too.
  const gone = target.prunable || !existsSync(target.path);
  if (!force && !gone) {
    const dirty = await dirtyCount(target.path);
    if (dirty) throw new WorkspaceError(409, `工作区里有 ${dirty} 个未提交或未跟踪的文件`);
  }
  if (gone) await run(git(repo, ["worktree", "prune"]));
  else await run(git(repo, ["worktree", "remove", ...(force ? ["--force"] : []), target.path]));

  const record = store.worktreeRecord(target.path);
  store.removeWorktreeRecord(target.path);
  if (!target.branch || !record?.createdBranch) return { branch: target.branch, branchDeleted: false, note: null };
  try {
    await git(repo, ["branch", "-d", target.branch]);
    return { branch: target.branch, branchDeleted: true, note: null };
  } catch {
    return { branch: target.branch, branchDeleted: false, note: `分支 ${target.branch} 有还没合并的提交，已保留（确认不要了可以 git branch -D）` };
  }
}

// For "fork into a new workspace": the new branch starts at the source workspace's current commit.
export async function headOf(path: string): Promise<{ commit: string; dirty: number }> {
  const commit = (await run(git(path, ["rev-parse", "HEAD"]))).trim();
  return { commit, dirty: (await dirtyCount(path)) ?? 0 };
}

// git's own message is the most useful thing to show when a command fails.
async function run(p: Promise<string>): Promise<string> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof GitError) throw new WorkspaceError(400, `git: ${err.message}`);
    throw err;
  }
}
