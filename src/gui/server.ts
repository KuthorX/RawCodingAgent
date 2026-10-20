import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { isApprovalMode } from "../agent/permissions.ts";
import { isSessionFile, isSessionId } from "../session/store.ts";
import { HttpError, readJson, sendJson, sendText, tokenMatches } from "./http.ts";
import type { SessionManager } from "./manager.ts";
import { revealInFileManager } from "./reveal.ts";

const HOST = "127.0.0.1";
const HEARTBEAT_MS = 15_000;
const page = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const PAGES: Record<string, [string, string]> = {
  "/": ["text/html", page("index.html")],
  "/stats": ["text/html", page("stats.html")],
  "/raw": ["text/html", page("raw.html")],
  "/common.css": ["text/css", page("common.css")],
  "/common.js": ["text/javascript", page("common.js")],
};

function sessionId(raw: string | undefined): string {
  if (!raw || !isSessionId(raw)) throw new HttpError(400, "invalid session id");
  return raw;
}

function fileName(raw: unknown) {
  if (typeof raw !== "string" || !isSessionFile(raw)) throw new HttpError(400, "unknown session file");
  return raw;
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

// Routes: /api/workspaces[/remove]
async function handleWorkspaces(req: IncomingMessage, res: ServerResponse, url: URL, manager: SessionManager): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  if (route === "GET /api/workspaces") {
    const sessions = manager.store.list();
    return sendJson(
      res,
      200,
      manager.workspaces.list().map((w) => ({ ...w, sessions: sessions.filter((s) => s.workspace === w.path).length })),
    );
  }
  const body = await readJson(req);
  if (typeof body.path !== "string" || !body.path.trim()) throw new HttpError(400, '"path" is required');
  if (route === "POST /api/workspaces") return sendJson(res, 201, manager.openWorkspace(body.path));
  if (route === "POST /api/workspaces/remove") return sendJson(res, 200, { ok: true, removed: manager.workspaces.remove(body.path) });
  throw new HttpError(404, "not found");
}

// Routes: /api/sessions[/:id[/message|approve|settings|stop|stats|reveal|file]]
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
      return sendJson(res, 201, manager.create(body.workspace, body.approvalMode));
    }
    throw new HttpError(405, "method not allowed");
  }

  const id = sessionId(rawId);
  switch (`${method} ${action ?? ""}`) {
    case "GET ":
      return sendJson(res, 200, manager.get(id).info);
    case "GET stats":
      return sendJson(res, 200, manager.stats(id));
    case "GET file":
      return sendText(res, "text/plain", manager.store.readFile(id, fileName(url.searchParams.get("name"))));
    case "POST message": {
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) throw new HttpError(400, '"text" must be a non-empty string');
      const { queued, done } = manager.get(id).send(text);
      done.catch((err: unknown) => process.stderr.write(`session ${id}: ${String(err)}\n`));
      return sendJson(res, 202, { ok: true, queued });
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
    case "POST settings": {
      const body = await readJson(req);
      if (!isApprovalMode(body.approvalMode)) throw new HttpError(400, '"approvalMode" must be "ask" or "auto"');
      const runner = manager.get(id);
      runner.setApprovalMode(body.approvalMode);
      return sendJson(res, 200, runner.info);
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

function route(req: IncomingMessage, res: ServerResponse, url: URL, manager: SessionManager, token: string): Promise<void> | void {
  const asset = req.method === "GET" ? PAGES[url.pathname] : undefined;
  if (asset) return sendText(res, asset[0], asset[1]);

  // EventSource and plain links can't send headers, so GET requests may carry the token in the query.
  const given = (req.headers["x-agent-token"] as string | undefined) ?? (req.method === "GET" ? url.searchParams.get("token") : null);
  if (!tokenMatches(token, given)) return sendJson(res, 401, { error: "bad token" });

  const events = url.pathname.match(/^\/events\/([^/]+)$/);
  if (req.method === "GET" && events) return streamEvents(req, res, manager, sessionId(events[1]));
  if (url.pathname.startsWith("/api/sessions")) return handleApi(req, res, url, manager);
  if (url.pathname.startsWith("/api/workspaces")) return handleWorkspaces(req, res, url, manager);
  return sendJson(res, 404, { error: "not found" });
}

export function createGuiServer(manager: SessionManager, token: string): Server {
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
      Promise.resolve(route(req, res, url, manager, token)).catch(fail);
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
