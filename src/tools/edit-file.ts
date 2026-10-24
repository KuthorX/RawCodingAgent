import { readFile, writeFile } from "node:fs/promises";
import { toCrlf, usesCrlf } from "./eol.ts";
import { requireString, ToolError, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) count++;
  return count;
}

interface Edit {
  oldString: string;
  newString: string;
}

// Either one old_string/new_string pair or an `edits` array (several changes to one file in one call).
function readEdits(input: Record<string, unknown>): Edit[] {
  if (input.edits === undefined) return [{ oldString: requireString(input, "old_string"), newString: requireString(input, "new_string") }];
  if (input.old_string !== undefined || input.new_string !== undefined) throw new ToolError("pass either old_string/new_string or edits, not both");
  if (!Array.isArray(input.edits) || input.edits.length === 0) throw new ToolError('"edits" must be a non-empty array');
  return input.edits.map((e: unknown, i) => {
    if (e === null || typeof e !== "object") throw new ToolError(`edits[${i}] must be an object with old_string and new_string`);
    const item = e as Record<string, unknown>;
    try {
      return { oldString: requireString(item, "old_string"), newString: requireString(item, "new_string") };
    } catch (err) {
      throw new ToolError(`edits[${i}]: ${(err as Error).message}`);
    }
  });
}

// Applies one edit to the text, or explains why it can't.
function applyEdit(text: string, edit: Edit, where: string): string {
  if (edit.oldString === "") throw new ToolError(`old_string must not be empty${where}; use write_file to create files`);
  let [from, to] = [edit.oldString, edit.newString];
  // A CRLF file: match the model's \n text as \r\n, and keep the file's line endings in the replacement.
  if (usesCrlf(text) && countOccurrences(text, from) === 0) [from, to] = [toCrlf(from), toCrlf(to)];
  const count = countOccurrences(text, from);
  if (count === 0) throw new ToolError(`old_string not found${where}. Re-read the file and copy the text exactly.`);
  if (count > 1) throw new ToolError(`old_string matches ${count} places${where}. Include more context to make it unique.`);
  return text.replace(from, () => to);
}

export const editFileTool: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace exact text in a file. old_string must match the file exactly (including indentation) and appear exactly once; " +
      "include surrounding lines to make it unique. For several changes to the same file, pass `edits` instead: " +
      "they are applied in order, each to the result of the previous one, and if any fails the file is left unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        edits: {
          type: "array",
          description: "Several replacements in one call, instead of old_string/new_string",
          items: {
            type: "object",
            properties: { old_string: { type: "string" }, new_string: { type: "string" } },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path"],
    },
  },
  dangerous: true,
  async run(input, ctx) {
    const path = requireString(input, "path");
    const edits = readEdits(input);
    const abs = resolveInWorkspace(ctx.workspace, path);
    let text = await readFile(abs, "utf8");
    edits.forEach((edit, i) => {
      text = applyEdit(text, edit, edits.length > 1 ? ` (edits[${i}], no changes were written) in ${path}` : ` in ${path}`);
    });
    await writeFile(abs, text, "utf8");
    return edits.length > 1 ? `Edited ${path} (${edits.length} changes)` : `Edited ${path}`;
  },
};
