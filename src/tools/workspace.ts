import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { ToolError } from "./types.ts";

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

// Where a path really leads: the deepest part that exists is resolved through symbolic links, the rest
// (a file about to be created) is appended as is.
function realTarget(path: string): string {
  for (let existing = path; ; existing = dirname(existing)) {
    try {
      return join(realpathSync(existing), relative(existing, path));
    } catch {
      if (dirname(existing) === existing) return path;
    }
  }
}

// Resolves a model-supplied path and refuses anything outside the workspace, including through a
// symbolic link inside it (one the agent made with bash, or one a cloned repo ships with).
// extraRoots are additional allowed trees; the only one today is the session's attachments directory.
export function resolveInWorkspace(workspace: string, path: string, extraRoots: readonly string[] = []): string {
  const abs = resolve(workspace, path);
  if (!isInside(workspace, abs)) {
    for (const root of extraRoots) {
      if (!isInside(root, abs)) continue;
      if (!isInside(realTarget(root), realTarget(abs))) {
        throw new ToolError(`path "${path}" leads outside the session through a symbolic link`);
      }
      return abs;
    }
    throw new ToolError(`path "${path}" is outside the workspace`);
  }
  if (!isInside(realTarget(workspace), realTarget(abs))) {
    throw new ToolError(`path "${path}" leads outside the workspace through a symbolic link`);
  }
  return abs;
}
