import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { findFiles, limitLines, optionalString, toPosix } from "./search.ts";
import { requireString, ToolError, type Tool } from "./types.ts";
import { resolveInWorkspace } from "./workspace.ts";

// Big files are almost always generated or data; long lines are usually minified code.
const MAX_FILE_BYTES = 1_000_000;
const MAX_LINE_CHARS = 300;
const MAX_CONTEXT = 5;

function optionalContext(input: Record<string, unknown>): number {
  const raw = input.context;
  if (raw === undefined) return 0;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) throw new ToolError('"context" must be an integer >= 0');
  return Math.min(raw, MAX_CONTEXT);
}

function shown(line: string): string {
  return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

export const grepTool: Tool = {
  spec: {
    name: "grep",
    description:
      "Search file contents with a JavaScript regular expression. By default returns matching lines as `path:line: text`; " +
      "set context to include surrounding lines (context lines use `path-line- text`), or files_only to list just the " +
      "files that match. .git, node_modules, __pycache__ and virtualenv directories, binary files and files over 1 MB are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression (JavaScript syntax)" },
        path: { type: "string", description: "File or directory to search, relative to the workspace root (default: the root)" },
        glob: { type: "string", description: 'Only search files matching this glob, e.g. "*.py" (any directory) or "src/**/*.ts"' },
        ignore_case: { type: "boolean", description: "Case-insensitive match (default false)" },
        context: { type: "integer", description: `Lines of context before and after each match (0-${MAX_CONTEXT}, default 0)` },
        files_only: { type: "boolean", description: "Return only the paths of files containing a match (default false)" },
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
    const context = optionalContext(input);
    const filesOnly = input.files_only === true;
    const target = resolveInWorkspace(ctx.workspace, optionalString(input, "path") ?? ".");
    const fileGlob = optionalString(input, "glob") ?? "**/*";
    // Like rg --glob: a pattern without a slash matches the file name in any directory.
    const files = (await stat(target)).isFile()
      ? [toPosix(relative(ctx.workspace, target))]
      : await findFiles(ctx.workspace, target, fileGlob.includes("/") ? fileGlob : `**/${fileGlob}`, ctx.signal);

    const output: string[] = [];
    const matchingFiles: string[] = [];
    for (const file of files) {
      if (ctx.signal?.aborted) throw new ToolError("stopped by the user");
      const abs = resolveInWorkspace(ctx.workspace, file);
      if ((await stat(abs)).size > MAX_FILE_BYTES) continue;
      const text = await readFile(abs, "utf8");
      if (text.includes("\0")) continue;
      const lines = text.split(/\r?\n/);
      const hits: number[] = [];
      lines.forEach((line, i) => { if (regex.test(line)) hits.push(i); });
      if (hits.length === 0) continue;
      if (filesOnly) {
        matchingFiles.push(file);
        continue;
      }
      if (context === 0) {
        for (const i of hits) output.push(`${file}:${i + 1}: ${shown(lines[i]!)}`);
        continue;
      }
      // Merge overlapping context windows, and print one separator between groups like ripgrep does.
      const hitSet = new Set(hits);
      const wanted = new Set<number>();
      for (const i of hits) {
        for (let n = Math.max(0, i - context); n <= Math.min(lines.length - 1, i + context); n++) wanted.add(n);
      }
      let previous = -2;
      for (const i of [...wanted].sort((a, b) => a - b)) {
        if (output.length > 0 && i > previous + 1) output.push("--");
        const marker = hitSet.has(i) ? ":" : "-";
        output.push(`${file}${marker}${i + 1}${marker} ${shown(lines[i]!)}`);
        previous = i;
      }
    }
    return filesOnly ? limitLines(matchingFiles, "files") : limitLines(output, "matches");
  },
};
