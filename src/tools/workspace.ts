import { isAbsolute, relative, resolve } from "node:path";
import { ToolError } from "./types.ts";

// Resolves a model-supplied path and refuses anything outside the workspace.
export function resolveInWorkspace(workspace: string, path: string): string {
  const abs = resolve(workspace, path);
  const rel = relative(workspace, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new ToolError(`path "${path}" is outside the workspace`);
  }
  return abs;
}
