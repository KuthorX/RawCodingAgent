import { readFile } from "node:fs/promises";
import { requireString, ToolError, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

// Lines returned when no limit is given; longer files say how to read the rest.
const DEFAULT_LIMIT = 2000;

function optionalPositiveInt(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new ToolError(`"${key}" must be a positive integer`);
  return value;
}

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    description:
      "Read a UTF-8 text file. Returns the content with 1-based line numbers prefixed. " +
      `For a part of a long file, pass offset (first line, 1-based) and limit (number of lines); at most ${DEFAULT_LIMIT} lines are returned by default.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        offset: { type: "integer", description: "First line to return, 1-based (default 1)" },
        limit: { type: "integer", description: `Number of lines to return (default ${DEFAULT_LIMIT})` },
      },
      required: ["path"],
    },
  },
  dangerous: false,
  async run(input, ctx) {
    const path = requireString(input, "path");
    const offset = optionalPositiveInt(input, "offset") ?? 1;
    const limit = optionalPositiveInt(input, "limit") ?? DEFAULT_LIMIT;
    const text = await readFile(resolveInWorkspace(ctx.workspace, path), "utf8");
    // Split on \n only and drop a trailing \r, so CRLF files show the same text the model will pass to edit_file.
    const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
    if (text.endsWith("\n")) lines.pop();
    if (offset > lines.length) throw new ToolError(`offset ${offset} is past the end of ${path} (${lines.length} lines)`);
    const end = Math.min(lines.length, offset - 1 + limit);
    const shown = lines
      .slice(offset - 1, end)
      .map((line, i) => `${String(offset + i).padStart(5)}\t${line}`)
      .join("\n");
    if (offset === 1 && end === lines.length) return shown;
    const more = end < lines.length ? `; continue with offset ${end + 1}` : "";
    return `${shown}\n[lines ${offset}-${end} of ${lines.length}${more}]`;
  },
};
