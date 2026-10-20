import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

// A project is a directory the user opened, usually a git repository (or a folder inside one).
// Its workspaces are the repository's worktrees; see workspace/worktrees.ts.
export interface Project {
  path: string; // absolute; also the identity. The project's main workspace.
  name: string;
  addedAt: string;
  // Spending caps (USD) over all sessions of the project / of one workspace (keyed by workspace path).
  budgetUsd?: number | null;
  workspaceBudgets?: Record<string, number>;
}

// A worktree this app created. Worktrees made by hand are listed too, they just have no record here.
export interface WorktreeRecord {
  path: string; // the session workspace inside the worktree (the project's subdirectory, if any)
  root: string; // the worktree's top directory, what git knows it by
  project: string;
  branch: string;
  base: string | null; // ref the new branch started from; null when an existing branch was checked out
  createdBranch: boolean; // only a branch we created is deleted together with the worktree
  createdAt: string;
}

export function normalizePath(raw: string): string {
  const trimmed = raw.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  // Same form as git's paths after samePath(): upper-case drive letter on Windows.
  return resolve(expanded).replace(/^[a-z]:/, (d) => d.toUpperCase());
}

// A JSON array in one file, written atomically.
class JsonList<T> {
  private readonly file: string;
  private readonly valid: (item: unknown) => boolean;

  constructor(file: string, valid: (item: unknown) => boolean) {
    this.file = file;
    this.valid = valid;
  }

  read(): T[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed.filter(this.valid) as T[]) : [];
    } catch {
      return [];
    }
  }

  write(list: T[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2));
    renameSync(tmp, this.file);
  }
}

const hasPath = (item: unknown) => typeof (item as { path?: unknown })?.path === "string";

// The projects the user has opened, persisted so they survive restarts (no --cwd needed).
export class ProjectStore {
  private readonly projects: JsonList<Project>;
  private readonly worktrees: JsonList<WorktreeRecord>;

  // `legacyFile`: the list from before projects existed (.workspaces.json); moved over on first use.
  constructor(file: string, worktreesFile: string, legacyFile?: string) {
    if (legacyFile && !existsSync(file) && existsSync(legacyFile)) renameSync(legacyFile, file);
    this.projects = new JsonList(file, hasPath);
    this.worktrees = new JsonList(worktreesFile, hasPath);
  }

  list(): Project[] {
    return this.projects.read().map((p) => ({ ...p, path: normalizePath(p.path) }));
  }

  get(path: string): Project | undefined {
    const wanted = normalizePath(path);
    return this.list().find((p) => p.path === wanted);
  }

  // Adds (or returns the existing) project; the path must be an existing directory.
  add(rawPath: string, now = new Date()): Project {
    const path = normalizePath(rawPath);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`"${path}" is not a directory`);
    const existing = this.list().find((p) => p.path === path);
    if (existing) return existing;
    const project: Project = { path, name: basename(path) || path, addedAt: now.toISOString() };
    this.projects.write([...this.list(), project]);
    return project;
  }

  // workspace: set that workspace's cap instead of the project's. null removes the cap.
  setBudget(projectPath: string, budgetUsd: number | null, workspace?: string): Project {
    const path = normalizePath(projectPath);
    const list = this.list();
    const project = list.find((p) => p.path === path);
    if (!project) throw new Error(`project "${path}" not found`);
    let updated: Project;
    if (workspace === undefined) {
      updated = { ...project, budgetUsd };
    } else {
      const budgets = { ...project.workspaceBudgets };
      if (budgetUsd === null) delete budgets[normalizePath(workspace)];
      else budgets[normalizePath(workspace)] = budgetUsd;
      updated = { ...project, workspaceBudgets: budgets };
    }
    this.projects.write(list.map((p) => (p.path === path ? updated : p)));
    return updated;
  }

  // Removes from the list only; files, worktrees and sessions are untouched.
  remove(rawPath: string): boolean {
    const path = normalizePath(rawPath);
    const list = this.list();
    if (!list.some((p) => p.path === path)) return false;
    this.projects.write(list.filter((p) => p.path !== path));
    return true;
  }

  worktreeRecords(): WorktreeRecord[] {
    return this.worktrees.read();
  }

  worktreeRecord(root: string): WorktreeRecord | undefined {
    const wanted = normalizePath(root);
    return this.worktreeRecords().find((w) => normalizePath(w.root) === wanted);
  }

  addWorktreeRecord(record: WorktreeRecord): void {
    this.worktrees.write([...this.worktreeRecords().filter((w) => w.root !== record.root), record]);
  }

  removeWorktreeRecord(root: string): void {
    const wanted = normalizePath(root);
    this.worktrees.write(this.worktreeRecords().filter((w) => normalizePath(w.root) !== wanted));
  }
}
