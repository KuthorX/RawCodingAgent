import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { isApprovalMode } from "../agent/permissions.ts";
import { SendRejected } from "../session/runner.ts";
import { IMAGE_TYPES, isAttachmentName, isSessionFile, isSessionId, type TurnLimits } from "../session/store.ts";
import { HttpError, readJson, sendBytes, sendJson, sendText, tokenMatches } from "./http.ts";
import type { SessionManager } from "./manager.ts";
import { pickFolder as nativePickFolder, type PickFolder } from "./pick-folder.ts";
import { commitDetail, loadIterations } from "./iterations.ts";
import { revealInFileManager } from "./reveal.ts";
import { forWire } from "./wire.ts";
import { identifyLocal, identifyPublic, identifyTailnet, type Caller, type Entry, type RemoteEntries } from "./remote/access.ts";
import type { AuditLog } from "./remote/audit.ts";
import { DeviceStreams, handleRemote } from "./remote/routes.ts";

const HOST = "127.0.0.1";
const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HEARTBEAT_MS = 15_000;
const page = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const PAGES: Record<string, [string, string]> = {
  "/": ["text/html", page("index.html")],
  "/stats": ["text/html", page("stats.html")],
  "/raw": ["text/html", page("raw.html")],
  "/pair": ["text/html", page("pair.html")],
  "/iterations": ["text/html", page("iterations.html")],
  "/common.css": ["text/css", page("common.css")],
  "/common.js": ["text/javascript", page("common.js")],
  "/theme.js": ["text/javascript", page("theme.js")],
  "/markdown.js": ["text/javascript", page("markdown.js")],
};

function sessionId(raw: string | undefined): string {
  if (!raw || !isSessionId(raw)) throw new HttpError(400, "invalid session id");
  return raw;
}

function fileName(raw: unknown) {
  if (typeof raw !== "string" || !isSessionFile(raw)) throw new HttpError(400, "unknown session file");
  return raw;
}

const MAX_IMAGES = 8;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
// Base64 is 4/3 of the raw size; plus room for the text.
const MAX_MESSAGE_BODY = Math.ceil((MAX_IMAGES * MAX_IMAGE_BYTES * 4) / 3) + 1_000_000;

