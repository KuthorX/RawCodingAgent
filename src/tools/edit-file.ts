import { readFile, writeFile } from "node:fs/promises";
import { toCrlf, usesCrlf } from "./eol.ts";
import { requireString, ToolError, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

export const editFileTool: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace one exact occurrence of old_string with new_string in a file. " +
      "old_string must match the file byte-for-byte (including indentation) and appear exactly once; " +
      "include surrounding lines to make it unique.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  dangerous: false,
  async run(input, ctx) {
    const path = requireString(input, "path");
    const oldString = requireString(input, "old_string");
    const newString = requireString(input, "new_string");
    if (oldString === "") throw new ToolError("old_string must not be empty; use write_file to create files");

    const abs = resolveInWorkspace(ctx.workspace, path);
    const text = await readFile(abs, "utf8");
    let [from, to] = [oldString, newString];
    // A CRLF file: match the model's \n text as \r\n, and keep the file's line endings in the replacement.
    if (usesCrlf(text) && countOccurrences(text, from) === 0) [from, to] = [toCrlf(from), toCrlf(to)];
    const count = countOccurrences(text, from);
    if (count === 0) throw new ToolError(`old_string not found in ${path}. Re-read the file and copy the text exactly.`);
    if (count > 1) throw new ToolError(`old_string matches ${count} places in ${path}. Include more context to make it unique.`);

    await writeFile(abs, text.replace(from, () => to), "utf8");
    return `Edited ${path}`;
  },
};
