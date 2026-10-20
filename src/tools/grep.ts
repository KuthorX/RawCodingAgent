import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { findFiles, limitLines, optionalString, toPosix } from "./search.ts";
import { requireString, ToolError, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

// Big files are almost always generated or data; long lines are usually minified code.
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 300;

export const grepTool: Tool = {
  spec: {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. Returns matching lines as `path:line: text`. " +
      ".git, node_modules, __pycache__ and virtualenv directories, binary files and files over 1 MB are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (JavaScript syntax)" },
        path: { type: "string", description: "File or directory to search, relative to the workspace root (default: the root)" },
        glob: { type: "string", description: 'Only search files matching this glob, e.g. "*.py" (any directory) or "src/**/*.ts"' },
        ignore_case: { type: "boolean", description: "Case-insensitive match (default false)" },
      },
      required: ["pattern"],
    },
  },
  dangerous: false,
  async run(input, ctx) {
    const pattern = requireString(input, "pattern");
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, input.ignore_case === true ? "i" : "");
    } catch (err) {
      throw new ToolError(`invalid regular expression: ${(err as Error).message}`);
    }
    const target = resolveInWorkspace(ctx.workspace, optionalString(input, "path") ?? ".");
    const fileGlob = optionalString(input, "glob") ?? "**/*";
    // Like rg --glob: a pattern without a slash matches the file name in any directory.
    const files = (await stat(target)).isFile()
      ? [toPosix(relative(ctx.workspace, target))]
      : await findFiles(ctx.workspace, target, fileGlob.includes("/") ? fileGlob : `**/${fileGlob}`, ctx.signal);

    const matches: string[] = [];
    for (const file of files) {
      if (ctx.signal?.aborted) throw new ToolError("stopped by the user");
      const abs = resolveInWorkspace(ctx.workspace, file);
      if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
      const text = await readFile(abs, "utf8");
      if (text.includes("\0")) continue;
      text.split(/\r?\n/).forEach((line, i) => {
        if (!regex.test(line)) return;
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
        matches.push(`${file}:${i + 1}: ${shown}`);
      });
    }
    return limitLines(matches, "matches");
  },
};