// "images": data URLs of pasted images (png / jpeg / gif / webp, at most MAX_IMAGES of MAX_IMAGE_BYTES each).
function parseImages(raw: unknown): { data: Buffer; mediaType: string }[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, '"images" must be an array of data URLs');
  if (raw.length > MAX_IMAGES) throw new HttpError(400, `at most ${MAX_IMAGES} images per message`);
  return raw.map((url, i) => {
    const m = typeof url === "string" ? /^data:([a-z/+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(url) : null;
    if (!m || !IMAGE_TYPES[m[1]!]) throw new HttpError(400, `image ${i + 1}: expected a png, jpeg, gif or webp data URL`);
    const data = Buffer.from(m[2]!, "base64");
    if (data.length > MAX_IMAGE_BYTES) throw new HttpError(413, `image ${i + 1} is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    return { data, mediaType: m[1]! };
  });
}

// A spending cap or limit: a number >= 0 (steps: a positive integer), or null for "no limit".
function capValue(raw: unknown, name: string, integer = false): number | null {
  if (raw === null) return null;
  const ok = typeof raw === "number" && Number.isFinite(raw) && (integer ? Number.isInteger(raw) && raw > 0 : raw >= 0);
  if (!ok) throw new HttpError(400, `"${name}" must be ${integer ? "a positive integer" : "a number >= 0"} or null`);
  return raw as number;
}

// Missing keys follow the global default, null means no limit.
function parseLimits(raw: unknown): TurnLimits {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new HttpError(400, '"limits" must be an object');
  const r = raw as Record<string, unknown>;
  const limits: TurnLimits = {};
  if ("maxSteps" in r) limits.maxSteps = capValue(r.maxSteps, "maxSteps", true);
  if ("maxTurnCostUsd" in r) limits.maxTurnCostUsd = capValue(r.maxTurnCostUsd, "maxTurnCostUsd");
  return limits;
}

// track: registers the open stream once the session is known, returns its cleanup.
function streamEvents(req: IncomingMessage, res: ServerResponse, manager: SessionManager, id: string, track: () => () => void): void {
  const runner = manager.get(id);
  const untrack = track();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify(runner.info)}\n\n`);
  const unsubscribe = runner.subscribe((event) => res.write(`data: ${JSON.stringify(forWire(event))}\n\n`));
  // subscribe() replays history synchronously; tell the client where live events begin.
  res.write("event: replay_done\ndata: {}\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    untrack();
  });
}

// One browser connection is enough for background notifications. Opening one EventSource per
// session exhausts the browser's HTTP connection pool as the session list grows, and also creates
// a runner/lock for every session. The session id is included so the client can apply its settings.
function streamAllEvents(req: IncomingMessage, res: ServerResponse, manager: SessionManager, track: () => () => void): void {
  const runners = manager.list().flatMap((meta) => {
    try {
      return [{ id: meta.id, runner: manager.get(meta.id) }];
    } catch {
      // Another process may own a session. Its own event stream will be unavailable too; keep the
      // global stream useful for the sessions this process can observe.
      return [];
    }
  });
  const untrack = track();
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write("event: hello\ndata: {}\n\n");
  const unsubscribe = runners.map(({ id, runner }) => runner.subscribe((event) => {
    res.write(`data: ${JSON.stringify({ sessionId: id, ...forWire(event) })}\n\n`);
  }));
  res.write("event: replay_done\ndata: {}\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    for (const stop of unsubscribe) stop();
    untrack();
  });
}

export interface GuiOptions {
  pickFolder?: PickFolder;
  remote?: RemoteEntries;
  // Records what remote callers change or get refused (only used with remote).
  audit?: AuditLog;
}

// One native dialog at a time: a second click while it is open would stack dialogs.
function folderPicker(pick: PickFolder): () => Promise<string | null> {
  let open = false;
  return async () => {
    if (open) throw new HttpError(409, "文件夹选择框已经打开");
    open = true;
    try {
      return await pick();
    } finally {
      open = false;
    }
  };
}

// Routes: /api/projects[/remove|/pick|/branches|/workspaces[/remove]]
async function handleProjects(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  manager: SessionManager,
  pick: () => Promise<string | null>,
): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/projects") return sendJson(res, 200, await manager.describeProjects());
  if (route === "GET /api/projects/limits") return sendJson(res, 200, manager.defaults);
  if (route === "GET /api/projects/branches") return sendJson(res, 200, await manager.branches(manager.project(url.searchParams.get("project"))));
  // Opens the OS folder chooser, then opens the chosen folder as a project.
  if (route === "POST /api/projects/pick") {
    const path = await pick();
    return path === null ? sendJson(res, 200, { cancelled: true }) : sendJson(res, 201, manager.openProject(path));
  }
  const body = await readJson(req);
  if (route === "POST /api/projects/workspaces") {
    const str = (key: string) => (typeof body[key] === "string" && (body[key] as string).trim() ? (body[key] as string).trim() : undefined);
    return sendJson(res, 201, await manager.createWorkspace(manager.project(body.project), { name: str("name"), branch: str("branch"), base: str("base") }));
  }
  if (route === "POST /api/projects/budget") {
    const budgetUsd = capValue(body.budgetUsd, "budgetUsd");
    const workspace = typeof body.workspace === "string" ? body.workspace : undefined;
    return sendJson(res, 200, manager.setBudget(manager.project(body.project).path, budgetUsd, workspace));
  }
  if (route === "POST /api/projects/workspaces/remove") {
    if (typeof body.root !== "string") throw new HttpError(400, '"root" is required');
    return sendJson(res, 200, await manager.removeWorkspace(manager.project(body.project), body.root, body.force === true));
  }
  if (typeof body.path !== "string" || !body.path.trim()) throw new HttpError(400, '"path" is required');
  // Only directories the project list knows about; this endpoint must not open arbitrary paths.
  if (route === "POST /api/projects/reveal") {
    const path = body.path;
    const known = (await manager.describeProjects()).some((p) => p.workspaces.some((w) => w.path === path && !w.missing));
    if (!known) throw new HttpError(404, "not a known workspace");
    await revealInFileManager(path);
    return sendJson(res, 200, { ok: true });
  }
  if (route === "POST /api/projects") return sendJson(res, 201, manager.openProject(body.path));
  if (route === "POST /api/projects/remove") return sendJson(res, 200, { ok: true, removed: manager.projects.remove(body.path) });
  throw new HttpError(404, "not found");
}

