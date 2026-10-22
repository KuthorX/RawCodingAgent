import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { after, before, test } from "node:test";
import { SessionManager } from "../src/gui/manager.ts";
import { DeviceStore, PAIRING_TTL_MS } from "../src/gui/remote/devices.ts";
import { leftoverTarget, parseStatus, servedElsewhere } from "../src/gui/remote/tailscale.ts";
import { createGuiServers, listen } from "../src/gui/server.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

// ---------- tailscale status ----------

const status = (patch: Record<string, unknown> = {}, self: Record<string, unknown> = {}) =>
  JSON.stringify({
    BackendState: "Running",
    CertDomains: ["box.tail.ts.net"],
    Self: { DNSName: "box.tail.ts.net.", UserID: 7, ...self },
    User: { "7": { LoginName: "me@github" } },
    ...patch,
  });

test("tailscale status: MagicDNS name without the dot, and the machine's owner", () => {
  assert.deepEqual(parseStatus(status()), { dnsName: "box.tail.ts.net", owner: "me@github" });
});

test("tailscale status: refuses what remote access can't work with", () => {
  assert.throws(() => parseStatus("not json"), /could not parse/);
  assert.throws(() => parseStatus(status({ BackendState: "Stopped" })), /not connected/);
  assert.throws(() => parseStatus(status({ CertDomains: null })), /HTTPS certificates are off/);
  assert.throws(() => parseStatus(status({}, { Tags: ["tag:server"] })), /tagged/);
  assert.throws(() => parseStatus(status({ User: {} })), /owner/);
});

test("serve status: a port is free, ours (left by a crash), or someone else's", () => {
  const ours = "http://127.0.0.1:4317";
  const web = (port: number, handlers: Record<string, unknown>) => ({ TCP: { [port]: { HTTPS: true } }, Web: { [`box.tail.ts.net:${port}`]: { Handlers: handlers } } });
  assert.equal(servedElsewhere("{}", "box.tail.ts.net", 443, [ours]), null);
  assert.equal(servedElsewhere(JSON.stringify(web(8443, { "/": { Proxy: "http://127.0.0.1:3000" } })), "box.tail.ts.net", 443, [ours]), null);
  assert.equal(servedElsewhere(JSON.stringify(web(443, { "/": { Proxy: ours } })), "box.tail.ts.net", 443, [ours]), null);
  assert.match(servedElsewhere(JSON.stringify(web(443, { "/": { Proxy: "http://127.0.0.1:3000" } })), "box.tail.ts.net", 443, [ours])!, /3000/);
  assert.match(servedElsewhere(JSON.stringify(web(443, { "/": { Proxy: ours }, "/docs": { Path: "/srv" } })), "box.tail.ts.net", 443, [ours])!, /docs/);
  assert.match(servedElsewhere(JSON.stringify({ TCP: { 443: { TCPForward: "127.0.0.1:22" } } }), "box.tail.ts.net", 443, [ours])!, /TCP forward/);
  // Public: refused even when the proxy is ours.
  assert.match(servedElsewhere(JSON.stringify({ ...web(443, { "/": { Proxy: ours } }), AllowFunnel: { "box.tail.ts.net:443": true } }), "box.tail.ts.net", 443, [ours])!, /Funnel/);
  // Left behind by a crashed run (recorded target), on a port of its own that changed since.
  assert.equal(servedElsewhere(JSON.stringify(web(443, { "/": { Proxy: "http://127.0.0.1:5000" } })), "box.tail.ts.net", 443, [ours, "http://127.0.0.1:5000"]), null);
  // Another process's foreground serve counts too.
  assert.match(servedElsewhere(JSON.stringify({ Foreground: { abc: web(443, { "/": { Proxy: "http://127.0.0.1:9" } }) } }), "box.tail.ts.net", 443, [ours])!, /:9/);
});

test("serve state: a dead run's target on the same port is a leftover; a live run keeps its port", () => {
  const state = { pid: 42, httpsPort: 443, target: "http://127.0.0.1:5000" };
  assert.equal(leftoverTarget(state, 443, () => false), "http://127.0.0.1:5000");
  assert.equal(leftoverTarget(state, 443, () => true), undefined);
  assert.equal(leftoverTarget(state, 8443, () => false), undefined);
  assert.equal(leftoverTarget({}, 443, () => false), undefined);
});

// ---------- device store ----------

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test("pairing code: single use, expires, and the token authenticates until revoked", () => {
  const c = clock();
  const file = join(tempWorkspace(), "devices.json");
  const store = new DeviceStore(file, c.now);
  const { code } = store.createPairingCode();
  const { device, token } = store.redeem(code, "  iPhone  ");
  assert.equal(device.name, "iPhone");
  assert.throws(() => store.redeem(code, "again"), /wrong or expired/);
  assert.equal(store.authenticate(token)?.id, device.id);
  assert.equal(store.authenticate("forged"), null);
  assert.equal(store.authenticate(undefined), null);
  assert.ok(!("tokenHash" in store.list()[0]!), "list() must not expose token hashes");

  // Survives a restart; the token itself is never on disk.
  assert.equal(new DeviceStore(file, c.now).authenticate(token)?.id, device.id);
  assert.ok(!readFileSync(file, "utf8").includes(token));

  const late = store.createPairingCode().code;
  c.advance(PAIRING_TTL_MS + 1);
  assert.throws(() => store.redeem(late, "x"), /wrong or expired/);

  assert.equal(store.revoke(device.id), true);
  assert.equal(store.revoke(device.id), false);
  assert.equal(store.authenticate(token), null);
});

