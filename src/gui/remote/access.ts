import type { IncomingMessage } from "node:http";
import { HttpError } from "../http.ts";
import type { Device, DeviceStore } from "./devices.ts";

// __Host-: the browser refuses it with a Domain attribute, so another *.ts.net machine can't plant one for us.
const DEVICE_COOKIE = "__Host-rca_device";
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;

// Remote access through `tailscale serve`: it terminates HTTPS on the tailnet name and proxies to our remote
// listener on 127.0.0.1, replacing any client-sent Tailscale-User-Login with the caller's real login (tagged callers get none).
export interface RemoteAccess {
  // e.g. "https://my-mac.tailnet.ts.net" or "https://my-mac.tailnet.ts.net:8443"
  origin: string;
  owner: string;
  devices: DeviceStore;
}

export type Caller = { kind: "local" } | { kind: "remote"; device: Device | null };

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

// Everything on the listener `tailscale serve` proxies to.
export function identifyRemote(req: IncomingMessage, remote: RemoteAccess): Caller {
  if (req.headers.host !== new URL(remote.origin).host) throw new HttpError(403, "forbidden host");
  // A missing login means a tagged device or a request that bypassed serve: refuse it, don't treat it as the owner.
  if (req.headers["tailscale-user-login"] !== remote.owner) throw new HttpError(403, "only the owner of this machine's tailnet account");
  // Cookies are SameSite=Strict, but check Origin too so no other page can post to us.
  const safe = req.method === "GET" || req.method === "HEAD";
  if (!safe && req.headers.origin !== remote.origin) throw new HttpError(403, "forbidden origin");
  return { kind: "remote", device: remote.devices.authenticate(cookie(req, DEVICE_COOKIE)) };
}

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; Secure; SameSite=Strict`;
}
