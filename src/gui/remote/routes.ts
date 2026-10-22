import type { IncomingMessage, ServerResponse } from "node:http";
import QRCode from "qrcode";
import { HttpError, readJson, sendJson } from "../http.ts";
import { deviceCookie, type Caller, type Entry, type RemoteEntries } from "./access.ts";

// Open event streams per device, so revoking a device cuts it off at once instead of at its next request.
export class DeviceStreams {
  private readonly open = new Map<string, Set<ServerResponse>>();

  add(deviceId: string, res: ServerResponse): () => void {
    const set = this.open.get(deviceId) ?? new Set();
    this.open.set(deviceId, set.add(res));
    return () => {
      set.delete(res);
      if (set.size === 0 && this.open.get(deviceId) === set) this.open.delete(deviceId);
    };
  }

  close(deviceId: string): void {
    for (const res of this.open.get(deviceId) ?? []) res.end();
    this.open.delete(deviceId);
  }
}

function describe(remote: RemoteEntries | undefined, caller: Caller) {
  if (!remote) return { enabled: false };
  const remoteCaller = caller.kind === "remote" ? caller : null;
  return {
    enabled: true,
    tailnet: remote.tailnet ? { url: remote.tailnet.origin, owner: remote.tailnet.owner } : null,
    public: remote.public ? { url: remote.public.origin } : null,
    devices: remote.devices.list(),
    // The entry this page came through, and its device.
    via: remoteCaller?.via ?? null,
    you: remoteCaller?.device?.id ?? null,
  };
}

function entryOf(remote: RemoteEntries, via: unknown): { entry: Entry; origin: string } {
  if (via !== undefined && via !== "tailnet" && via !== "public") throw new HttpError(400, '"via" must be "tailnet" or "public"');
  // Without "via": the only entry that is on.
  const entry = (via as Entry | undefined) ?? (remote.tailnet ? "tailnet" : "public");
  const origin = remote[entry]?.origin;
  if (!origin) throw new HttpError(404, `the ${entry} entry is off`);
  return { entry, origin };
}

// Routes: GET /api/remote, POST /api/remote/pairing (host only), POST /api/remote/revoke, POST /api/pair (remote only).
export async function handleRemote(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  caller: Caller,
  remote: RemoteEntries | undefined,
  streams: DeviceStreams,
): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/remote") return sendJson(res, 200, describe(remote, caller));
  if (!remote) throw new HttpError(404, "remote access is off; start with --remote or --public");
  if (req.method !== "POST") throw new HttpError(404, "not found");
  const body = await readJson(req);
  if (route === "POST /api/remote/pairing") {
    // The code is the proof of being at the host, so only the host's own page can create one.
    if (caller.kind !== "local") throw new HttpError(403, "pairing codes are created on the host machine");
    const { entry, origin } = entryOf(remote, body.via);
    const { code, expiresAt } = remote.devices.createPairingCode(entry);
    // In the fragment, so the code isn't sent in the request line or kept in proxy logs.
    const link = `${origin}/pair#${code}`;
    const svg = await QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return sendJson(res, 201, { link, svg, expiresAt });
  }
  if (route === "POST /api/remote/revoke") {
    if (!remote.devices.revoke(body.id)) throw new HttpError(404, "unknown device");
    streams.close(body.id as string);
    return sendJson(res, 200, describe(remote, caller));
  }
  if (route === "POST /api/pair") {
    if (caller.kind !== "remote") throw new HttpError(400, "pairing is for remote devices; this page already has access");
    const { device, token } = remote.devices.redeem(body.code, body.name, caller.via);
    res.setHeader("set-cookie", deviceCookie(token));
    return sendJson(res, 201, device);
  }
  throw new HttpError(404, "not found");
}