test("pairing: repeated wrong codes lock pairing for a while, even for a right code", () => {
  const c = clock();
  const store = new DeviceStore(join(tempWorkspace(), "devices.json"), c.now);
  for (let i = 0; i < 10; i++) assert.throws(() => store.redeem("guess" + i, "x"), /wrong or expired/);
  assert.throws(() => store.redeem(store.createPairingCode().code, "x"), /too many/);
  c.advance(60_000 + 1);
  assert.ok(store.redeem(store.createPairingCode().code, "x").token);
});

test("devices: another instance's revoke is seen; an unreadable file is set aside, not overwritten", () => {
  const dir = tempWorkspace();
  const file = join(dir, "devices.json");
  const a = new DeviceStore(file);
  const b = new DeviceStore(file);
  const { device, token } = a.redeem(a.createPairingCode().code, "phone");
  assert.equal(b.authenticate(token)?.id, device.id);
  assert.equal(b.revoke(device.id), true);
  assert.equal(a.authenticate(token), null);

  // A read error is passing: nothing is moved aside, the devices in memory stay.
  const { token: kept } = a.redeem(a.createPairingCode().code, "laptop");
  chmodSync(file, 0o000);
  try {
    assert.equal(new DeviceStore(file).list().length, 0);
    assert.ok(!existsSync(`${file}.bad`));
  } finally {
    chmodSync(file, 0o600);
  }
  assert.ok(a.authenticate(kept));

  writeFileSync(file, "{broken");
  const c = new DeviceStore(file);
  assert.deepEqual(c.list(), []);
  assert.equal(readFileSync(`${file}.bad`, "utf8"), "{broken");
});

// ---------- server ----------

const TOKEN = "test-token";
const ORIGIN = "https://box.tail.ts.net";
const REMOTE_HOST = "box.tail.ts.net";
const OWNER = "me@github";
let port = 0;
let remotePort = 0;
let workspace = "";
let close: () => void = () => {};
let picks = 0;

before(async () => {
  const runtime = testRuntime(new ScriptedProvider([reply("hello")]));
  workspace = runtime.store.root;
  const devices = new DeviceStore(join(tempWorkspace(), "devices.json"));
  const servers = createGuiServers(new SessionManager(runtime), TOKEN, {
    remote: { origin: ORIGIN, owner: OWNER, devices },
    pickFolder: async () => (picks++, null),
  });
  port = await listen(servers.local, 0);
  remotePort = await listen(servers.remote!, 0);
  close = () => {
    servers.local.close();
    servers.remote!.close();
  };
});
after(() => close());

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

