import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { requireString, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

export const writeFileTool: Tool = {
  spec: {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Parent directories are created as needed.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
  },
  dangerous: false,
  async run(input, ctx) {
    const path = requireString(input, "path");
    const content = requireString(input, "content");
    const abs = resolveInWorkspace(ctx.workspace, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, "utf8");
    return `Wrote ${content.length} chars to ${path}`;
  },
};
