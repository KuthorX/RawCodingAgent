import { readFile } from "node:fs/promises";
import { requireString, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    description: "Read a UTF-8 text file. Returns the content with 1-based line numbers prefixed.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to the workspace root" } },
      required: ["path"],
    },
  },
  dangerous: false,
  async run(input, ctx) {
    const text = await readFile(resolveInWorkspace(ctx.workspace, requireString(input, "path")), "utf8");
    return text
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(5)}\t${line}`)
      .join("\n");
  },
};
