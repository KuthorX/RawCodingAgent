import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

export interface Workspace {
  path: string; // absolute; also the identity
  name: string;
  addedAt: string;
}

export function normalizeWorkspacePath(raw: string): string {
  const trimmed = raw.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/") ? homedir() + trimmed.slice(1) : trimmed;
  return resolve(expanded);
}

// The list of workspaces the user has opened, persisted so they survive restarts (no --cwd needed).
export class WorkspaceStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  list(): Workspace[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(parsed) ? (parsed as Workspace[]).filter((w) => typeof w?.path === "string") : [];
    } catch {
      return [];
    }
  }

  // Adds (or returns the existing) workspace; the path must be an existing directory.
  add(rawPath: string, now = new Date()): Workspace {
    const path = normalizeWorkspacePath(rawPath);
    if (!statSync(path, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`"${path}" is not a directory`);
    const existing = this.list().find((w) => w.path === path);
    if (existing) return existing;
    const workspace: Workspace = { path, name: basename(path) || path, addedAt: now.toISOString() };
    this.save([...this.list(), workspace]);
    return workspace;
  }

  // Removes from the list only; files and sessions are untouched.
  remove(rawPath: string): boolean {
    const path = normalizeWorkspacePath(rawPath);
    const list = this.list();
    if (!list.some((w) => w.path === path)) return false;
    this.save(list.filter((w) => w.path !== path));
    return true;
  }

  private save(list: Workspace[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list, null, 2));
    renameSync(tmp, this.file);
  }
}
