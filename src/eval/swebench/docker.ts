import { spawn } from "node:child_process";
import { formatShellResult, runShell, TIMEOUT_MS } from "../../tools/bash.ts";
import { requireString, type Tool } from "../../tools/types.ts";

// SWE-bench images are x86_64 only; on Apple Silicon they run under emulation.
export const PLATFORM = "linux/amd64";
const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export interface CommandResult {
  code: number | null; // null: killed on timeout
  stdout: string;
  output: string; // stdout and stderr interleaved, for logs and error messages
}

// Runs a host program without a shell; never throws for a non-zero exit.
export function run(file: string, args: readonly string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    const stdout: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => {
      chunks.push(d);
      stdout.push(d);
    });
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "", output: `failed to start ${file}: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString(), output: Buffer.concat(chunks).toString() });
    });
  });
}

export function docker(args: readonly string[], timeoutMs?: number): Promise<CommandResult> {
  return run("docker", args, timeoutMs);
}

// Like docker(), but a failure is an error: for steps the attempt can't go on without. Returns stdout.
export async function dockerOk(args: readonly string[], timeoutMs?: number): Promise<string> {
  const r = await docker(args, timeoutMs);
  if (r.code !== 0) throw new Error(`docker ${args.slice(0, 2).join(" ")} failed (${r.code ?? "timeout"}): ${r.output.trim().slice(-2000)}`);
  return r.stdout;
}

// Pulls on first use; later attempts reuse the local image.
export async function ensureImage(image: string): Promise<void> {
  if ((await docker(["image", "inspect", image], 60_000)).code === 0) return;
  await dockerOk(["pull", "--platform", PLATFORM, image]);
}

export async function removeContainer(name: string): Promise<void> {
  await docker(["rm", "-f", name], 120_000);
}

// Copies the image's checkout (/testbed) to a host directory, where the agent's file tools work on it.
export async function copyTestbed(image: string, name: string, dest: string): Promise<void> {
  await dockerOk(["create", "--platform", PLATFORM, "--name", name, image]);
  try {
    await dockerOk(["cp", `${name}:/testbed/.`, dest]);
  } finally {
    await removeContainer(name);
  }
}

// A long-running container with the host checkout mounted at the same absolute path, so paths in the agent's
// bash and in its file tools agree. /testbed becomes a link to it: the project is installed in editable mode
// from /testbed, so imports keep resolving to the files the agent edits.
// Returns the commit the checkout is at, the base of the agent's patch.
export async function startAgentContainer(image: string, name: string, workspace: string): Promise<string> {
  await dockerOk(["run", "-d", "--platform", PLATFORM, "--name", name, "-v", `${workspace}:${workspace}`, "-w", workspace, image, "sleep", "infinity"]);
  const setup = `rm -rf /testbed && ln -s "$1" /testbed && git config --global --add safe.directory '*'`;
  await dockerOk(["exec", name, "bash", "-c", setup, "setup", workspace], 300_000);
  // The copy on the host must match the image: a case-insensitive host file system, for one, can merge files.
  const dirty = await dockerOk(["exec", "-w", workspace, name, "git", "status", "--porcelain"], 300_000);
  if (dirty.trim()) throw new Error(`checkout differs from the image before the agent started:\n${dirty.trim().slice(0, 2000)}`);
  return (await dockerOk(["exec", "-w", workspace, name, "git", "rev-parse", "HEAD"])).trim();
}

// The agent's change since `base` ($1), new files included (git add -A respects .gitignore). Run in the agent's
// container, never on the host: the agent controls .git/config, and git on the host would run hooks, filters or
// an fsmonitor it put there. The flags keep that config (external diff, textconv, colour, prefixes, renames)
// from changing the patch, and --binary keeps binary files appliable.
export const PATCH_SCRIPT =
  "git -c core.fileMode=false -c core.fsmonitor=false add -A && " +
  "git -c core.fileMode=false -c core.fsmonitor=false diff --cached --binary --no-color --no-ext-diff --no-textconv " +
  '--no-renames --src-prefix=a/ --dst-prefix=b/ "$1" --';

export async function collectPatch(container: string, workspace: string, base: string): Promise<string> {
  return dockerOk(["exec", "-w", workspace, container, "bash", "-c", PATCH_SCRIPT, "patch", base], 300_000);
}

// docker exec reads the command from the environment (-e RCA_CMD), so it needs no quoting.
// `timeout` runs inside the container: killing the docker client would leave the command running there.
const EXEC =
  `docker exec -w "$RCA_CWD" -e RCA_CMD "$RCA_CONTAINER" timeout -k 5 ${TIMEOUT_MS / 1000} ` +
  `bash -c 'source /opt/miniconda3/bin/activate && conda activate testbed && eval "$RCA_CMD"'`;
// What `timeout` exits with: 124 after SIGTERM, 137 after the SIGKILL that follows -k.
const TIMEOUT_EXITS = [124, 137];

// The bash tool for SWE-bench: same name and result format as the normal one, but runs in the instance's container.
export function containerBashTool(container: string): Tool {
  return {
    spec: {
      name: "bash",
      description:
        "Run a shell command (bash, in the project's Linux container with its Python environment activated) in the workspace root " +
        `and return combined stdout/stderr plus the exit code. Commands time out after ${TIMEOUT_MS / 1000}s. No interactive input is available.`,
      inputSchema: {
        type: "object",
        properties: { command: { type: "string", description: "The shell command to run" } },
        required: ["command"],
      },
    },
    dangerous: true,
    async run(input, ctx) {
      const env = { ...process.env, RCA_CMD: requireString(input, "command"), RCA_CWD: ctx.workspace, RCA_CONTAINER: container };
      const started = Date.now();
      const r = await runShell(EXEC, { cwd: ctx.workspace, timeoutMs: TIMEOUT_MS + 15_000, signal: ctx.signal, env });
      // The command's own exit code can be 124 too (e.g. the agent ran `timeout 30 pytest`); only a full run is ours.
      const ours = r.exitCode !== null && TIMEOUT_EXITS.includes(r.exitCode) && Date.now() - started >= TIMEOUT_MS;
      return formatShellResult(ours ? { ...r, timedOut: true } : r);
    },
  };
}
