import type { LocatedSpan } from "./analyze.ts";

// D4: how much file work goes through bash instead of the dedicated tools. A heuristic over the command text,
// meant for comparing runs (same classifier on both sides), not for judging a single call.
export type BashKind =
  | "read" // cat / head / tail / sed -n …
  | "search" // grep / find / ls …
  | "edit" // sed -i, a heredoc or script that writes a file, `> file` …
  | "outside" // file work on paths outside the workspace, where the dedicated tools refuse to go
  | "other"; // running programs, tests, git, installs …

const READ = new Set(["cat", "head", "tail", "nl", "less", "more", "type", "get-content", "wc", "file", "stat"]);
const SEARCH = new Set(["grep", "egrep", "rg", "ag", "find", "fd", "ls", "tree", "dir", "select-string", "get-childitem", "du"]);
// Harmless glue between file commands: `cd x && cat a; echo ===; cat b | head`.
const GLUE = new Set(["cd", "echo", "printf", "true", ":", "sort", "uniq", "cut", "tr", "awk", "xargs", "column"]);
const SCRIPT = new Set(["python", "python3", "py", "node", "perl", "ruby"]);
// A script that writes files rather than just printing.
const WRITES = /\.write(_text|_bytes|FileSync|File)?\s*\(|open\([^)]*,\s*["'][wa]b?\+?["']|writeFileSync|\bfs\.write|Set-Content|Out-File/;

// Splits on unquoted ; & | and newlines. Heredoc bodies are cut off first and returned separately.
function split(command: string): { segments: string[]; heredoc: string } {
  let head = command, heredoc = "";
  const marker = /<<-?\s*["']?(\w+)["']?/.exec(command);
  if (marker) {
    const nl = command.indexOf("\n", marker.index);
    if (nl !== -1) [head, heredoc] = [command.slice(0, nl), command.slice(nl + 1)];
  }
  const segments: string[] = [];
  let cur = "", quote: string | null = null;
  for (let i = 0; i < head.length; i++) {
    const c = head[i];
    if (quote) {
      if (c === "\\" && quote === '"') { cur += c + (head[++i] ?? ""); continue; }
      if (c === quote) quote = null;
      cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if (c === "\\") {
      cur += c + (head[++i] ?? "");
    } else if (c === ";" || c === "&" || c === "|" || c === "\n") {
      if (c === "&" && head[i - 1] === ">") { cur += c; continue; } // 2>&1
      segments.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  segments.push(cur);
  return { segments: segments.map((s) => s.trim()).filter(Boolean), heredoc };
}

function program(segment: string): string {
  // Skip leading VAR=value assignments; keep only the file name of a path like .venv/Scripts/python.
  const word = segment.split(/\s+/).find((w) => !/^\w+=/.test(w)) ?? "";
  return word.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.replace(/\.exe$/i, "").toLowerCase();
}

// Output redirected into a file (not /dev/null, not 2>&1).
const redirectsToFile = (segment: string): boolean => /(^|[^0-9&])>>?\s*(?!&|\/dev\/null)["']?[\w./~-]/.test(segment.replace(/'[^']*'|"[^"]*"/g, ""));

// Absolute paths a command touches: /tmp/x, /c/Users/..., C:\..., ~/...
const ABSOLUTE = /(?:^|[\s"'=(])((?:\/(?:tmp|[a-z]|mnt|home|Users|usr|etc|opt|var)\/|[A-Za-z]:[\\/]|~\/)[^\s"';|&)]*)/g;

function workspaceForms(workspace: string): string[] {
  const ws = workspace.replace(/\\/g, "/").replace(/\/$/, "").toLowerCase();
  const drive = /^([a-z]):/;
  return [ws, ws.replace(drive, (_, d) => `/${d}`), ws.replace(drive, (_, d) => `/mnt/${d}`)];
}

function touchesOutside(command: string, workspace: string | undefined): boolean {
  if (!workspace) return false;
  const forms = workspaceForms(workspace);
  for (const m of command.matchAll(ABSOLUTE)) {
    const path = m[1].replace(/\\/g, "/").toLowerCase();
    if (path.startsWith("/dev/")) continue;
    if (!forms.some((f) => path === f || path.startsWith(f + "/"))) return true;
  }
  return false;
}

export function classifyBash(command: string, workspace?: string): BashKind {
  const { segments, heredoc } = split(command);
  let kind: "read" | "search" | "edit" | null = null;
  const rank = { search: 1, read: 2, edit: 3 } as const;
  const note = (k: "read" | "search" | "edit") => { if (kind === null || rank[k] > rank[kind]) kind = k; };
  for (const segment of segments) {
    const prog = program(segment);
    if (redirectsToFile(segment) && prog !== "cd") note("edit");
    if (prog === "sed") note(/\s-[a-z]*i/.test(segment) ? "edit" : "read");
    else if (prog === "tee") note("edit");
    else if (READ.has(prog)) note("read");
    else if (SEARCH.has(prog)) note("search");
    else if (SCRIPT.has(prog)) {
      // A script is file work only when it writes files; otherwise it's running a program.
      if (WRITES.test(heredoc || segment)) note("edit");
      else return "other";
    } else if (!GLUE.has(prog)) return "other";
  }
  if (kind === null) return "other";
  return touchesOutside(command, workspace) ? "outside" : kind;
}

export interface ToolMix {
  fileTools: number; // read_file / write_file / edit_file / glob / grep calls
  bash: Record<BashKind, number>;
}

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "glob", "grep"]);

export function toolMix(spans: readonly LocatedSpan[], workspace?: string): ToolMix {
  const mix: ToolMix = { fileTools: 0, bash: { read: 0, search: 0, edit: 0, outside: 0, other: 0 } };
  for (const s of spans) {
    if (s.kind !== "tool") continue;
    if (FILE_TOOLS.has(s.name)) mix.fileTools++;
    const command = (s.attrs.input as { command?: unknown } | undefined)?.command;
    if (s.name === "bash" && typeof command === "string") mix.bash[classifyBash(command, workspace)]++;
  }
  return mix;
}

// File work inside the workspace done through bash, out of all such file work. "outside" is left out:
// the dedicated tools can't reach those paths, so bash is the only option there.
export function bashFileOps(mix: ToolMix): number {
  return mix.bash.read + mix.bash.search + mix.bash.edit;
}

export function bashFileShare(mix: ToolMix): number | null {
  const viaBash = bashFileOps(mix);
  const total = viaBash + mix.fileTools;
  return total === 0 ? null : viaBash / total;
}
