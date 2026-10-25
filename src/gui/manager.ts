import { statSync } from "node:fs";
import type { Runtime } from "../app.ts";
import type { ApprovalMode } from "../agent/permissions.ts";
import { SessionRunner, type Budget } from "../session/runner.ts";
import type { SessionMeta } from "../session/store.ts";
import { parseTrace, totals, toolStats, turns, type Totals } from "../trace/analyze.ts";
import { normalizePath, type Project } from "../workspace/store.ts";
import { createWorkspace, describeProject, headOf, removeWorkspace, WorkspaceError, type CreateOptions, type ProjectView } from "../workspace/worktrees.ts";
import { localBranches, defaultBaseRef, repoRoot, listWorktrees } from "../workspace/git.ts";
import { HttpError } from "./http.ts";
import type { ModelOption, ModelSelection, ThinkEffort } from "../providers/catalog.ts";
import type { ProviderPatch, ProviderSummary } from "../providers/store.ts";

// Workspace operations report expected failures (dirty worktree, bad branch) with a status; keep it.
async function asHttp<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof WorkspaceError) throw new HttpError(err.status, err.message);
    throw err;
  }
}

export interface SearchHit {
  id: string;
  title: string;
  workspace: string;
  updatedAt: string;
  archived: boolean;
  matches: { role: "user" | "assistant"; snippet: string }[];
}

const SNIPPETS = 3;
const SNIPPET_CONTEXT = 40;

