import type { Runtime } from "../app.ts";
import type { ApprovalMode } from "../agent/permissions.ts";
import { SessionRunner } from "../session/runner.ts";
import type { SessionMeta } from "../session/store.ts";
import { parseTrace, totals, toolStats, turns, type Totals } from "../trace/analyze.ts";
import { HttpError } from "./http.ts";

// Lazily loads runners so any stored session can be reopened and continued.
export class SessionManager {
  private readonly runtime: Runtime;
  private readonly runners = new Map<string, SessionRunner>();

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  get workspaces() {
    return this.runtime.workspaces;
  }

  // Registers the workspace (if needed) and validates it is a directory.
  openWorkspace(path: string) {
    try {
      return this.workspaces.add(path);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
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

  create(workspace: string, approvalMode: ApprovalMode | undefined): SessionMeta {
    const { path } = this.openWorkspace(workspace);
    const meta = this.store.create(path, this.runtime.model, approvalMode ?? this.runtime.defaultApprovalMode);
    this.get(meta.id);
    return meta;
  }

  list(): (SessionMeta & { busy: boolean; totals: Totals })[] {
    return this.store.list().map((meta) => ({
      ...meta,
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
