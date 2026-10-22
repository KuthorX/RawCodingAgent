import type { IncomingMessage } from "node:http";
import { HttpError } from "../http.ts";
import type { Device, DeviceStore } from "./devices.ts";

// __Host-: the browser refuses it with a Domain attribute, so another *.ts.net machine can't plant one for us.
const DEVICE_COOKIE = "__Host-rca_device";
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

export type Entry = "tailnet" | "public";

// Checks the Cloudflare Access token of a public request; resolves to the signed-in account.
export interface TokenVerifier {
  verify(token: string | undefined): Promise<{ email: string }>;
}

// The ways in from other devices. Each has its own 127.0.0.1 listener that only its proxy points at;
// both share one list of paired devices, but a device (and a pairing code) only works through the entry it was made for.
export interface RemoteEntries {
  devices: DeviceStore;
  // `tailscale serve`: HTTPS on the tailnet name, replacing any client-sent Tailscale-User-Login with the
  // caller's real login (tagged callers get none). e.g. "https://my-mac.tailnet.ts.net".
  tailnet?: { origin: string; owner: string };
  // A Cloudflare Tunnel whose hostname is behind Cloudflare Access, e.g. "https://agent.example.com".
  public?: { origin: string; verifier: TokenVerifier };
}

// who: the tailnet login or the Access email, for the audit log.
export type Caller = { kind: "local" } | { kind: "remote"; via: Entry; who: string; device: Device | null };

// The paired device, if the cookie belongs to one paired through this same entry.
function deviceOf(req: IncomingMessage, entries: RemoteEntries, via: Entry): Device | null {
  const device = entries.devices.authenticate(cookie(req, DEVICE_COOKIE));
  return device && (!device.via || device.via === via) ? device : null;
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

// The host's own pages: only our loopback address as Host (DNS rebinding); the token is checked per route.
export function identifyLocal(req: IncomingMessage, port: number): Caller {
  const host = req.headers.host;
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, "forbidden host");
  return { kind: "local" };
}

// Host (DNS rebinding) and, for writes, Origin: cookies are SameSite=Strict, but no other page may post to us.
function checkOrigin(req: IncomingMessage, origin: string): void {
  if (req.headers.host !== new URL(origin).host) throw new HttpError(403, "forbidden host");
  const safe = req.method === "GET" || req.method === "HEAD";
  if (!safe && req.headers.origin !== origin) throw new HttpError(403, "forbidden origin");
}

// Everything on the listener `tailscale serve` proxies to.
export function identifyTailnet(req: IncomingMessage, entries: RemoteEntries): Caller {
  const tailnet = entries.tailnet!;
  checkOrigin(req, tailnet.origin);
  // A missing login means a tagged device or a request that bypassed serve: refuse it, don't treat it as the owner.
  const login = req.headers["tailscale-user-login"];
  if (login !== tailnet.owner) throw new HttpError(403, "only the owner of this machine's tailnet account");
  return { kind: "remote", via: "tailnet", who: login, device: deviceOf(req, entries, "tailnet") };
}

// Everything on the listener cloudflared forwards to. Access has already signed the user in at the edge;
// its token is checked again here, so a policy mistake on Cloudflare's side doesn't open the door.
export async function identifyPublic(req: IncomingMessage, entries: RemoteEntries): Promise<Caller> {
  const pub = entries.public!;
  checkOrigin(req, pub.origin);
  const token = req.headers["cf-access-jwt-assertion"];
  const { email } = await pub.verifier.verify(typeof token === "string" ? token : undefined);
  return { kind: "remote", via: "public", who: email, device: deviceOf(req, entries, "public") };
}

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}
