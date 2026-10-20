import { glob } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ToolError } from "./types.ts";

// Directories that are almost never what the model is looking for and can hold huge numbers of files.
// A fixed list rather than .gitignore, so the tools behave the same in any directory, repo or not.
const SKIPPED_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv"]);

// Results shown to the model; the rest are counted, so it knows to narrow the search.
export const MAX_RESULTS = 200;

export function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`);
  return value;
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

// Files under `dir` matching `pattern`, as sorted workspace-relative paths with forward slashes.
export async function findFiles(workspace: string, dir: string, pattern: string, signal?: AbortSignal): Promise<string[]> {
  if (isAbsolute(pattern) || pattern.split(/[\\/]/).includes("..")) {
    throw new ToolError(`pattern "${pattern}" must stay inside the search directory (no absolute paths or "..")`);
  }
  const files: string[] = [];
  for await (const entry of glob(pattern, { cwd: dir, withFileTypes: true, exclude: (d) => d.isDirectory() && SKIPPED_DIRS.has(d.name) })) {
    if (signal?.aborted) throw new ToolError("stopped by the user");
    if (entry.isFile()) files.push(toPosix(relative(workspace, join(entry.parentPath, entry.name))));
  }
  return files.sort();
}

export function limitLines(lines: string[], noun: string): string {
  if (lines.length === 0) return `no ${noun} found`;
  if (lines.length <= MAX_RESULTS) return lines.join("\n");
  return `${lines.slice(0, MAX_RESULTS).join("\n")}\n[${lines.length - MAX_RESULTS} more ${noun} not shown; narrow the search]`;
}
