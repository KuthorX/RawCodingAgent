import { execFile, execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);
const SERVE_TIMEOUT_MS = 15_000;

export interface TailnetSelf {
  // MagicDNS name without the trailing dot, e.g. "my-mac.tailnet-name.ts.net".
  dnsName: string;
  // Login of the user this machine belongs to; `tailscale serve` puts the caller's login in Tailscale-User-Login.
  owner: string;
}

// Parses `tailscale status --json`. Tagged machines have no owner to compare callers against, so they are refused.
export function parseStatus(raw: string): TailnetSelf {
  let status: {
    BackendState?: string;
    CertDomains?: string[] | null;
    Self?: { DNSName?: string; UserID?: number; Tags?: string[] };
    User?: Record<string, { LoginName?: string }>;
  };
  try {
    status = JSON.parse(raw);
  } catch {
    throw new Error("could not parse `tailscale status --json`");
  }
  if (status.BackendState !== "Running") throw new Error(`Tailscale is not connected (state: ${status.BackendState ?? "unknown"})`);
  const dnsName = status.Self?.DNSName?.replace(/\.$/, "");
  if (!dnsName) throw new Error("this machine has no MagicDNS name; enable MagicDNS for the tailnet");
  if (!status.CertDomains?.includes(dnsName)) {
    throw new Error("HTTPS certificates are off for this tailnet; enable them in the admin console (DNS → HTTPS Certificates)");
  }
  if (status.Self?.Tags?.length) throw new Error("this machine is tagged; remote access needs a machine owned by a user");
  const owner = status.User?.[String(status.Self?.UserID)]?.LoginName;
  if (!owner) throw new Error("could not find the owner of this machine in `tailscale status`");
  return { dnsName, owner };
}

export async function readTailnetSelf(): Promise<TailnetSelf> {
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], { maxBuffer: 16 * 1024 * 1024 });
    return parseStatus(stdout);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("`tailscale` is not installed or not on PATH");
    throw err;
  }
}

interface ServeConfig {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
  Foreground?: Record<string, ServeConfig>;
}

// What else `tailscale serve status --json` already serves on this port, or null when it's free or only ours
// (`ours`: our target now, and the one a previous run recorded). `serve --bg` silently replaces whatever is on
// the port, so this guards the user's own serve config. Funnel on the port is refused: it would make it public.
export function servedElsewhere(raw: string, dnsName: string, httpsPort: number, ours: readonly string[]): string | null {
  const root = JSON.parse(raw || "{}") as ServeConfig;
  const hostPort = `${dnsName}:${httpsPort}`;
  for (const config of [root, ...Object.values(root.Foreground ?? {})]) {
    if (config.AllowFunnel?.[hostPort]) return "Funnel, open to the public internet";
    const tcp = config.TCP?.[String(httpsPort)];
    if (!tcp) continue;
    if (tcp.TCPForward) return `a TCP forward to ${tcp.TCPForward}`;
    const handlers = Object.entries(config.Web?.[hostPort]?.Handlers ?? {});
    const mine = handlers.length === 1 && handlers[0]![0] === "/" && ours.includes(handlers[0]![1].Proxy ?? "");
    if (!mine) return handlers.map(([path, h]) => `${path} -> ${h.Proxy ?? "(not a proxy)"}`).join(", ") || "something";
  }
  return null;
}

async function serveStatus(): Promise<string> {
  try {
    return (await run("tailscale", ["serve", "status", "--json"], { timeout: SERVE_TIMEOUT_MS })).stdout;
  } catch (err) {
    throw new Error(`\`tailscale serve status\` failed: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`);
  }
}

interface ServeState {
  pid: number;
  httpsPort: number;
  target: string;
}

function readState(stateFile: string): Partial<ServeState> {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as Partial<ServeState>;
  } catch {
    return {};
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// The target a run that died without cleaning up left on this port. A run that is still alive keeps its port:
// a second instance must not take it over.
export function leftoverTarget(state: Partial<ServeState>, httpsPort: number, alive: (pid: number) => boolean = processAlive): string | undefined {
  if (state.httpsPort !== httpsPort || typeof state.target !== "string" || typeof state.pid !== "number") return undefined;
  return alive(state.pid) ? undefined : state.target;
}

// Proxies https://<name>:<httpsPort> to the remote listener with `tailscale serve --bg`, and turns it off on exit.
// Not the foreground mode: on macOS (1.104) a killed foreground `serve` leaves its config behind, and the port
// stays taken until `serve reset`. Pid and target are recorded in stateFile, so a config left by a crash is
// recognized as ours next time and replaced.
export async function startServe(localPort: number, httpsPort: number, dnsName: string, stateFile: string): Promise<void> {
  const target = `http://127.0.0.1:${localPort}`;
  const leftover = leftoverTarget(readState(stateFile), httpsPort);
  const ours = leftover ? [target, leftover] : [target];
  let other: string | null;
  try {
    other = servedElsewhere(await serveStatus(), dnsName, httpsPort, ours);
  } catch (err) {
    throw err instanceof SyntaxError ? new Error("could not parse `tailscale serve status --json`") : err;
  }
  if (other) {
    throw new Error(`tailscale already serves port ${httpsPort} (${other}); use another --remote-port, or free it with \`tailscale serve --https=${httpsPort} off\``);
  }
  // Registered before serve starts, so no path leaves the config behind while this process lives on.
  process.once("exit", () => {
    try {
      execFileSync("tailscale", ["serve", `--https=${httpsPort}`, "off"], { stdio: "ignore", timeout: SERVE_TIMEOUT_MS });
      if (readState(stateFile).pid === process.pid) rmSync(stateFile, { force: true });
    } catch {
      process.stderr.write(`could not turn off tailscale serve; run \`tailscale serve --https=${httpsPort} off\`\n`);
    }
  });
  try {
    await run("tailscale", ["serve", "--bg", `--https=${httpsPort}`, target], { timeout: SERVE_TIMEOUT_MS });
  } catch (err) {
    const detail = (err as { stderr?: string }).stderr?.trim();
    throw new Error(`tailscale serve failed${detail ? `: ${detail}` : ""}`);
  }
  try {
    writeFileSync(stateFile, JSON.stringify({ pid: process.pid, httpsPort, target } satisfies ServeState));
  } catch (err) {
    process.stderr.write(`could not write ${stateFile} (${(err as Error).message}); after a crash, free the port with \`tailscale serve --https=${httpsPort} off\`\n`);
  }
}
