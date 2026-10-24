import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import { after, before, test } from "node:test";
import { SessionManager } from "../src/gui/manager.ts";
import { HttpError } from "../src/gui/http.ts";
import { AuditLog, type AuditRecord } from "../src/gui/remote/audit.ts";
import { AccessVerifier, accessConfigFromEnv, type AccessConfig } from "../src/gui/remote/cf-access.ts";
import { DeviceStore } from "../src/gui/remote/devices.ts";
import { createGuiServers, listen } from "../src/gui/server.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

// ---------- Access JWT ----------

const TEAM = "https://myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";
const CONFIG: AccessConfig = { teamDomain: TEAM, aud: AUD, emails: ["me@example.com"] };
const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

function keyPair(kid: string): { kid: string; privateKey: KeyObject; jwk: Record<string, unknown> } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

const KEY_A = keyPair("a");
const KEY_B = keyPair("b");
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(claims: Record<string, unknown>, opts: { key?: ReturnType<typeof keyPair>; header?: Record<string, unknown> } = {}): string {
  const key = opts.key ?? KEY_A;
  const head = b64({ alg: "RS256", kid: key.kid, typ: "JWT", ...opts.header });
  const body = b64({ iss: TEAM, aud: [AUD], email: "Me@Example.com", exp: NOW_S + 600, iat: NOW_S, nbf: NOW_S, ...claims });
  const signature = sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url");
  return `${head}.${body}.${signature}`;
}

function verifier(keys = [KEY_A], now = () => NOW_MS) {
  let fetches = 0;
  const v = new AccessVerifier(CONFIG, async (url) => {
    fetches++;
    assert.equal(url, `${TEAM}/cdn-cgi/access/certs`);
    return { keys: keys.map((k) => k.jwk) };
  }, now);
  return { v, fetches: () => fetches };
}

async function refused(promise: Promise<unknown>, pattern: RegExp, status = 403): Promise<void> {
  await assert.rejects(promise, (err: unknown) => err instanceof HttpError && err.status === status && pattern.test(err.message));
}

test("access: a valid token gives the lowercased email", async () => {
  const { v } = verifier();
  assert.deepEqual(await v.verify(jwt({})), { email: "me@example.com" });
  // aud as a plain string is accepted too.
  assert.deepEqual(await v.verify(jwt({ aud: AUD })), { email: "me@example.com" });
});

test("access: forged, foreign, stale and unlisted tokens are refused", async () => {
  const { v } = verifier();
  await refused(v.verify(undefined), /missing/);
  await refused(v.verify("not-a-jwt"), /malformed/);
  await refused(v.verify(jwt({}, { header: { alg: "none" } })), /algorithm/);
  await refused(v.verify(jwt({}, { header: { alg: "HS256" } })), /algorithm/);
  // Signed by a key that isn't the team's.
  await refused(v.verify(jwt({}, { key: { ...KEY_B, kid: "a" } })), /signature/);
  // Claims changed after signing.
  const [head, , sig] = jwt({}).split(".");
  await refused(v.verify(`${head}.${b64({ iss: TEAM, aud: [AUD], email: "me@example.com", exp: NOW_S + 9999 })}.${sig}`), /signature/);
  await refused(v.verify(jwt({ iss: "https://other.cloudflareaccess.com" })), /another team/);
  await refused(v.verify(jwt({ aud: ["someone-else"] })), /another application/);
  await refused(v.verify(jwt({ exp: NOW_S - 120 })), /expired/);
  await refused(v.verify(jwt({ exp: undefined })), /expired/);
  await refused(v.verify(jwt({ nbf: NOW_S + 120 })), /not valid yet/);
  await refused(v.verify(jwt({ email: "stranger@example.com" })), /not allowed/);
  // Within the clock-skew leeway is fine.
  assert.deepEqual(await v.verify(jwt({ exp: NOW_S - 30 })), { email: "me@example.com" });
});

