import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRuntime, PROJECT_ROOT } from "./app.ts";
import { runCli } from "./cli.ts";
import { generateToken } from "./gui/http.ts";
import { SessionManager } from "./gui/manager.ts";
import { createGuiServers, listen } from "./gui/server.ts";
import type { RemoteAccess } from "./gui/remote/access.ts";
import { DeviceStore } from "./gui/remote/devices.ts";
import { readTailnetSelf, startServe } from "./gui/remote/tailscale.ts";
import { renderError } from "./ui.ts";

const DEFAULT_PORT = 4317;
const DEFAULT_REMOTE_PORT = 443;

const USAGE = `usage:
  npm start -- [--cwd <dir>] [--yes] [--resume <id>] [task]   terminal mode
  npm run gui -- [--cwd <dir>] [--yes] [--port <n>] [--remote [--remote-port <n>]]   web UI
  --remote        also serve the UI to your other devices through \`tailscale serve\` (HTTPS on the tailnet name)
  --remote-port   HTTPS port on the tailnet name (default ${DEFAULT_REMOTE_PORT})
  --cwd <dir>     workspace (added to the saved workspace list); terminal default: current directory
  --yes           new sessions (and a --resume'd one) auto-approve bash; switchable per session later
  --resume <id>   continue a stored session (ids are listed in the web UI and .sessions/)
  task            run once and exit; omit for interactive mode (/exit)`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      yes: { type: "boolean", default: false },
      resume: { type: "string" },
      gui: { type: "boolean", default: false },
      port: { type: "string" },
      remote: { type: "boolean", default: false },
      "remote-port": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const runtime = createRuntime(values.yes ? "auto" : "ask");
  // Every workspace used is remembered, so the GUI can offer it next time without --cwd.
  const workspace = values.cwd === undefined ? undefined : runtime.projects.add(values.cwd).path;

  if (!values.gui) {
    const task = positionals.join(" ").trim();
    const cwd = workspace ?? (values.resume ? process.cwd() : runtime.projects.add(process.cwd()).path);
    await runCli(runtime, { workspace: cwd, resumeId: values.resume, task, forceAuto: values.yes });
    return;
  }

  const port = parsePort(values.port, DEFAULT_PORT, "--port");
  const remotePort = parsePort(values["remote-port"], DEFAULT_REMOTE_PORT, "--remote-port", 1);
  // Checked before listening, so a tailnet problem fails fast instead of leaving a half-started GUI.
  const remote = values.remote ? await remoteAccess(remotePort) : undefined;
  const token = generateToken();
  const servers = createGuiServers(new SessionManager(runtime), token, { remote });
  const actual = await listen(servers.local, port);
  process.stdout.write(`raw-coding-agent GUI: http://127.0.0.1:${actual}/?token=${token}\n`);
  if (!remote || !servers.remote) return;
  // Its own port, chosen by the OS: only `tailscale serve` is pointed at it.
  const remoteLocal = await listen(servers.remote, 0);
  // One per HTTPS port: instances on different ports must not overwrite each other's record.
  const stateFile = resolve(PROJECT_ROOT, `.remote-serve-${remotePort}.json`);
  await startServe(remoteLocal, remotePort, new URL(remote.origin).hostname, stateFile).catch((err: unknown) => {
    servers.local.close();
    servers.remote?.close();
    throw err;
  });
  process.stdout.write(`remote (tailnet, ${remote.owner} only): ${remote.origin}/  — pair a device in 设置 → 远程访问\n`);
}

function parsePort(raw: string | undefined, fallback: number, flag: string, min = 0): number {
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < min || port > 65535) throw new Error(`${flag} must be ${min}-65535, got "${raw}"`);
  return port;
}

async function remoteAccess(httpsPort: number): Promise<RemoteAccess> {
  const self = await readTailnetSelf();
  // URL drops the default port, matching the Host header browsers send.
  const origin = new URL(`https://${self.dnsName}:${httpsPort}`).origin;
  return { origin, owner: self.owner, devices: new DeviceStore(resolve(PROJECT_ROOT, ".devices.json")) };
}

// Turn Ctrl-C / kill into a normal exit so "exit" handlers (session lock release) run.
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
// Closing the terminal window; --remote turns its tailscale serve config off in an "exit" handler too.
// Only with a terminal: under nohup the hangup is meant to be ignored, and a handler would undo that.
if (process.stdout.isTTY) process.once("SIGHUP", () => process.exit(129));

main().catch((err: unknown) => {
  renderError(err);
  process.exitCode = 1;
});
