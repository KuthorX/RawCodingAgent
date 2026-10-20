import { findFiles, limitLines, optionalString } from "./search.ts";
import { requireString, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

export const globTool: Tool = {
  spec: {
    name: "glob",
    description:
      'Find files by name pattern, e.g. "**/*.py" or "src/**/test_*.ts". Returns matching file paths relative to the workspace root, sorted. ' +
      ".git, node_modules, __pycache__ and virtualenv directories are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, relative to `path`" },
        path: { type: "string", description: "Directory to search in, relative to the workspace root (default: the root)" },
      },
      required: ["pattern"],
    },
  },
  dangerous: false,
  async run(input, ctx) {
    const pattern = requireString(input, "pattern");
    const dir = resolveInWorkspace(ctx.workspace, optionalString(input, "path") ?? ".");
    return limitLines(await findFiles(ctx.workspace, dir, pattern, ctx.signal), "files");
  },
};
