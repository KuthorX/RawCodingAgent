import { spawn } from "node:child_process";
import { requireString, type Tool } from "./types.ts";

const TIMEOUT_MS = 120_000;

export const bashTool: Tool = {
  spec: {
    name: "bash",
    description:
      "Run a shell command in the workspace root and return combined stdout/stderr plus the exit code. " +
      `Commands time out after ${TIMEOUT_MS / 1000}s. No interactive input is available.`,
    inputSchema: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run" } },
      required: ["command"],
    },
  },
  dangerous: true,
  run(input, ctx) {
    const command = requireString(input, "command");
    return new Promise((resolve) => {
      // Own process group, so killing it also kills grandchildren (e.g. `sleep` in `sleep 30 && echo`),
      // which would otherwise keep the output pipe open and block until they finish.
      const child = spawn("bash", ["-c", command], { cwd: ctx.workspace, stdio: ["ignore", "pipe", "pipe"], detached: true });
      const killGroup = () => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          // already exited
        }
      };
      let output = "";
      child.stdout.on("data", (d: Buffer) => (output += d.toString()));
      child.stderr.on("data", (d: Buffer) => (output += d.toString()));
      const timer = setTimeout(() => {
        killGroup();
        output += `\n[killed after ${TIMEOUT_MS / 1000}s timeout]`;
      }, TIMEOUT_MS);
      const onAbort = () => {
        killGroup();
        output += "\n[killed: stopped by the user]";
      };
      ctx.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(`failed to start: ${err.message}`);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        ctx.signal?.removeEventListener("abort", onAbort);
        resolve(`${output}\n[exit code: ${code ?? "killed"}]`);
      });
    });
  },
};
