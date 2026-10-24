import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createRuntime, PROJECT_ROOT } from "./app.ts";
import { runCli } from "./cli.ts";
import { generateToken } from "./gui/http.ts";
import { SessionManager } from "./gui/manager.ts";
import { createGuiServers, listen } from "./gui/server.ts";
import type { RemoteEntries } from "./gui/remote/access.ts";
import { AuditLog } from "./gui/remote/audit.ts";
import { AccessVerifier, accessConfigFromEnv } from "./gui/remote/cf-access.ts";
import { DeviceStore } from "./gui/remote/devices.ts";
import { readTailnetSelf, startServe } from "./gui/remote/tailscale.ts";
import { renderError } from "./ui.ts";

const DEFAULT_PORT = 4317;
const DEFAULT_REMOTE_PORT = 443;
const DEFAULT_PUBLIC_PORT = 4318;

const USAGE = `usage:
  npm start -- [--cwd <dir>] [--yes] [--resume <id>] [task]   terminal mode
  npm run gui -- [--cwd <dir>] [--yes] [--port <n>] [--remote [--remote-port <n>]] [--public [--public-port <n>]]   web UI
  --remote        also serve the UI to your other devices through \`tailscale serve\` (HTTPS on the tailnet name)
  --remote-port   HTTPS port on the tailnet name (default ${DEFAULT_REMOTE_PORT})
  --public        also accept requests from a Cloudflare Tunnel behind Cloudflare Access (setup: README 从公网访问)
  --public-port   127.0.0.1 port cloudflared forwards to (default ${DEFAULT_PUBLIC_PORT})
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
      public: { type: "boolean", default: false },
      "public-port": { type: "string" },
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
  const publicPort = parsePort(values["public-port"], DEFAULT_PUBLIC_PORT, "--public-port", 1);
  // Checked before listening, so a tailnet or Access problem fails fast instead of leaving a half-started GUI.
  const remote = values.remote || values.public ? await remoteEntries(values.remote ? remotePort : null, values.public) : undefined;
  const token = generateToken();
  const audit = remote ? new AuditLog(resolve(PROJECT_ROOT, ".audit.jsonl")) : undefined;
  const manager = new SessionManager(runtime);
  const servers = createGuiServers(manager, token, { remote, audit });
  const actual = await listen(servers.local, port);
  process.stdout.write(`raw-coding-agent GUI: http://127.0.0.1:${actual}/?token=${token}\n`);
  const closeAll = () => [servers.local, servers.tailnet, servers.public].forEach((s) => s?.close());
  // Stop accepting new requests first, then let running turns save their last step and release the locks.
  shutdownHandler = async () => {
    closeAll();
    await manager.shutdown();
  };
  if (remote?.public && servers.public) {
    // A fixed port: cloudflared's config points at it.
    await listen(servers.public, publicPort).catch((err: unknown) => {
      closeAll();
      throw err;
    });
    process.stdout.write(`public (Cloudflare Access): ${remote.public.origin}/  ← cloudflared → http://127.0.0.1:${publicPort}\n`);
  }
  if (!remote?.tailnet || !servers.tailnet) return;
  // Its own port, chosen by the OS: only `tailscale serve` is pointed at it.
  const tailnetLocal = await listen(servers.tailnet, 0).catch((err: unknown) => {
    closeAll();
    throw err;
  });
  // One per HTTPS port: instances on different ports must not overwrite each other's record.
  const stateFile = resolve(PROJECT_ROOT, `.remote-serve-${remotePort}.json`);
  await startServe(tailnetLocal, remotePort, new URL(remote.tailnet.origin).hostname, stateFile).catch((err: unknown) => {
    closeAll();
    throw err;
  });
  process.stdout.write(`remote (tailnet, ${remote.tailnet.owner} only): ${remote.tailnet.origin}/  — pair a device in 设置 → 远程访问\n`);
}

function parsePort(raw: string | undefined, fallback: number, flag: string, min = 0): number {
  const port = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(port) || port < min || port > 65535) throw new Error(`${flag} must be ${min}-65535, got "${raw}"`);
  return port;
}

// tailnetPort: the HTTPS port for `tailscale serve`, or null without --remote.
async function remoteEntries(tailnetPort: number | null, pub: boolean): Promise<RemoteEntries> {
  const entries: RemoteEntries = { devices: new DeviceStore(resolve(PROJECT_ROOT, ".devices.json")) };
  if (tailnetPort !== null) {
    const self = await readTailnetSelf();
    // URL drops the default port, matching the Host header browsers send.
    entries.tailnet = { origin: new URL(`https://${self.dnsName}:${tailnetPort}`).origin, owner: self.owner };
  }
  if (pub) entries.public = await publicEntry();
  return entries;
}

async function publicEntry(): Promise<NonNullable<RemoteEntries["public"]>> {
  const raw = process.env.PUBLIC_ORIGIN?.trim();
  if (!raw) throw new Error("--public needs PUBLIC_ORIGIN in .env, e.g. https://agent.example.com (see README: 从公网访问)");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`PUBLIC_ORIGIN must be https://, got ${raw}`);
  const verifier = new AccessVerifier(accessConfigFromEnv(process.env));
  // Proves the team domain is right before anything is served.
  await verifier.refresh().catch((err: unknown) => {
    throw new Error(`could not load Cloudflare Access keys from ${verifier.certsUrl}: ${(err as Error).message}`);
  });
  return { origin: url.origin, verifier };
}

// Turn Ctrl-C / kill into a normal exit so "exit" handlers (session lock release) run. In GUI mode the
// handler first stops running turns and waits for their step checkpoints; a second signal exits at once.
let shutdownHandler: (() => Promise<void>) | null = null;
let shuttingDown = false;
const shutdown = (code: number): void => {
  if (shuttingDown) return process.exit(code);
  shuttingDown = true;
  if (!shutdownHandler) return process.exit(code);
  shutdownHandler()
    .catch((err: unknown) => process.stderr.write(`shutdown: ${String(err)}\n`))
    .finally(() => process.exit(code));
};
process.once("SIGINT", () => shutdown(130));
process.once("SIGTERM", () => shutdown(143));
// Closing the terminal window; --remote turns its tailscale serve config off in an "exit" handler too.
// Only with a terminal: under nohup the hangup is meant to be ignored, and a handler would undo that.
if (process.stdout.isTTY) process.once("SIGHUP", () => shutdown(129));

main().catch((err: unknown) => {
  renderError(err);
  process.exitCode = 1;
});
