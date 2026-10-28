import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findFiles } from "../tools/search.ts";
import { runShell, formatShellResult, TIMEOUT_MS } from "../tools/bash.ts";
import { isReadOnlyBashCommand } from "./permissions.ts";
import { ToolError, type Tool } from "../tools/types.ts";
import type { ToolCall } from "../types.ts";
import { resolveInWorkspace } from "../tools/workspace.ts";

const exec = promisify(execFile);
const INTERNAL = new Set([".sessions", ".eval-runs", ".codegraph", "__pycache__", ".pytest_cache", ".venv", "node_modules", ".git"]);

interface VerificationPolicy { commands: string[]; npmScripts?: string }
export interface VerificationState { changed: boolean; checked?: string; policy?: VerificationPolicy }

function scriptsSignature(scripts: unknown): string {
  return JSON.stringify(Object.entries(scripts && typeof scripts === "object" ? scripts : {}).sort(([a], [b]) => a.localeCompare(b)));
}

async function fingerprint(workspace: string, env?: NodeJS.ProcessEnv): Promise<string> {
  let files: string[];
  try {
    const result = await exec("git", ["-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."], { cwd: workspace, env, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
    files = [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
  } catch {
    files = await findFiles(workspace, workspace, "**/*");
  }
  const hash = createHash("sha256");
  for (const file of files) {
    if (file.split(/[\\/]/).some((part) => INTERNAL.has(part))) continue;
    const path = join(workspace, file);
    try {
      const stat = await lstat(path);
      hash.update(JSON.stringify([file, stat.mode]));
      if (stat.isSymbolicLink()) hash.update(await readlink(path));
      else if (stat.isFile()) for await (const chunk of createReadStream(resolveInWorkspace(workspace, file))) hash.update(chunk);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      hash.update(JSON.stringify([file, "deleted"]));
    }
  }
  return hash.digest("hex");
}

// Capture checks before the agent edits anything. The model cannot declare a successful check in prose.
async function commandsFor(workspace: string): Promise<VerificationPolicy> {
  try {
    const raw: unknown = JSON.parse(await readFile(resolveInWorkspace(workspace, ".agent-checks.json"), "utf8"));
    const commands = (raw as { commands?: unknown } | null)?.commands;
    if (!Array.isArray(commands) || commands.length === 0 || commands.length > 10 || commands.some((command) => typeof command !== "string" || !command.trim())) {
      throw new Error(".agent-checks.json must contain 1-10 nonempty commands");
    }
    const policy: VerificationPolicy = { commands };
    if (commands.some((command) => /\bnpm(?:\.cmd)?\s+(?:test|run)\b/.test(command))) {
      try {
        const manifest = JSON.parse(await readFile(resolveInWorkspace(workspace, "package.json"), "utf8"));
        policy.npmScripts = scriptsSignature(manifest.scripts);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return policy;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    const manifest = JSON.parse(await readFile(resolveInWorkspace(workspace, "package.json"), "utf8"));
    return {
      commands: ["test", "typecheck"].filter((name) => typeof manifest.scripts?.[name] === "string").map((name) => name === "test" ? "npm test" : `npm run ${name}`),
      npmScripts: scriptsSignature(manifest.scripts),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
    return { commands: [] };
  }
}

export class Verification {
  private changed = false;
  private beforeBash: string | undefined;
  private previousState: VerificationState | undefined;
  private checked: string | undefined;
  private readonly commands: string[];
  private readonly workspace: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly save: (state: VerificationState) => void;
  private readonly policy: VerificationPolicy;
  private progress = 0;

  get progressVersion(): number { return this.progress; }

  private constructor(workspace: string, policy: VerificationPolicy, env: NodeJS.ProcessEnv | undefined, state: VerificationState, save: (state: VerificationState) => void) {
    this.workspace = workspace;
    this.commands = policy.commands;
    this.policy = policy;
    this.env = env;
    this.changed = state.changed;
    this.checked = state.checked;
    this.save = save;
  }

  static async create(workspace: string, env?: NodeJS.ProcessEnv, state: VerificationState = { changed: false }, save: (state: VerificationState) => void = () => {}): Promise<Verification> {
    const verification = new Verification(workspace, state.policy ?? await commandsFor(workspace), env, state, save);
    verification.persist();
    return verification;
  }

  private persist(): void {
    this.save({ changed: this.changed, policy: this.policy, ...(this.checked ? { checked: this.checked } : {}) });
  }

  async beforeTool(call: ToolCall): Promise<void> {
    if (call.name === "bash") {
      // Proven read-only shell commands cannot mutate the workspace. Skipping the fingerprint also avoids
      // treating unrelated runtime churn in broad directories such as /tmp as an agent edit.
      if (isReadOnlyBashCommand(String(call.input.command ?? ""))) return;
      this.beforeBash = await fingerprint(this.workspace, this.env);
      this.previousState = { changed: this.changed, checked: this.checked };
      this.changed = true;
      this.checked = undefined;
      this.persist();
    }
    // A stopped or failed write may already have changed files; invalidate before it starts.
    if (call.name === "write_file" || call.name === "edit_file") { this.changed = true; this.checked = undefined; this.persist(); }
  }

  async afterTool(call: ToolCall): Promise<void> {
    if (call.name === "bash" && this.beforeBash) {
      const after = await fingerprint(this.workspace, this.env);
      if (after !== this.beforeBash) this.progress++;
      if (this.beforeBash === after && this.previousState) {
        this.changed = this.previousState.changed;
        this.checked = this.previousState.checked;
      }
      this.beforeBash = undefined;
      this.persist();
    }
  }

  async check(): Promise<string | null> {
    if (!this.changed) return null;
    if (this.checked && this.checked === await fingerprint(this.workspace, this.env)) return null;
    return this.commands.length
      ? "Changes have no passing verification for their current contents. Run verify_changes, fix any failures, then finish."
      : 'Changes are unverified. Configure .agent-checks.json with {"commands":["your test command"]} before starting a new session.';
  }

  tool(): Tool {
    return {
      spec: {
        name: "verify_changes",
        description: `Run the workspace's fixed verification commands after editing, before finishing: ${this.commands.join("; ") || "no checks configured"}. Any later edit invalidates the result.`,
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      dangerous: true,
      approvalInput: { commands: [...this.commands] },
      run: async (_input, ctx) => {
        this.changed = true;
        this.checked = undefined;
        this.persist();
        if (!this.commands.length) throw new ToolError('No checks configured. Add .agent-checks.json with a commands array before starting a new session.');
        if (this.policy.npmScripts !== undefined) {
          const manifest = JSON.parse(await readFile(resolveInWorkspace(this.workspace, "package.json"), "utf8"));
          if (scriptsSignature(manifest.scripts) !== this.policy.npmScripts) throw new ToolError("npm verification scripts changed since this session started. Restore them before verifying, or have the new checks reviewed before starting a new session.");
        }
        const before = await fingerprint(this.workspace, this.env);
        const outputs: string[] = [];
        let after: string | undefined;
        try {
          for (const command of this.commands) {
            const result = await runShell(command, { cwd: this.workspace, env: this.env, signal: ctx.signal, timeoutMs: TIMEOUT_MS });
            outputs.push(`$ ${command}\n${formatShellResult(result)}`);
            if (result.exitCode !== 0 || result.timedOut || result.stopped || result.leftRunning || result.startError) throw new ToolError(outputs.join("\n\n"));
          }
          after = await fingerprint(this.workspace, this.env);
          if (before !== after) throw new ToolError("Workspace contents changed during verification. Inspect the changes and run verify_changes again.");
          this.checked = after;
          this.persist();
          return outputs.join("\n\n") + `\n\nVerification passed for workspace ${after}.`;
        } finally {
          // A failing check can still generate files or fix content before reporting its failure.
          if (before !== (after ?? await fingerprint(this.workspace, this.env))) this.progress++;
        }
      },
    };
  }
}