test("access: an unknown key id refetches the key set, but not more than once a minute", async () => {
  let now = NOW_MS;
  let keys = [KEY_A];
  let fetches = 0;
  const v = new AccessVerifier(CONFIG, async () => (fetches++, { keys: keys.map((k) => k.jwk) }), () => now);
  await v.refresh();
  // Keys rotated on Cloudflare's side, but we fetched just now.
  keys = [KEY_A, KEY_B];
  await refused(v.verify(jwt({}, { key: KEY_B })), /unknown key/);
  assert.equal(fetches, 1);
  now += 61_000;
  assert.deepEqual(await v.verify(jwt({ exp: now / 1000 + 600 }, { key: KEY_B })), { email: "me@example.com" });
  assert.equal(fetches, 2);
});

test("access: an unreachable key set is a 503, not a pass", async () => {
  const v = new AccessVerifier(CONFIG, async () => {
    throw new Error("offline");
  }, () => NOW_MS);
  await refused(v.verify(jwt({})), /could not load Access signing keys: offline/, 503);
  await assert.rejects(new AccessVerifier(CONFIG, async () => ({ keys: [] })).refresh(), /no RSA keys/);
});

test("access: config from .env", () => {
  assert.deepEqual(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "myteam", CF_ACCESS_AUD: " x ", PUBLIC_ALLOWED_EMAILS: "A@b.c, d@e.f ," }), {
    teamDomain: TEAM,
    aud: "x",
    emails: ["a@b.c", "d@e.f"],
  });
  assert.equal(accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "https://myteam.cloudflareaccess.com/", CF_ACCESS_AUD: "x", PUBLIC_ALLOWED_EMAILS: "a@b.c" }).teamDomain, TEAM);
  assert.throws(() => accessConfigFromEnv({ CF_ACCESS_AUD: "x" }), /CF_ACCESS_TEAM_DOMAIN, PUBLIC_ALLOWED_EMAILS/);
});

// ---------- the public listener ----------

const TOKEN = "test-token";
const ORIGIN = "https://agent.example.com";
const HOST = "agent.example.com";
const GOOD = "good-access-token";
let port = 0;
let publicPort = 0;
let workspace = "";
let auditFile = "";
let close: () => void = () => {};

before(async () => {
  const runtime = testRuntime(new ScriptedProvider([reply("hello")]));
  workspace = runtime.store.root;
  const dir = tempWorkspace();
  auditFile = join(dir, "audit.jsonl");
  const fakeVerifier = {
    async verify(token: string | undefined) {
      if (token !== GOOD) throw new HttpError(403, "bad Access token");
      return { email: "me@example.com" };
    },
  };
  const servers = createGuiServers(new SessionManager(runtime), TOKEN, {
    remote: { devices: new DeviceStore(join(dir, "devices.json")), public: { origin: ORIGIN, verifier: fakeVerifier } },
    audit: new AuditLog(auditFile),
  });
  assert.equal(servers.tailnet, null);
  port = await listen(servers.local, 0);
  publicPort = await listen(servers.public!, 0);
  close = () => {
    servers.local.close();
    servers.public!.close();
  };
});
after(() => close());

