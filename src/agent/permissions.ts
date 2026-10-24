import type { Tool } from "../tools/index.ts";
import type { ToolCall } from "../types.ts";

// D6: which calls need human approval.
export type Confirm = (call: ToolCall) => Promise<boolean>;

// "ask": dangerous tools wait for a human; "auto": everything runs without asking.
// In "ask", commands that only read are allowed without a prompt: they are the majority of the agent's bash
// calls (ls/cat/grep/git status) and approving each one trains people to click "allow" without reading.
export type ApprovalMode = "ask" | "auto";
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto"];

// How a tool call got permission to run; recorded on its trace span.
export type ApprovalOutcome = "not_required" | "auto" | "allowed" | "denied";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

// Commands that only inspect the filesystem. Deliberately conservative: anything that can write, delete,
// install, run arbitrary code, reach the network, or hide another command (substitution, redirection, xargs)
// still asks. This is a convenience filter, not a security boundary; "auto" mode still runs everything.
const READ_ONLY_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "pwd", "echo", "printf",
  "file", "stat", "du", "df", "tree", "diff", "cmp", "comm", "cut", "tr", "sort", "uniq",
  "nl", "od", "hexdump", "strings", "jq", "yq", "basename", "dirname",
  "realpath", "readlink", "date", "uname", "whoami", "id", "sleep", "true", "false", "test", "[",
]);

const READ_ONLY_GIT = new Set([
  "status", "diff", "log", "show", "rev-parse", "describe", "ls-files", "grep", "blame",
  "cat-file", "show-ref", "for-each-ref", "merge-base", "check-ignore", "name-rev", "rev-list",
]);

const WRITE_FLAGS = /^--(?:output|in-place|delete|exec|execdir|ok|okdir|fprint|fprint0|fls)\b/;

function isReadOnlySort(args: string[]): boolean {
  return !args.some((arg) =>
    arg === "-o" || arg === "--output" || arg.startsWith("--output=") ||
    arg === "-T" || arg === "--temporary-directory" || arg.startsWith("--compress-program"));
}

// Commands with a write/execute option hidden in an otherwise read-only tool.
function hasWriteOption(name: string, args: string[]): boolean {
  if (name === "date") return args.some((arg) => arg === "-s" || arg.startsWith("--set"));
  if (name === "file") return args.some((arg) => arg === "-C" || arg === "--compile");
  if (name === "yq") return args.some((arg) => arg === "-i" || arg === "--inplace" || arg.startsWith("--inplace="));
  if (name === "rg") return args.some((arg) => arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob");
  return false;
}

function isReadOnlyGit(args: string[]): boolean {
  // -c/--exec-path/--config-env can inject config (pager, hooks, external diff) and run code.
  if (args.some((arg) => arg === "-c" || arg.startsWith("--config-env") || arg === "--exec-path" || arg.startsWith("--exec-path="))) return false;
  const sub = args[0];
  if (!sub) return false;
  if (sub === "config") {
    const rest = args.slice(1);
    if (rest.length === 0) return false;
    return rest.every((arg) => /^--(get|get-all|get-regexp|list)|^-l$/.test(arg));
  }
  if (sub === "branch") {
    const rest = args.slice(1);
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (/^(-a|-r|-v|-vv|--list|--show-current)$/.test(arg) || /^--format=/.test(arg)) continue;
      if (/^(--contains|--merged|--no-merged|--points-at)$/.test(arg) && i + 1 < rest.length) { i++; continue; }
      return false;
    }
    return true;
  }
  if (sub === "remote") {
    const rest = args.slice(1);
    return rest.length === 0 || rest.every((arg) => /^(-v|--verbose|show|get-url)$/.test(arg));
  }
  if (sub === "worktree") return args[1] === "list";
  if (!READ_ONLY_GIT.has(sub)) return false;
  // diff/log/show can write the patch to a file, run an external diff/textconv, or open a pager.
  return !args.some((arg) =>
    arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff" || arg === "--textconv" ||
    arg === "-O" || arg.startsWith("--open-files-in-pager"));
}

function isReadOnlyFind(args: string[]): boolean {
  return !args.some((arg) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(arg));
}

function isReadOnlySegment(raw: string): boolean {
  // Redirection writes, backgrounds interleave with the turn, and substitutions hide commands.
  if (/[<>]|[`]|\$\(|\$\{/.test(raw)) return false;
  if (/(?<!&)&(?!&)/.test(raw)) return false;
  let rest = raw.trim();
  // Leading VAR=value assignments are fine; they only affect this command's environment.
  while (/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/.test(rest)) rest = rest.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/, "");
  if (!rest) return false;
  const words = rest.split(/\s+/);
  const name = words[0]!;
  const args = words.slice(1);
  if (name === "cd") return args.length <= 1;
  if (name === "git") return isReadOnlyGit(args);
  if (name === "find") return isReadOnlyFind(args);
  if (name === "sort") return isReadOnlySort(args);
  if (name === "xargs" || name === "env" || name === "bash" || name === "sh" || name === "zsh" || name === "node" || name === "python" || name === "python3") return false;
  if (READ_ONLY_COMMANDS.has(name)) return !hasWriteOption(name, args) && !args.some((arg) => WRITE_FLAGS.test(arg));
  return false;
}

// Split on command separators, then require every segment to be read-only.
export function isReadOnlyBashCommand(command: string): boolean {
  const text = command.trim();
  if (!text || text.includes("\n")) return false;
  const segments = text.split(/&&|\|\||;|\|/);
  if (segments.some((segment) => segment.trim() === "")) return false;
  return segments.every((segment) => isReadOnlySegment(segment));
}

export function needsApproval(tool: Tool, mode: ApprovalMode, call?: ToolCall): boolean {
  if (!tool.dangerous || mode === "auto") return false;
  if (call?.name === "bash") {
    const command = call.input.command;
    if (typeof command === "string" && isReadOnlyBashCommand(command)) return false;
  }
  return true;
}