// The match with some text around it, on one line.
function snippet(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(q);
  const start = Math.max(0, at - SNIPPET_CONTEXT);
  const end = Math.min(flat.length, at + q.length + SNIPPET_CONTEXT * 2);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

type SpendingView = ProjectView & {
  budgetUsd: number | null;
  spentUsd: number;
  workspaces: (ProjectView["workspaces"][number] & { budgetUsd: number | null; spentUsd: number })[];
};

// Lazily loads runners so any stored session can be reopened and continued.
export class SessionManager {
  private readonly runtime: Runtime;
  private readonly runners = new Map<string, SessionRunner>();
  // Latest project views: which project a workspace belongs to needs git, the budget check must not wait for it.
  private known: ProjectView[] = [];

  constructor(runtime: Runtime) {
    this.runtime = runtime;
    this.describeProjects().catch(() => {});
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

  // Every project with its workspaces (worktrees), dirty counts and spending included.
  async describeProjects(): Promise<SpendingView[]> {
    this.known = await Promise.all(this.projects.list().map((p) => describeProject(p, this.projects)));
    const spent = this.spentByWorkspace();
    return this.known.map((p) => {
      const workspaces = p.workspaces.map((w) => ({ ...w, budgetUsd: p.workspaceBudgets?.[w.path] ?? null, spentUsd: spent.get(w.path) ?? 0 }));
      return { ...p, budgetUsd: p.budgetUsd ?? null, spentUsd: workspaces.reduce((n, w) => n + w.spentUsd, 0), workspaces };
    });
  }

  private spentByWorkspace(): Map<string, number> {
    const spent = new Map<string, number>();
    for (const s of this.list()) spent.set(s.workspace, (spent.get(s.workspace) ?? 0) + s.totals.costUsd);
    return spent;
  }

  private sessionSpent(id: string): number {
    return totals(parseTrace(this.store.readFile(id, "trace.jsonl")), this.runtime.pricing).costUsd;
  }

  // The tightest of the session's, its workspace's and its project's caps, as what is left of it.
  budgetFor(meta: SessionMeta): Budget | null {
    const candidates: Budget[] = [];
    if (typeof meta.budgetUsd === "number") {
      candidates.push({ remainingUsd: meta.budgetUsd - this.sessionSpent(meta.id), scope: "session", label: "这个会话" });
    }
    const workspace = normalizePath(meta.workspace);
    const project = this.known.find((p) => p.workspaces.some((w) => w.path === workspace));
    const projectCap = project ? this.projects.get(project.path) : undefined;
    const wsCap = projectCap?.workspaceBudgets?.[workspace];
    if (project && (typeof wsCap === "number" || typeof projectCap?.budgetUsd === "number")) {
      const spent = this.spentByWorkspace();
      if (typeof wsCap === "number") {
        const name = project.workspaces.find((w) => w.path === workspace)!.name;
        candidates.push({ remainingUsd: wsCap - (spent.get(workspace) ?? 0), scope: `workspace "${name}"`, label: `工作区 ${name} ` });
      }
      if (typeof projectCap?.budgetUsd === "number") {
        const used = project.workspaces.reduce((n, w) => n + (spent.get(w.path) ?? 0), 0);
        candidates.push({ remainingUsd: projectCap.budgetUsd - used, scope: `project "${project.name}"`, label: `项目 ${project.name} ` });
      }
    }
    return candidates.reduce<Budget | null>((min, b) => (min === null || b.remainingUsd < min.remainingUsd ? b : min), null);
  }

  setBudget(projectPath: string, budgetUsd: number | null, workspace?: string): Project {
    try {
      return this.projects.setBudget(projectPath, budgetUsd, workspace);
    } catch (err) {
      throw new HttpError(404, err instanceof Error ? err.message : String(err));
    }
  }

  get defaults() {
    return this.runtime.limits;
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

  listModels(): Promise<string[]> {
    return this.runtime.listModels?.() ?? Promise.resolve([this.runtime.model]);
  }

  async validateModel(model: string): Promise<string> {
    const normalized = model.trim();
    if (!normalized) throw new HttpError(400, "model must not be empty");
    if (!(await this.listModels()).includes(normalized)) throw new HttpError(400, `model "${normalized}" is not available`);
    return normalized;
  }

  listProviders(): ProviderSummary[] {
    return this.runtime.providers?.list() ?? [{ id: "legacy", name: "兼容端点", configured: true, keyMask: "", baseURL: "", source: "environment", defaultModel: this.runtime.model }];
  }

  updateProvider(id: string, patch: ProviderPatch): ProviderSummary {
    if (!this.runtime.providers) throw new HttpError(400, "Provider configuration is unavailable for this runtime");
    try { return this.runtime.providers.update(id, patch); }
    catch (error) { throw new HttpError(400, error instanceof Error ? error.message : "Invalid provider configuration"); }
  }

  async modelOptions(provider: string): Promise<ModelOption[]> {
    if (!this.listProviders().some((item) => item.id === provider)) throw new HttpError(400, "Unknown provider");
    if (this.runtime.modelOptions) return this.runtime.modelOptions(provider);
    if (provider !== "legacy") throw new HttpError(400, "Unknown provider");
    return (await this.listModels()).map((id) => ({ provider, id, name: id, api: "openai-completions", contextWindow: this.runtime.contextWindow(id), maxTokens: 8192, vision: false, thinkingLevels: ["off"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }));
  }

  async validateSelection(raw: { provider?: unknown; model?: unknown; thinkEffort?: unknown }, current: ModelSelection): Promise<ModelSelection> {
    const provider = raw.provider === undefined ? current.provider : raw.provider;
    if (typeof provider !== "string" || !provider.trim()) throw new HttpError(400, '"provider" must be a non-empty string');
    const descriptor = this.listProviders().find((item) => item.id === provider);
    if (!descriptor) throw new HttpError(400, "Unknown provider");
    const model = raw.model === undefined ? (provider === current.provider ? current.model : descriptor.defaultModel) : raw.model;
    if (typeof model !== "string" || !model.trim()) throw new HttpError(400, '"model" must be a non-empty string');
    const available = (await this.modelOptions(provider)).find((item) => item.id === model.trim());
    if (!available) throw new HttpError(400, `Model is not available from ${provider}`);
    const thinkEffort = raw.thinkEffort === undefined
      ? (available.thinkingLevels.includes(current.thinkEffort) ? current.thinkEffort : available.thinkingLevels[0]) : raw.thinkEffort;
    if (typeof thinkEffort !== "string" || !available.thinkingLevels.includes(thinkEffort as ThinkEffort)) throw new HttpError(400, "Thinking effort is not supported by this model");
    return { provider, model: model.trim(), thinkEffort: thinkEffort as ThinkEffort };
  }

  async setSelection(id: string, raw: { provider?: unknown; model?: unknown; thinkEffort?: unknown }): Promise<void> {
    const runner = this.get(id);
    if (runner.isBusy) throw new HttpError(409, "Stop the current turn before changing its model settings.");
    const info = runner.info;
    const selection = await this.validateSelection(raw, { provider: info.provider ?? "legacy", model: info.model, thinkEffort: info.thinkEffort ?? "off" });
    if (runner.isBusy) throw new HttpError(409, "Stop the current turn before changing its model settings.");
    const provider = this.runtime.makeProvider?.(selection);
    if (provider) runner.setModelSelection(selection, provider);
    else runner.setModel(selection.model);
  }

  get(id: string): SessionRunner {
    const existing = this.runners.get(id);
    if (existing) return existing;
    if (!this.store.exists(id)) throw new HttpError(404, `session "${id}" not found`);
    const runner = new SessionRunner({
      store: this.store,
      meta: this.store.getMeta(id),
      makeDeps: this.runtime.makeDeps,
      budget: (meta) => this.budgetFor(meta),
      compactionTokens: (meta) => Math.min(this.settings.get().compactionTokens, this.runtime.contextWindow(meta.model, meta.provider)),
      contextWindow: (meta) => this.runtime.contextWindow(meta.model, meta.provider),
      makeProvider: this.runtime.makeProvider,
      makeSystem: this.runtime.makeSystem,
    });
    this.runners.set(id, runner);
    return runner;
  }

  async create(workspace: string, approvalMode: ApprovalMode | undefined): Promise<SessionMeta> {
    const path = normalizePath(workspace);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(400, `"${path}" is not a directory`);
    await this.ensureKnown(path);
    const defaults = this.settings.get();
    let meta = this.store.create(path, defaults.defaultModel, approvalMode ?? this.runtime.defaultApprovalMode);
    meta = this.store.updateMeta(meta.id, { provider: defaults.defaultProvider, thinkEffort: defaults.defaultThinkEffort });
    this.get(meta.id);
    return meta;
  }

  // A turn running here hasn't saved its messages yet; forking now would silently drop it.
  // newWorkspace: also create a worktree whose new branch starts at the source workspace's current commit,
  // so the two sessions change files independently. Uncommitted changes don't come along; the count says how many.
  async fork(id: string, newWorkspace?: { name?: string }, approvalMode?: ApprovalMode): Promise<{ meta: SessionMeta; workspace?: unknown; uncommitted?: number; copied?: string[] }> {
    if (!this.store.exists(id)) throw new HttpError(404, `session "${id}" not found`);
    if (this.runners.get(id)?.isBusy) throw new HttpError(409, "这个会话正在运行，等这一轮结束后再 fork");
    if (!newWorkspace) {
      const meta = this.store.fork(id, { approvalMode });
      this.get(meta.id);
      return { meta };
    }
    const source = normalizePath(this.store.getMeta(id).workspace);
    const project = (await this.describeProjects()).find((p) => p.workspaces.some((w) => w.path === source));
    if (!project?.repo) throw new HttpError(400, "原会话的目录不在任何 git 项目里，不能 fork 到新工作区");
    const { commit, dirty } = await asHttp(headOf(source));
    const created = await this.createWorkspace(project, { name: newWorkspace.name, base: commit });
    const meta = this.store.fork(id, { workspace: created.workspace.path, approvalMode });
    this.get(meta.id);
    return { meta, workspace: created.workspace, uncommitted: dirty, copied: created.copied };
  }

  get settings() {
    return this.runtime.settings;
  }

  setArchived(id: string, archived: boolean): SessionMeta {
    if (!this.store.exists(id)) throw new HttpError(404, `session "${id}" not found`);
    const runner = this.runners.get(id);
    if (!runner) return this.store.updateMeta(id, { archived });
    runner.setArchived(archived);
    return runner.info;
  }

  // Deletes the session's directory (history, trace, images). A running turn must be stopped first.
  remove(id: string): void {
    if (!this.store.exists(id)) throw new HttpError(404, `session "${id}" not found`);
    const runner = this.runners.get(id);
    if (runner?.isBusy) throw new HttpError(409, "这个会话正在运行，先停止它");
    runner?.close();
    this.runners.delete(id);
    try {
      this.store.remove(id);
    } catch (err) {
      throw new HttpError(409, err instanceof Error ? err.message : String(err));
    }
  }

  // Case-insensitive match on titles, user messages and assistant replies (not tool calls); newest sessions first.
  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const meta of this.store.list()) {
      const matches = this.store
        .readDialogue(meta.id)
        .filter((m) => m.text.toLowerCase().includes(q))
        .slice(0, SNIPPETS)
        .map((m) => ({ role: m.role, snippet: snippet(m.text, q) }));
      if (matches.length === 0 && !meta.title.toLowerCase().includes(q)) continue;
      hits.push({ id: meta.id, title: meta.title, workspace: normalizePath(meta.workspace), updatedAt: meta.updatedAt, archived: meta.archived === true, matches });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  list(): (SessionMeta & { busy: boolean; totals: Totals })[] {
    return this.store.list().map((meta) => ({
      ...meta,
      workspace: normalizePath(meta.workspace), // same form as the project views' paths, for grouping
      busy: this.runners.get(meta.id)?.isBusy ?? false,
      totals: totals(parseTrace(this.store.readFile(meta.id, "trace.jsonl")), this.runtime.pricing),
    }));
  }

  // Stops every turn this process owns, waits for them to save their state, then releases the session locks.
  // Called on SIGINT/SIGTERM so a Ctrl-C does not abandon a turn that is halfway through writing files.
  async shutdown(timeoutMs = 3_000): Promise<void> {
    const runners = [...this.runners.values()];
    for (const runner of runners) runner.stop();
    const waitForIdle = Promise.all(runners.map((runner) => runner.whenIdle())).then(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref(); });
    await Promise.race([waitForIdle, timeout]);
    clearTimeout(timer);
    for (const runner of runners) {
      try { runner.close(); } catch { /* another path already released it */ }
    }
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
      contextWindow: this.runtime.contextWindow(meta.model, meta.provider),
      tools: toolStats(spans),
      turns: turns(spans),
    };
  }
}
