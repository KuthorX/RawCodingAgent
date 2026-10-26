import { readdir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { optionalString, toPosix } from "./search.ts";
import { ToolError, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

// Same fixed skip list as glob/grep: the model almost never wants these, and they can be enormous.
const SKIPPED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);
const MAX_DEPTH = 3;
const MAX_LINES = 400;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function optionalDepth(input: Record<string, unknown>): number {
  const raw = input.depth;
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) throw new ToolError('"depth" must be a positive integer');
  return Math.min(raw, MAX_DEPTH);
}

interface Entry {
  name: string;
  dir: boolean;
  size?: number;
  link?: string;
}

// One directory level, directories first and then files, both case-insensitive alphabetical.
async function readLevel(dir: string): Promise<Entry[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const entries: Entry[] = [];
  for (const d of dirents) {
    if (d.isDirectory() && SKIPPED_DIRS.has(d.name)) continue;
    if (d.isSymbolicLink()) {
      let target = "";
      try { target = await readlink(join(dir, d.name)); } catch { /* unreadable link: show it without a target */ }
      entries.push({ name: d.name, dir: false, link: target });
      continue;
    }
    if (d.isDirectory()) {
      entries.push({ name: d.name, dir: true });
      continue;
    }
    if (!d.isFile()) continue;
    let size: number | undefined;
    try { size = (await stat(join(dir, d.name))).size; } catch { /* raced away: still list the name */ }
    entries.push({ name: d.name, dir: false, size });
  }
  return entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.dir ? -1 : 1));
}

// A directory tree the model can orient itself in without shelling out to `ls`/`find`.
export const listDirTool: Tool = {
  spec: {
    name: "list_dir",
    description:
      "List the entries of a directory in the workspace (directories first, then files with sizes). " +
      "depth (default 1, max 3) lists subdirectories too. .git, node_modules, __pycache__ and virtualenv directories are skipped. " +
      "Use glob when you know the file name pattern; use this to see what a directory contains.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace root (default: the root)" },
        depth: { type: "integer", description: "How many levels to list (default 1, max 3)" },
      },
    },
  },
  dangerous: false,
  async run(input, ctx) {
    const rel = optionalString(input, "path") ?? ".";
    const root = resolveInWorkspace(ctx.workspace, rel, ctx.attachmentsDir ? [ctx.attachmentsDir] : []);
    const depth = optionalDepth(input);
    const info = await stat(root);
    if (!info.isDirectory()) throw new ToolError(`"${rel}" is not a directory`);

    const lines: string[] = [];
    let truncated = false;
    const walk = async (dir: string, prefix: string, level: number): Promise<void> => {
      if (truncated) return;
      if (ctx.signal?.aborted) throw new ToolError("stopped by the user");
      const entries = await readLevel(dir);
      for (const entry of entries) {
        if (lines.length >= MAX_LINES) { truncated = true; return; }
        const name = prefix + entry.name + (entry.dir ? "/" : "");
        if (entry.link !== undefined) lines.push(`${name} -> ${entry.link}`);
        else if (entry.dir) lines.push(name);
        else lines.push(`${name} (${formatSize(entry.size ?? 0)})`);
        if (entry.dir && level < depth) await walk(join(dir, entry.name), `${prefix}  `, level + 1);
      }
    };

    const label = rel === "." ? toPosix(ctx.workspace).replace(/\/$/, "").split("/").pop() || "." : toPosix(rel).replace(/\/$/, "");
    lines.push(`${label}/`);
    // The first level is indented under the header; deeper levels are indented by their parents.
    await walk(root, "  ", 1);
    if (truncated) lines.push(`[output truncated at ${MAX_LINES} entries; list a subdirectory or use glob]`);
    return lines.join("\n");
  },
};
