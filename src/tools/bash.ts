import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { requireString, type Tool } from "./types.ts";

const TIMEOUT_MS = 120_000;
// How long output may keep arriving after the shell itself has exited.
const EXIT_GRACE_MS = 500;
const IS_WINDOWS = process.platform === "win32";

// Windows programs write pipes in the console's OEM code page (GBK on Chinese systems), not UTF-8.
// Python is told to use UTF-8 (otherwise printing an emoji even crashes it); other programs are decoded per line:
// UTF-8 when the line is valid UTF-8, else the OEM code page. Splitting on \n is safe: no GBK/Big5/Shift_JIS byte pair contains 0x0A.
const WINDOWS_ENV = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
const OEM_ENCODINGS: Record<string, string> = { "936": "gbk", "950": "big5", "932": "shift_jis", "949": "euc-kr", "866": "ibm866" };
const utf8 = new TextDecoder("utf-8", { fatal: true });
let oemDecoder: TextDecoder | undefined;

function getOemDecoder(): TextDecoder {
  if (!oemDecoder) {
    let codePage = "";
    try {
      const out = execFileSync("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage", "/v", "OEMCP"], { encoding: "latin1", windowsHide: true });
      codePage = /OEMCP\s+REG_SZ\s+(\d+)/.exec(out)?.[1] ?? "";
    } catch {
      // fall back below
    }
    oemDecoder = new TextDecoder(OEM_ENCODINGS[codePage] ?? "windows-1252");
  }
  return oemDecoder;
}

export function decodeOutput(buf: Buffer, decodeLegacy: () => TextDecoder = getOemDecoder): string {
  const lines: string[] = [];
  let start = 0;
  while (start <= buf.length) {
    const end = buf.indexOf(0x0a, start);
    const line = buf.subarray(start, end === -1 ? buf.length : end);
    try {
      lines.push(utf8.decode(line));
    } catch {
      lines.push(decodeLegacy().decode(line));
    }
    if (end === -1) break;
    start = end + 1;
  }
  return lines.join("\n");
}

function taskkill(pid: number): void {
  spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
}


// Sets PATH with the given dirs in front. Windows env keys are case-insensitive and the inherited key may be
// `Path`; leaving it next to a new `PATH` would make it unclear which one the child sees.
function withPath(base: NodeJS.ProcessEnv, front: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  let path = "";
  for (const [key, value] of Object.entries(base)) {
    if (key.toUpperCase() === "PATH") path = value ?? "";
    else env[key] = value;
  }
  env.PATH = [...front, path].filter(Boolean).join(delimiter);
  return env;
}

// On Windows, `python3` on PATH is often the Microsoft Store placeholder ("Permission denied" from bash) even when
// a real Python is installed as `python`. Models (and eval checks) reach for python3, so point it at the real one.
function python3Shim(): string | undefined {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const isStore = (p: string) => /\\WindowsApps\\/i.test(p);
  const py3 = dirs.map((d) => join(d, "python3.exe")).find(existsSync);
  if (py3 && !isStore(py3)) return undefined;
  const py = dirs.map((d) => join(d, "python.exe")).find((p) => !isStore(p) && existsSync(p));
  if (!py) return undefined;
  const dir = join(tmpdir(), "raw-coding-agent-shims");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "python3"), `#!/bin/sh\nexec "${py.replaceAll("\\", "/")}" "$@"\n`);
  return dir;
}

interface Shell {
  label: string;
  file: string;
  args(command: string): string[];
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  // Kills the shell and everything it started, so a leftover grandchild can't keep the output pipe open.
  kill(pid: number): void;
}

// On Windows, `bash` on PATH may be WSL's launcher (a different filesystem and toolchain) or missing,
// so look for Git for Windows next to git.exe or in the usual install dirs.
function findGitRoot(): string | undefined {
  const roots = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir || !existsSync(join(dir, "git.exe"))) continue;
    // git.exe lives in <root>\cmd, <root>\bin or <root>\mingw64\bin
    roots.add(dirname(dir));
    roots.add(dirname(dirname(dir)));
  }
  for (const base of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Programs")]) {
    if (base) roots.add(join(base, "Git"));
  }
  return [...roots].find((root) => existsSync(join(root, "usr", "bin", "bash.exe")));
}