// Routes: /api/sessions[/search|/:id[/message|approve|settings|archive|delete|stop|fork|stats|reveal|file|attachment|tool]]
async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, manager: SessionManager, caller: Caller): Promise<void> {
  const [, , , rawId, action] = url.pathname.split("/");
  const method = req.method ?? "GET";
  // Sessions created or forked from the public internet start out asking before each bash command, whatever the
  // global default or the forked session says. A safer default only: the device may still switch a session to auto.
  const startMode = caller.kind === "remote" && caller.via === "public" ? "ask" : undefined;

  if (!rawId) {
    if (method === "GET") return sendJson(res, 200, manager.list());
    if (method === "POST") {
      const body = await readJson(req);
      if (body.approvalMode !== undefined && !isApprovalMode(body.approvalMode)) {
        throw new HttpError(400, '"approvalMode" must be "ask" or "auto"');
      }
      if (typeof body.workspace !== "string" || !body.workspace.trim()) throw new HttpError(400, '"workspace" path is required');
      return sendJson(res, 201, await manager.create(body.workspace, startMode ?? body.approvalMode));
    }
    throw new HttpError(405, "method not allowed");
  }

  if (rawId === "search" && method === "GET") return sendJson(res, 200, manager.search(url.searchParams.get("q") ?? ""));

  const id = sessionId(rawId);
  switch (`${method} ${action ?? ""}`) {
    case "GET ": {
      const info = manager.get(id).info;
      return sendJson(res, 200, { ...info, budget: manager.budgetFor(info) });
    }
    case "GET stats":
      return sendJson(res, 200, manager.stats(id));
    case "GET tool": {
      const call = manager.get(id).toolCall(url.searchParams.get("call") ?? "");
      if (!call) throw new HttpError(404, "tool call not found");
      return sendJson(res, 200, call);
    }
    case "GET file":
      return sendText(res, "text/plain", manager.store.readFile(id, fileName(url.searchParams.get("name"))));
    case "GET attachment": {
      const name = url.searchParams.get("name") ?? "";
      if (!isAttachmentName(name)) throw new HttpError(400, "invalid attachment name");
      const ext = name.split(".").pop();
      const type = Object.keys(IMAGE_TYPES).find((t) => IMAGE_TYPES[t] === ext)!;
      const path = manager.store.attachmentPath(id, name);
      if (!existsSync(path)) throw new HttpError(404, "attachment not found");
      return sendBytes(res, type, readFileSync(path));
    }
    case "POST compact": {
      const body = await readJson(req);
      const runner = manager.get(id);
      let done: Promise<void>;
      try { done = runner.compact(typeof body.focus === "string" ? body.focus.trim() : ""); }
      catch (err) { if (err instanceof SendRejected) throw new HttpError(409, err.message); throw err; }
      done.catch((err: unknown) => process.stderr.write(`session ${id}: ${String(err)}\n`));
      return sendJson(res, 202, { ok: true });
    }
    case "POST message": {
      const body = await readJson(req, MAX_MESSAGE_BODY);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const images = parseImages(body.images);
      if (!text && images.length === 0) throw new HttpError(400, '"text" must be a non-empty string (or attach images)');
      const runner = manager.get(id);
      if (text === "/compact" || text.startsWith("/compact ")) {
        let done: Promise<void>;
        try { done = runner.compact(text.slice("/compact".length).trim()); }
        catch (err) { if (err instanceof SendRejected) throw new HttpError(409, err.message); throw err; }
        done.catch((err: unknown) => process.stderr.write(`session ${id}: ${String(err)}\n`));
        return sendJson(res, 202, { ok: true, compacting: true });
      }
      const saved = images.map((img) => manager.store.saveAttachment(id, img.data, img.mediaType));
      let sent;
      try {
        sent = runner.send(text, saved);
      } catch (err) {
        if (err instanceof SendRejected) throw new HttpError(409, err.message);
        throw err;
      }
      const { queued, done } = sent;
      done.catch((err: unknown) => process.stderr.write(`session ${id}: ${String(err)}\n`));
      return sendJson(res, 202, { ok: true, queued });
    }
    case "POST fork": {
      const body = await readJson(req);
      const nw = body.newWorkspace;
      if (nw !== undefined && (typeof nw !== "object" || nw === null)) throw new HttpError(400, '"newWorkspace" must be an object');
      const name = typeof (nw as { name?: unknown } | undefined)?.name === "string" ? (nw as { name: string }).name : undefined;
      return sendJson(res, 201, await manager.fork(id, nw === undefined ? undefined : { name }, startMode));
    }
    case "POST archive": {
      const body = await readJson(req);
      if (typeof body.archived !== "boolean") throw new HttpError(400, '"archived" (boolean) is required');
      return sendJson(res, 200, manager.setArchived(id, body.archived));
    }
    case "POST delete": {
      manager.remove(id);
      return sendJson(res, 200, { ok: true });
    }
    case "POST stop": {
      return sendJson(res, 200, { ok: true, stopped: manager.get(id).stop() });
    }
    case "POST approve": {
      const body = await readJson(req);
      if (typeof body.id !== "string" || typeof body.allow !== "boolean") {
        throw new HttpError(400, '"id" (string) and "allow" (boolean) are required');
      }
      if (!manager.get(id).approve(body.id, body.allow)) throw new HttpError(404, "no pending approval with that id");
      return sendJson(res, 200, { ok: true });
    }
    // Any of: approvalMode, limits (replaces the session's turn limits), budgetUsd, notifications, model.
    case "POST settings": {
      const body = await readJson(req);
      if (body.approvalMode !== undefined && !isApprovalMode(body.approvalMode)) throw new HttpError(400, '"approvalMode" must be "ask" or "auto"');
      if (body.notifications !== undefined && body.notifications !== null && typeof body.notifications !== "boolean") {
        throw new HttpError(400, '"notifications" must be a boolean or null');
      }
      if (body.model !== undefined && (typeof body.model !== "string" || !body.model.trim())) throw new HttpError(400, '"model" must be a non-empty string');
      const limits = body.limits === undefined ? undefined : parseLimits(body.limits);
      const budgetUsd = body.budgetUsd === undefined ? undefined : capValue(body.budgetUsd, "budgetUsd");
      if (body.approvalMode === undefined && limits === undefined && budgetUsd === undefined && body.notifications === undefined && body.model === undefined) {
        throw new HttpError(400, 'nothing to change: give "approvalMode", "limits", "budgetUsd", "notifications" or "model"');
      }
      const runner = manager.get(id);
      if (body.approvalMode !== undefined) runner.setApprovalMode(body.approvalMode as "ask" | "auto");
      if (limits !== undefined || budgetUsd !== undefined) {
        runner.setLimits({ ...(limits !== undefined ? { limits } : {}), ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
      }
      if (body.notifications !== undefined) runner.setNotifications(body.notifications);
      if (body.model !== undefined) runner.setModel(await manager.validateModel(body.model));
      return sendJson(res, 200, { ...runner.info, budget: manager.budgetFor(runner.info) });
    }
    case "POST reveal": {
      const body = await readJson(req);
      manager.get(id);
      const path = manager.store.filePath(id, fileName(body.name));
      await revealInFileManager(path);
      return sendJson(res, 200, { ok: true, path });
    }
    default:
      throw new HttpError(404, "not found");
  }
}

interface Context {
  manager: SessionManager;
  token: string;
  pick: () => Promise<string | null>;
  remote: RemoteEntries | undefined;
  streams: DeviceStreams;
}

// Things that act on the host's own screen (native dialogs, the file manager) make no sense from another device.
function hostOnly(method: string | undefined, path: string): boolean {
  return method === "POST" && (path === "/api/projects/pick" || path === "/api/projects/reveal" || /^\/api\/sessions\/[^/]+\/reveal$/.test(path));
}

// The host's own pages prove themselves with the startup token; remote devices with the cookie they got by pairing.
function authorized(req: IncomingMessage, url: URL, caller: Caller, token: string): boolean {
  if (caller.kind === "remote") return caller.device !== null;
  // EventSource and plain links can't send headers, so GET requests may carry the token in the query.
  const given = (req.headers["x-agent-token"] as string | undefined) ?? (req.method === "GET" ? url.searchParams.get("token") : null);
  return tokenMatches(token, given);
}

function route(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller, context: Context): Promise<void> | void {
  const { manager, token, pick, remote, streams } = context;
  const asset = req.method === "GET" ? PAGES[url.pathname] : undefined;
  if (asset) return sendText(res, asset[0], asset[1]);

  if (url.pathname === "/api/pair") return handleRemote(req, res, url, caller, remote, streams);
  if (!authorized(req, url, caller, token)) return sendJson(res, 401, { error: caller.kind === "remote" ? "not paired" : "bad token" });
  if (caller.kind === "remote" && hostOnly(req.method, url.pathname)) return sendJson(res, 403, { error: "only available on the host machine" });

  const events = url.pathname.match(/^\/events\/([^/]+)$/);
  if (req.method === "GET" && events) {
    const device = caller.kind === "remote" ? caller.device : null;
    return streamEvents(req, res, manager, sessionId(events[1]), () => (device ? streams.add(device.id, res) : () => {}));
  }
  if (req.method === "GET" && url.pathname === "/events") {
    const device = caller.kind === "remote" ? caller.device : null;
    return streamAllEvents(req, res, manager, () => (device ? streams.add(device.id, res) : () => {}));
  }
  if (url.pathname.startsWith("/api/remote")) return handleRemote(req, res, url, caller, remote, streams);
  if (url.pathname === "/api/models") {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    return manager.listModels().then((models) => sendJson(res, 200, { models }));
  }
  if (url.pathname.startsWith("/api/sessions")) return handleApi(req, res, url, manager, caller);
  if (url.pathname.startsWith("/api/projects")) return handleProjects(req, res, url, manager, pick);
  if (url.pathname === "/api/settings") {
    if (req.method === "GET") return sendJson(res, 200, manager.settings.get());
    if (req.method === "POST") {
      return readJson(req).then(async (body) => {
        if (body.newSessionApproval !== undefined && !isApprovalMode(body.newSessionApproval)) throw new HttpError(400, '"newSessionApproval" must be "ask" or "auto"');
        if (body.defaultModel !== undefined && (typeof body.defaultModel !== "string" || !body.defaultModel.trim())) throw new HttpError(400, '"defaultModel" must be a non-empty string');
        if (body.notifications !== undefined && typeof body.notifications !== "boolean") throw new HttpError(400, '"notifications" must be a boolean');
        if (body.compactionTokens !== undefined && (typeof body.compactionTokens !== "number" || !Number.isInteger(body.compactionTokens) || body.compactionTokens < 0)) throw new HttpError(400, '"compactionTokens" must be an integer >= 0');
        if (body.newSessionApproval === undefined && body.defaultModel === undefined && body.notifications === undefined && body.compactionTokens === undefined) throw new HttpError(400, "nothing to change");
        const defaultModel = body.defaultModel === undefined ? undefined : await manager.validateModel(body.defaultModel);
        sendJson(res, 200, manager.settings.update({
          ...(body.newSessionApproval !== undefined ? { newSessionApproval: body.newSessionApproval } : {}),
          ...(defaultModel !== undefined ? { defaultModel } : {}),
          ...(body.notifications !== undefined ? { notifications: body.notifications } : {}),
          ...(body.compactionTokens !== undefined ? { compactionTokens: body.compactionTokens } : {}),
        }));
      });
    }
  }
  // The iteration log reads this project's own git history (src/gui -> project root).
  if (req.method === "GET" && url.pathname === "/api/iterations") return loadIterations(APP_ROOT).then((d) => sendJson(res, 200, d));
  if (req.method === "GET" && url.pathname === "/api/iterations/commit") {
    return commitDetail(APP_ROOT, url.searchParams.get("sha") ?? "").then((d) => sendJson(res, 200, d));
  }
  return sendJson(res, 404, { error: "not found" });
}

export interface GuiServers {
  // The host's own browser: http://127.0.0.1:<port>, startup token.
  local: Server;
  // One per entry, each only its own proxy connects to (`tailscale serve`, cloudflared). Which listener a
  // request arrived on, not its Host header, decides that it is remote: the proxies pass Host through,
  // so a remote caller could claim "127.0.0.1".
  tailnet: Server | null;
  public: Server | null;
}

function identify(req: IncomingMessage, via: "local" | Entry, remote: RemoteEntries | undefined): Caller | Promise<Caller> {
  if (via === "local") return identifyLocal(req, req.socket.localPort ?? 0);
  return via === "tailnet" ? identifyTailnet(req, remote!) : identifyPublic(req, remote!);
}

export function createGuiServers(manager: SessionManager, token: string, options: GuiOptions = {}): GuiServers {
  const context: Context = {
    manager,
    token,
    pick: folderPicker(options.pickFolder ?? nativePickFolder),
    remote: options.remote,
    streams: new DeviceStreams(),
  };
  const handler = (via: "local" | Entry) => (req: IncomingMessage, res: ServerResponse) => {
    let caller: Caller | undefined;
    if (via !== "local") options.audit?.watch(req, res, via, () => caller);
    const fail = (err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    };
    // Host check blocks DNS rebinding; the token (or device cookie) blocks cross-site requests from other pages.
    Promise.resolve()
      .then(() => identify(req, via, context.remote))
      .then((who) => {
        caller = who;
        return route(req, res, new URL(req.url ?? "/", `http://${req.headers.host}`), who, context);
      })
      .catch(fail);
  };
  const remote = options.remote;
  return {
    local: createServer(handler("local")),
    tailnet: remote?.tailnet ? createServer(handler("tailnet")) : null,
    public: remote?.public ? createServer(handler("public")) : null,
  };
}

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve((server.address() as AddressInfo).port));
  });
}
