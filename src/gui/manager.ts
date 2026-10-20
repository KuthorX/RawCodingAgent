import { statSync } from "node:fs";
import type { Runtime } from "../app.ts";
import type { ApprovalMode } from "../agent/permissions.ts";
import { SessionRunner } from "../session/runner.ts";
import type { SessionMeta } from "../session/store.ts";
import { parseTrace, totals, toolStats, turns, type Totals } from "../trace/analyze.ts";
import { normalizePath, type Project } from "../workspace/store.ts";
import { createWorkspace, describeProject, headOf, removeWorkspace, WorkspaceError, type CreateOptions, type ProjectView } from "../workspace/worktrees.ts";
import { localBranches, defaultBaseRef, repoRoot, listWorktrees } from "../workspace/git.ts";
import { HttpError } from "./http.ts";

// Workspace operations report expected failures (dirty worktree, bad branch) with a status; keep it.
async function asHttp<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof WorkspaceError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

// Lazily loads runners so any stored session can be reopened and continued.
export class SessionManager {
  private readonly runtime: Runtime;
  private readonly runners = new Map<string, SessionRunner>();

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  get projects() {
    return this.runtime.projects;
  }

  // Registers the project (if needed) and validates it is a directory.
  openProject(path: string): Project {
    try {
      return this.projects.add(path);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
  }

  project(path: unknown): Project {
    const project = typeof path === "string" ? this.projects.get(path) : undefined;
    if (!project) throw new HttpError(404, `project "${String(path)}" not found`);
    return project;
  }

  // Every project with its workspaces (worktrees), dirty counts included.
  describeProjects(): Promise<ProjectView[]> {
    return Promise.all(this.projects.list().map((p) => describeProject(p, this.projects)));
  }

  async branches(project: Project): Promise<{ branches: string[]; base: string }> {
    const repo = await repoRoot(project.path);
    if (!repo) throw new HttpError(400, "不是 git 仓库");
    const checkedOut = new Set((await listWorktrees(repo)).map((w) => w.branch));
    return { branches: (await localBranches(repo)).filter((b) => !checkedOut.has(b)), base: await defaultBaseRef(repo) };
  }

  createWorkspace(project: Project, options: CreateOptions) {
    return asHttp(createWorkspace(project, this.projects, options));
  }

  // Sessions still running there would lose their directory mid-command.
  removeWorkspace(project: Project, root: string, force: boolean) {
    const inside = normalizePath(root);
    const busy = [...this.runners.values()].filter((r) => r.isBusy && normalizePath(r.info.workspace).startsWith(inside));
    if (busy.length > 0) throw new HttpError(409, `这个工作区里有 ${busy.length} 个会话正在运行，先停止它们`);
    return asHttp(removeWorkspace(project, this.projects, root, force));
  }

  // Sessions belong to a workspace; a directory no project knows about becomes a new project.
  private async ensureKnown(path: string): Promise<void> {
    const known = (await this.describeProjects()).some((p) => p.workspaces.some((w) => w.path === path));
    if (!known) this.openProject(path);
  }

  get store() {
    return this.runtime.store;
  }

  get(id: string): SessionRunner {
    const existing = this.runners.get(id);
    if (existing) return existing;
    if (!this.store.exists(id)) throw new HttpError(404, `session "${id}" not found`);
    const runner = new SessionRunner({ store: this.store, meta: this.store.getMeta(id), makeDeps: this.runtime.makeDeps });
    this.runners.set(id, runner);
    return runner;
  }

  async create(workspace: string, approvalMode: ApprovalMode | undefined): Promise<SessionMeta> {
    const path = normalizePath(workspace);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(400, `"${path}" is not a directory`);
    await this.ensureKnown(path);
    const meta = this.store.create(path, this.runtime.model, approvalMode ?? this.runtime.defaultApprovalMode);
    this.get(meta.id);
    return meta;
  }

  // A turn running here hasn't saved its messages yet; forking now would silently drop it.
  // newWorkspace: also create a worktree whose new branch starts at the source workspace's current commit,
  // so the two sessions change files independently. Uncommitted changes don't come along; the count says how many.
  async fork(id: string, newWorkspace?: { name?: string }): Promise<{ meta: SessionMeta; workspace?: unknown; uncommitted?: number; copied?: string[] }> {
    if (!this.store.exists(id)) throw new HttpError(404, `session "${id}" not found`);
    if (this.runners.get(id)?.isBusy) throw new HttpError(409, "这个会话正在运行，等这一轮结束后再 fork");
    if (!newWorkspace) {
      const meta = this.store.fork(id);
      this.get(meta.id);
      return { meta };
    }
    const source = normalizePath(this.store.getMeta(id).workspace);
    const project = (await this.describeProjects()).find((p) => p.workspaces.some((w) => w.path === source));
    if (!project?.repo) throw new HttpError(400, "原会话的目录不在任何 git 项目里，不能 fork 到新工作区");
    const { commit, dirty } = await asHttp(headOf(source));
    const created = await this.createWorkspace(project, { name: newWorkspace.name, base: commit });
    const meta = this.store.fork(id, { workspace: created.workspace.path });
    this.get(meta.id);
    return { meta, workspace: created.workspace, uncommitted: dirty, copied: created.copied };
  }

  list(): (SessionMeta & { busy: boolean; totals: Totals })[] {
    return this.store.list().map((meta) => ({
      ...meta,
      workspace: normalizePath(meta.workspace), // same form as the project views' paths, for grouping
      busy: this.runners.get(meta.id)?.isBusy ?? false,
      totals: totals(parseTrace(this.store.readFile(meta.id, "trace.jsonl")), this.runtime.pricing),
    }));
  }

  // Read-only: doesn't open a runner, so it works while another process (e.g. an eval run) holds the session lock.
  stats(id: string) {
    if (!this.store.exists(id)) throw new HttpError(404, `session "${id}" not found`);
    const meta = { ...this.store.getMeta(id), busy: this.runners.get(id)?.isBusy ?? false };
    const spans = parseTrace(this.store.readFile(id, "trace.jsonl"));
    return {
      meta,
      dir: this.store.filePath(id, "meta.json").replace(/meta\.json$/, ""),
      tracePath: this.store.tracePath(id),
      totals: totals(spans, this.runtime.pricing),
      pricing: this.runtime.pricing,
      tools: toolStats(spans),
      turns: turns(spans),
    };
  }
}