// remote: the request as `tailscale serve` forwards it to the remote listener (tailnet Host, owner's login,
// https Origin on POSTs).
function call(method: string, path: string, opts: { body?: unknown; remote?: boolean; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = opts.remote
    ? { host: REMOTE_HOST, "tailscale-user-login": OWNER, ...(method === "GET" ? {} : { origin: ORIGIN }) }
    : { host: `127.0.0.1:${port}`, "x-agent-token": TOKEN };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, opts.headers);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: opts.remote ? remotePort : port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function pairDevice(name = "phone"): Promise<{ cookie: string; id: string }> {
  const pairing = JSON.parse((await call("POST", "/api/remote/pairing", { body: {} })).body) as { link: string };
  const code = pairing.link.split("#")[1];
  const res = await call("POST", "/api/pair", { remote: true, body: { code, name } });
  assert.equal(res.status, 201);
  const cookie = String(res.headers["set-cookie"]).split(";")[0]!;
  return { cookie, id: (JSON.parse(res.body) as { id: string }).id };
}

test("remote: only the tailnet name, only the owner, only same-origin writes", async () => {
  assert.equal((await call("GET", "/", { remote: true, headers: { host: "evil.example" } })).status, 403);
  assert.equal((await call("GET", "/", { remote: true, headers: { "tailscale-user-login": "" } })).status, 403);
  assert.equal((await call("GET", "/", { remote: true, headers: { "tailscale-user-login": "someone@else" } })).status, 403);
  assert.equal((await call("POST", "/api/pair", { remote: true, body: {}, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("POST", "/api/pair", { remote: true, body: {}, headers: { origin: "" } })).status, 403);
  // Pages load; APIs want a paired device. The startup token doesn't count remotely.
  assert.equal((await call("GET", "/", { remote: true })).status, 200);
  assert.equal((await call("GET", "/pair", { remote: true })).status, 200);
  assert.equal((await call("GET", "/api/sessions", { remote: true })).status, 401);
  assert.equal((await call("GET", `/api/sessions?token=${TOKEN}`, { remote: true })).status, 401);
});

test("remote: a tailnet peer can't pass as the host by sending a loopback Host through serve", async () => {
  const local = { host: `127.0.0.1:${port}`, "x-agent-token": TOKEN };
  assert.equal((await call("GET", "/api/sessions", { remote: true, headers: local })).status, 403);
  assert.equal((await call("POST", "/api/projects/pick", { remote: true, body: {}, headers: local })).status, 403);
  // And the host's listener doesn't take tailnet requests.
  assert.equal((await call("GET", "/api/sessions", { headers: { host: REMOTE_HOST, "tailscale-user-login": OWNER } })).status, 403);
});

test("remote: pairing gives an HttpOnly Secure cookie that opens the API", async () => {
  const pairing = await call("POST", "/api/remote/pairing", { body: {} });
  assert.equal(pairing.status, 201);
  const { link, svg } = JSON.parse(pairing.body) as { link: string; svg: string };
  assert.match(link, /^https:\/\/box\.tail\.ts\.net\/pair#[\w-]{22}$/);
  assert.match(svg, /^<svg/);

  const code = link.split("#")[1];
  const paired = await call("POST", "/api/pair", { remote: true, body: { code, name: "phone" } });
  assert.equal(paired.status, 201);
  assert.match(String(paired.headers["set-cookie"]), /^__Host-rca_device=[\w-]+; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal((await call("POST", "/api/pair", { remote: true, body: { code, name: "again" } })).status, 403);

  const cookie = String(paired.headers["set-cookie"]).split(";")[0]!;
  assert.equal((await call("GET", "/api/sessions", { remote: true, headers: { cookie } })).status, 200);
  const info = JSON.parse((await call("GET", "/api/remote", { remote: true, headers: { cookie } })).body) as { you: string; devices: { id: string }[] };
  assert.ok(info.devices.some((d) => d.id === info.you));
});

test("remote: pairing codes only on the host; pairing only from remote", async () => {
  const { cookie } = await pairDevice();
  assert.equal((await call("POST", "/api/remote/pairing", { remote: true, body: {}, headers: { cookie } })).status, 403);
  assert.equal((await call("POST", "/api/pair", { body: { code: "x" } })).status, 400);
});

test("remote: host-screen actions are refused from devices", async () => {
  const { cookie } = await pairDevice();
  const before = picks;
  assert.equal((await call("POST", "/api/projects/pick", { remote: true, body: {}, headers: { cookie } })).status, 403);
  assert.equal((await call("POST", "/api/projects/reveal", { remote: true, body: { path: workspace }, headers: { cookie } })).status, 403);
  assert.equal((await call("POST", "/api/sessions/20260101-000000-abcdef/reveal", { remote: true, body: { name: "meta.json" }, headers: { cookie } })).status, 403);
  assert.equal(picks, before, "the native dialog must not open");
  // An unknown session's event stream is a plain error, not a stream left registered for the device.
  assert.equal((await call("GET", "/events/20260101-000000-abcdef", { remote: true, headers: { cookie } })).status, 404);
});

test("remote: revoking a device ends its open event streams and its access", async () => {
  const { cookie, id } = await pairDevice();
  const created = await call("POST", "/api/sessions", { body: { workspace } });
  const session = (JSON.parse(created.body) as { id: string }).id;

  const ended = new Promise<string>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: remotePort, path: `/events/${session}`, headers: { host: REMOTE_HOST, "tailscale-user-login": OWNER, cookie } }, (res) => {
      assert.equal(res.statusCode, 200);
      let body = "";
      res.on("data", (d: Buffer) => {
        body += d.toString();
        // Revoke once the stream is live.
        if (body.includes("replay_done") && !body.includes("REVOKED")) {
          body += "REVOKED";
          void call("POST", "/api/remote/revoke", { body: { id } });
        }
      });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.end();
  });
  assert.match(await ended, /REVOKED/);
  assert.equal((await call("GET", "/api/sessions", { remote: true, headers: { cookie } })).status, 401);
  assert.equal((await call("POST", "/api/remote/revoke", { body: { id } })).status, 404);
});

test("without --remote: a tailnet Host is refused and remote access reports off", async () => {
  const runtime = testRuntime(new ScriptedProvider([]));
  const servers = createGuiServers(new SessionManager(runtime), TOKEN);
  assert.equal(servers.remote, null);
  const server = servers.local;
  const local = await listen(server, 0);
  try {
    const get = (host: string, path: string) =>
      new Promise<Res>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: local, path, headers: { host, "x-agent-token": TOKEN, "tailscale-user-login": OWNER } }, (res) => {
          let body = "";
          res.on("data", (d: Buffer) => (body += d.toString()));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.end();
      });
    assert.equal((await get(REMOTE_HOST, "/")).status, 403);
    assert.deepEqual(JSON.parse((await get(`127.0.0.1:${local}`, "/api/remote")).body), { enabled: false });
  } finally {
    server.close();
  }
});
