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

const HOST = "127.0.0.1";
const APP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const HEARTBEAT_MS = 15_000;
const page = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const PAGES: Record<string, [string, string]> = {
  "/": ["text/html", page("index.html")],
  "/stats": ["text/html", page("stats.html")],
  "/raw": ["text/html", page("raw.html")],
  "/iterations": ["text/html", page("iterations.html")],
  "/common.css": ["text/css", page("common.css")],
  "/common.js": ["text/javascript", page("common.js")],
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

function streamEvents(req: IncomingMessage, res: ServerResponse, manager: SessionManager, id: string): void {
  const runner = manager.get(id);
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(`event: hello\ndata: ${JSON.stringify(runner.info)}\n\n`);
  const unsubscribe = runner.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
  // subscribe() replays history synchronously; tell the client where live events begin.
  res.write("event: replay_done\ndata: {}\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

export interface GuiOptions {
  pickFolder?: PickFolder;
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

// Routes: /api/sessions[/:id[/message|approve|settings|stop|fork|stats|reveal|file|attachment]]
async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, manager: SessionManager): Promise<void> {
  const [, , , rawId, action] = url.pathname.split("/");
  const method = req.method ?? "GET";

  if (!rawId) {
    if (method === "GET") return sendJson(res, 200, manager.list());
    if (method === "POST") {
      const body = await readJson(req);
      if (body.approvalMode !== undefined && !isApprovalMode(body.approvalMode)) {
        throw new HttpError(400, '"approvalMode" must be "ask" or "auto"');
      }
      if (typeof body.workspace !== "string" || !body.workspace.trim()) throw new HttpError(400, '"workspace" path is required');
      return sendJson(res, 201, await manager.create(body.workspace, body.approvalMode));
    }
    throw new HttpError(405, "method not allowed");
  }

  const id = sessionId(rawId);
  switch (`${method} ${action ?? ""}`) {
    case "GET ": {
      const info = manager.get(id).info;
      return sendJson(res, 200, { ...info, budget: manager.budgetFor(info) });
    }
    case "GET stats":
      return sendJson(res, 200, manager.stats(id));
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
    case "POST message": {
      const body = await readJson(req, MAX_MESSAGE_BODY);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const images = parseImages(body.images);
      if (!text && images.length === 0) throw new HttpError(400, '"text" must be a non-empty string (or attach images)');
      const runner = manager.get(id);
      if (images.length > 0 && runner.isBusy) throw new HttpError(409, "agent 正在运行，图片要等这一轮结束（或停止）后再发送");
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
      return sendJson(res, 201, await manager.fork(id, nw === undefined ? undefined : { name }));
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
    // Any of: approvalMode, limits (replaces the session's turn limits), budgetUsd.
    case "POST settings": {
      const body = await readJson(req);
      if (body.approvalMode !== undefined && !isApprovalMode(body.approvalMode)) throw new HttpError(400, '"approvalMode" must be "ask" or "auto"');
      const limits = body.limits === undefined ? undefined : parseLimits(body.limits);
      const budgetUsd = body.budgetUsd === undefined ? undefined : capValue(body.budgetUsd, "budgetUsd");
      if (body.approvalMode === undefined && limits === undefined && budgetUsd === undefined) {
        throw new HttpError(400, 'nothing to change: give "approvalMode", "limits" or "budgetUsd"');
      }
      const runner = manager.get(id);
      if (body.approvalMode !== undefined) runner.setApprovalMode(body.approvalMode as "ask" | "auto");
      if (limits !== undefined || budgetUsd !== undefined) {
        runner.setLimits({ ...(limits !== undefined ? { limits } : {}), ...(budgetUsd !== undefined ? { budgetUsd } : {}) });
      }
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
}

function route(req: IncomingMessage, res: ServerResponse, url: URL, { manager, token, pick }: Context): Promise<void> | void {
  const asset = req.method === "GET" ? PAGES[url.pathname] : undefined;
  if (asset) return sendText(res, asset[0], asset[1]);

  // EventSource and plain links can't send headers, so GET requests may carry the token in the query.
  const given = (req.headers["x-agent-token"] as string | undefined) ?? (req.method === "GET" ? url.searchParams.get("token") : null);
  if (!tokenMatches(token, given)) return sendJson(res, 401, { error: "bad token" });

  const events = url.pathname.match(/^\/events\/([^/]+)$/);
  if (req.method === "GET" && events) return streamEvents(req, res, manager, sessionId(events[1]));
  if (url.pathname.startsWith("/api/sessions")) return handleApi(req, res, url, manager);
  if (url.pathname.startsWith("/api/projects")) return handleProjects(req, res, url, manager, pick);
  // The iteration log reads this project's own git history (src/gui -> project root).
  if (req.method === "GET" && url.pathname === "/api/iterations") return loadIterations(APP_ROOT).then((d) => sendJson(res, 200, d));
  if (req.method === "GET" && url.pathname === "/api/iterations/commit") {
    return commitDetail(APP_ROOT, url.searchParams.get("sha") ?? "").then((d) => sendJson(res, 200, d));
  }
  return sendJson(res, 404, { error: "not found" });
}

export function createGuiServer(manager: SessionManager, token: string, options: GuiOptions = {}): Server {
  const context: Context = { manager, token, pick: folderPicker(options.pickFolder ?? nativePickFolder) };
  const server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port;
    // Host check blocks DNS rebinding; the token blocks cross-site requests from other pages.
    if (req.headers.host !== `${HOST}:${port}` && req.headers.host !== `localhost:${port}`) {
      return sendJson(res, 403, { error: "forbidden host" });
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const fail = (err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    };
    try {
      Promise.resolve(route(req, res, url, context)).catch(fail);
    } catch (err) {
      fail(err);
    }
  });
  return server;
}

export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => resolve((server.address() as AddressInfo).port));
  });
}