function resolveShell(): Shell {
  if (!IS_WINDOWS) {
    return {
      label: "bash",
      file: "bash",
      args: (c) => ["-c", c],
      env: (base) => base,
      // The shell runs in its own process group (detached), so killing the group also kills grandchildren
      // (e.g. `sleep` in `sleep 30 && echo`).
      kill: (pid) => process.kill(-pid, "SIGKILL"),
    };
  }
  const root = findGitRoot();
  if (root) {
    const bash = join(root, "usr", "bin", "bash.exe");
    const front = [python3Shim(), join(root, "mingw64", "bin"), join(root, "usr", "bin")].filter((d) => d !== undefined);
    return {
      label: "Git Bash on Windows",
      // The real MSYS bash rather than the <root>\bin\bash.exe launcher, so child.pid is the shell itself;
      // the launcher's only other job is setting up PATH, done here instead.
      file: bash,
      args: (c) => ["-c", c],
      env: (base) => ({ ...withPath(base, front), ...WINDOWS_ENV, MSYSTEM: "MINGW64" }),
      // MSYS emulates fork, so children aren't in the Windows process tree and taskkill /T misses them.
      // MSYS does track them: the shell leads its own process group, which its `kill` can end.
      kill: (pid) => {
        const script = `kill -9 -- -$(ps | awk '$4 == ${pid} { print $3 }')`;
        spawn(bash, ["-c", script], { stdio: "ignore", windowsHide: true })
          .on("error", () => taskkill(pid))
          .on("close", () => taskkill(pid));
      },
    };
  }
  return {
    label: "Windows PowerShell; bash is not available, so use PowerShell syntax",
    file: "powershell.exe",
    args: (c) => ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${c}`],
    env: (base) => ({ ...base, ...WINDOWS_ENV }),
    kill: taskkill,
  };
}

const shell = resolveShell();

export interface ShellOptions {
  cwd: string;
  timeoutMs: number;
  // Base environment; the shell adds its own PATH and encoding settings on top.
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface ShellResult {
  output: string;
  // null when the shell was killed or failed to start
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  // The shell exited but something it started still holds the output pipe.
  leftRunning: boolean;
  startError?: string;
}

// Runs a command in the agent's shell (the bash tool, eval checks): same shell, kill and decoding on every platform.
export function runShell(command: string, options: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    // detached gives the shell its own process group on Unix; on Windows it would only open a console window.
    const child = spawn(shell.file, shell.args(command), {
      cwd: options.cwd,
      env: shell.env(options.env ?? process.env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: !IS_WINDOWS,
      windowsHide: true,
    });
    const killGroup = () => {
      try {
        if (child.pid) shell.kill(child.pid);
      } catch {
        // already exited
      }
    };
    // Raw bytes, decoded once at the end: a chunk can end in the middle of a multi-byte character.
    const chunks: Buffer[] = [];
    let timedOut = false;
    let stopped = false;
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, options.timeoutMs);
    const onAbort = () => {
      stopped = true;
      killGroup();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let settled = false;
    const settle = (exitCode: number | null, extra: Partial<ShellResult> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      const output = Buffer.concat(chunks);
      resolve({ output: IS_WINDOWS ? decodeOutput(output) : output.toString(), exitCode, timedOut, stopped, leftRunning: false, ...extra });
    };
    child.on("error", (err) => settle(null, { startError: `failed to start ${shell.file}: ${err.message}` }));
    // Normally the pipes close right after the shell exits. A background job can keep them open, even with its output
    // redirected: in `cd app && server > log &` the whole list runs in a subshell that holds the pipe, and only
    // `server` is redirected. Waiting would hang the turn for as long as it runs, so once the shell is gone,
    // return and leave it running.
    child.on("exit", (code) => {
      setTimeout(() => {
        if (settled) return;
        settle(code, { leftRunning: true });
        child.stdout.destroy();
        child.stderr.destroy();
      }, EXIT_GRACE_MS);
    });
    child.on("close", (code) => settle(code));
  });
}

export const bashTool: Tool = {
  spec: {
    name: "bash",
    description:
      `Run a shell command (${shell.label}) in the workspace root and return combined stdout/stderr plus the exit code. ` +
      `Commands time out after ${TIMEOUT_MS / 1000}s. No interactive input is available.`,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run" } },
      required: ["command"],
    },
  },
  dangerous: true,
  async run(input, ctx) {
    const r = await runShell(requireString(input, "command"), { cwd: ctx.workspace, timeoutMs: TIMEOUT_MS, signal: ctx.signal });
    if (r.startError) return r.startError;
    const notes = [
      r.timedOut && `[killed after ${TIMEOUT_MS / 1000}s timeout]`,
      r.stopped && "[killed: stopped by the user]",
      r.leftRunning && "[a background process is still running; its further output is not captured]",
      `[exit code: ${r.exitCode ?? "killed"}]`,
    ].filter(Boolean);
    // No blank line between the output and the notes: one looks like part of the output, and the model
    // copied such a phantom trailing blank line from `sed -n` output into an edit_file old_string.
    const output = r.output && !r.output.endsWith("\n") ? `${r.output}\n` : r.output;
    return output + notes.join("\n");
  },
};