interface Res {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

// pub: the request as cloudflared forwards it (public Host, Access token, https Origin on POSTs).
function call(method: string, path: string, opts: { body?: unknown; pub?: boolean; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = opts.pub
    ? { host: HOST, "cf-access-jwt-assertion": GOOD, ...(method === "GET" ? {} : { origin: ORIGIN }) }
    : { host: `127.0.0.1:${port}`, "x-agent-token": TOKEN };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  Object.assign(headers, opts.headers);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: opts.pub ? publicPort : port, method, path, headers }, (res) => {
      let body = "";
      res.on("data", (d: Buffer) => (body += d.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    if (opts.body !== undefined) req.write(JSON.stringify(opts.body));
    req.end();
  });
}

async function pairPublic(): Promise<string> {
  const pairing = await call("POST", "/api/remote/pairing", { body: { via: "public" } });
  assert.equal(pairing.status, 201);
  const { link } = JSON.parse(pairing.body) as { link: string };
  assert.match(link, /^https:\/\/agent\.example\.com\/pair#[\w-]{22}$/);
  const res = await call("POST", "/api/pair", { pub: true, body: { code: link.split("#")[1], name: "phone" } });
  assert.equal(res.status, 201);
  assert.equal((JSON.parse(res.body) as { via: string }).via, "public");
  return String(res.headers["set-cookie"]).split(";")[0]!;
}

const auditRecords = (): AuditRecord[] =>
  existsSync(auditFile) ? readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as AuditRecord) : [];

// The record is written when the response finishes, which can be just after the client has it.
async function lastAudit(): Promise<AuditRecord> {
  await new Promise((r) => setTimeout(r, 20));
  return auditRecords().at(-1)!;
}

test("public: without a valid Access token, nothing is served (not even pages)", async () => {
  assert.equal((await call("GET", "/", { pub: true, headers: { "cf-access-jwt-assertion": "" } })).status, 403);
  assert.equal((await call("GET", "/", { pub: true, headers: { "cf-access-jwt-assertion": "forged" } })).status, 403);
  assert.equal((await call("GET", "/", { pub: true, headers: { host: "evil.example" } })).status, 403);
  assert.equal((await call("POST", "/api/pair", { pub: true, body: {}, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("GET", "/", { pub: true })).status, 200);
  // Access alone isn't enough for the API: the device must be paired too.
  assert.equal((await call("GET", "/api/sessions", { pub: true })).status, 401);
  assert.equal((await call("GET", `/api/sessions?token=${TOKEN}`, { pub: true })).status, 401);
});

test("public: pairing through the public link opens the API; host-screen actions stay refused", async () => {
  const cookie = await pairPublic();
  assert.equal((await call("GET", "/api/sessions", { pub: true, headers: { cookie } })).status, 200);
  assert.equal((await call("POST", "/api/projects/pick", { pub: true, body: {}, headers: { cookie } })).status, 403);
  assert.equal((await call("POST", "/api/remote/pairing", { pub: true, body: {}, headers: { cookie } })).status, 403);
  // The cookie alone, without Access, gets nowhere.
  assert.equal((await call("GET", "/api/sessions", { pub: true, headers: { cookie, "cf-access-jwt-assertion": "" } })).status, 403);
  const info = JSON.parse((await call("GET", "/api/remote", { pub: true, headers: { cookie } })).body) as Record<string, unknown>;
  assert.equal(info.via, "public");
  assert.equal(info.tailnet, null);
  assert.deepEqual(info.public, { url: ORIGIN });
  // The tailnet entry is off.
  assert.equal((await call("POST", "/api/remote/pairing", { body: { via: "tailnet" } })).status, 404);
  assert.equal((await call("POST", "/api/remote/pairing", { body: { via: "moon" } })).status, 400);
});

test("public: sessions created from the public entry always ask before running bash", async () => {
  const cookie = await pairPublic();
  const created = await call("POST", "/api/sessions", { pub: true, body: { workspace, approvalMode: "auto" }, headers: { cookie } });
  assert.equal(created.status, 201);
  assert.equal((JSON.parse(created.body) as { approvalMode: string }).approvalMode, "ask");
  // The host can still choose auto.
  const local = await call("POST", "/api/sessions", { body: { workspace, approvalMode: "auto" } });
  assert.equal((JSON.parse(local.body) as { approvalMode: string }).approvalMode, "auto");
});

test("audit: remote writes and refusals are logged with who and which device; reads and the host aren't", async () => {
  const cookie = await pairPublic();
  const devices = JSON.parse((await call("GET", "/api/remote", { pub: true, headers: { cookie } })).body) as { you: string };
  const count = auditRecords().length;

  await call("GET", "/api/sessions", { pub: true, headers: { cookie } });
  await call("POST", "/api/sessions", { body: { workspace } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(auditRecords().length, count, "remote reads and host requests aren't logged");

  await call("POST", "/api/sessions", { pub: true, body: { workspace }, headers: { cookie } });
  const write = await lastAudit();
  assert.deepEqual({ ...write, at: undefined, device: write.device?.id }, {
    at: undefined, via: "public", who: "me@example.com", device: devices.you, method: "POST", path: "/api/sessions", status: 201,
  });

  await call("GET", "/api/sessions?token=secret", { pub: true, headers: { "cf-access-jwt-assertion": "forged" } });
  const refusedRecord = await lastAudit();
  assert.equal(refusedRecord.status, 403);
  assert.equal(refusedRecord.who, undefined);
  assert.equal(refusedRecord.path, "/api/sessions", "no query string (it can carry a token)");
  assert.match(refusedRecord.at, /^\d{4}-\d\d-\d\dT/);
  // POSIX permissions only; Windows keeps the file readable regardless of the requested mode.
  if (process.platform !== "win32") assert.equal(statSync(auditFile).mode & 0o777, 0o600);
});

test("public: forking from the public entry starts in ask too, even from an auto session", async () => {
  const cookie = await pairPublic();
  const source = JSON.parse((await call("POST", "/api/sessions", { body: { workspace, approvalMode: "auto" } })).body) as { id: string };
  const forked = await call("POST", `/api/sessions/${source.id}/fork`, { pub: true, body: {}, headers: { cookie } });
  assert.equal(forked.status, 201);
  assert.equal((JSON.parse(forked.body) as { meta: { approvalMode: string } }).meta.approvalMode, "ask");
  // From the host, a fork keeps the source's mode.
  const local = JSON.parse((await call("POST", `/api/sessions/${source.id}/fork`, { body: {} })).body) as { meta: { approvalMode: string } };
  assert.equal(local.meta.approvalMode, "auto");
});

test("remote routes: unknown GETs are 404, not a body error", async () => {
  assert.equal((await call("GET", "/api/remote/whatever")).status, 404);
});

test("devices: a pairing code and a device only work through the entry they were made for", async () => {
  const devices = new DeviceStore(join(tempWorkspace(), "devices.json"));
  const { code } = devices.createPairingCode("public");
  assert.throws(() => devices.redeem(code, "phone", "tailnet"), /wrong or expired/);
  assert.equal(devices.redeem(code, "phone", "public").device.via, "public");

  const runtime = testRuntime(new ScriptedProvider([]));
  const verifier = { verify: async () => ({ email: "me@example.com" }) };
  const servers = createGuiServers(new SessionManager(runtime), TOKEN, {
    remote: { devices, tailnet: { origin: "https://box.tail.ts.net", owner: "me@github" }, public: { origin: ORIGIN, verifier } },
  });
  const tailnetPort = await listen(servers.tailnet!, 0);
  const pubPort = await listen(servers.public!, 0);
  try {
    const tailCode = devices.createPairingCode("tailnet").code;
    const { token } = devices.redeem(tailCode, "laptop", "tailnet");
    const cookie = `__Host-rca_device=${token}`;
    const get = (p: number, host: string, extra: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port: p, path: "/api/sessions", headers: { host, cookie, ...extra } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
    assert.equal(await get(tailnetPort, "box.tail.ts.net", { "tailscale-user-login": "me@github" }), 200);
    assert.equal(await get(pubPort, HOST, { "cf-access-jwt-assertion": "x" }), 401, "a tailnet device isn't paired on the public entry");
  } finally {
    servers.tailnet!.close();
    servers.public!.close();
  }
});

test("access: failed key fetches are throttled too; a malformed key is skipped; the team domain must be https", async () => {
  let now = NOW_MS;
  let fetches = 0;
  let fail = true;
  const v = new AccessVerifier(CONFIG, async () => {
    fetches++;
    if (fail) throw new Error("offline");
    return { keys: [{ kty: "RSA", kid: "broken", n: "!!", e: "AQAB" }, KEY_A.jwk] };
  }, () => now);
  await refused(v.verify(jwt({})), /offline/, 503);
  await refused(v.verify(jwt({})), /unknown key/);
  assert.equal(fetches, 1, "no second fetch within a minute of a failed one");
  fail = false;
  now += 61_000;
  assert.deepEqual(await v.verify(jwt({ exp: now / 1000 + 600 })), { email: "me@example.com" });
  assert.throws(() => accessConfigFromEnv({ CF_ACCESS_TEAM_DOMAIN: "http://myteam.cloudflareaccess.com", CF_ACCESS_AUD: "x", PUBLIC_ALLOWED_EMAILS: "a@b.c" }), /https/);
});
