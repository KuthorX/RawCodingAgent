import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isApprovalMode, type ApprovalMode } from "../agent/permissions.ts";
import type { Message } from "../types.ts";
import type { SessionEvent } from "./events.ts";

export interface SessionMeta {
  id: string;
  title: string;
  workspace: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  approvalMode: ApprovalMode;
  // Set on a session created by fork(): where its history came from.
  forkedFrom?: { id: string; turns: number };
}

export const SESSION_FILES = ["meta.json", "messages.json", "events.jsonl", "trace.jsonl"] as const;
export type SessionFile = (typeof SESSION_FILES)[number];

export function isSessionFile(name: string): name is SessionFile {
  return (SESSION_FILES as readonly string[]).includes(name);
}

const ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
const TITLE_CHARS = 60;

export function isSessionId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
}

function newId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// True when a non-empty file doesn't end with a newline (a previous append was cut short).
function endsMidLine(path: string): boolean {
  const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
  if (size === 0) return false;
  const fd = openSync(path, "r");
  try {
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    closeSync(fd);
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

// Write-then-rename so a crash never leaves a half-written file.
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

// One directory per session: meta.json, messages.json, events.jsonl, trace.jsonl.
export class SessionStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  private dir(id: string): string {
    if (!isSessionId(id)) throw new Error(`invalid session id "${id}"`);
    return join(this.root, id);
  }

  filePath(id: string, file: SessionFile): string {
    return join(this.dir(id), file);
  }

  tracePath(id: string): string {
    return this.filePath(id, "trace.jsonl");
  }

  readFile(id: string, file: SessionFile): string {
    const path = this.filePath(id, file);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  exists(id: string): boolean {
    return isSessionId(id) && existsSync(join(this.dir(id), "meta.json"));
  }

  create(workspace: string, model: string, approvalMode: ApprovalMode = "ask", now = new Date()): SessionMeta {
    const iso = now.toISOString();
    const meta: SessionMeta = { id: newId(now), title: "", workspace, model, createdAt: iso, updatedAt: iso, turns: 0, approvalMode };
    mkdirSync(this.dir(meta.id), { recursive: true });
    writeJsonAtomic(join(this.dir(meta.id), "meta.json"), meta);
    writeJsonAtomic(join(this.dir(meta.id), "messages.json"), []);
    return meta;
  }

  // A new session with the source's history (messages + replayable events) up to its last finished turn,
  // so a turn running in another process is left out. The trace starts empty: stats count the fork's own work.
  fork(sourceId: string, now = new Date()): SessionMeta {
    const source = this.getMeta(sourceId);
    const events = this.loadEvents(sourceId);
    const lastEnd = events.findLastIndex((e) => (e.type === "turn_end" || e.type === "error") && !e.continues);
    const kept = events.slice(0, lastEnd + 1);
    const meta: SessionMeta = {
      ...this.create(source.workspace, source.model, source.approvalMode, now),
      title: source.title,
      turns: source.turns,
      forkedFrom: { id: source.id, turns: source.turns },
    };
    writeJsonAtomic(join(this.dir(meta.id), "meta.json"), meta);
    writeJsonAtomic(join(this.dir(meta.id), "messages.json"), this.loadMessages(sourceId));
    const forked: SessionEvent = { type: "forked", from: source.id, fromTitle: source.title, turns: source.turns };
    writeFileSync(join(this.dir(meta.id), "events.jsonl"), [...kept, forked].map((e) => JSON.stringify(e) + "\n").join(""));
    return meta;
  }

  getMeta(id: string): SessionMeta {
    if (!this.exists(id)) throw new Error(`session "${id}" not found`);
    const meta = readJson<SessionMeta>(join(this.dir(id), "meta.json"));
    // Sessions created before approval modes existed default to asking.
    return { ...meta, approvalMode: isApprovalMode(meta.approvalMode) ? meta.approvalMode : "ask" };
  }

  list(): SessionMeta[] {
    return readdirSync(this.root)
      .filter((id) => this.exists(id))
      .map((id) => this.getMeta(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  updateMeta(id: string, patch: Partial<Omit<SessionMeta, "id" | "createdAt">>): SessionMeta {
    const meta = { ...this.getMeta(id), ...patch };
    writeJsonAtomic(join(this.dir(id), "meta.json"), meta);
    return meta;
  }

  loadMessages(id: string): Message[] {
    return readJson<Message[]>(join(this.dir(id), "messages.json"));
  }

  saveMessages(id: string, messages: Message[]): void {
    writeJsonAtomic(join(this.dir(id), "messages.json"), messages);
  }

  appendEvent(id: string, event: SessionEvent): void {
    const path = join(this.dir(id), "events.jsonl");
    // Start on a fresh line so a half-written line can't swallow this event too.
    appendFileSync(path, (endsMidLine(path) ? "\n" : "") + JSON.stringify(event) + "\n");
  }

  loadEvents(id: string): SessionEvent[] {
    const path = join(this.dir(id), "events.jsonl");
    if (!existsSync(path)) return [];
    // A line half-written by a killed process must not make the whole session unreadable.
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        try {
          return line ? [JSON.parse(line) as SessionEvent] : [];
        } catch {
          return [];
        }
      });
  }

  // One process per session (e.g. the GUI and `--resume` must not both write history).
  // A lock left by a dead process is taken over.
  acquireLock(id: string): () => void {
    const path = join(this.dir(id), "lock");
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, "utf8"));
      if (pid !== process.pid && isAlive(pid)) {
        throw new Error(`session "${id}" is open in another process (pid ${pid})`);
      }
    }
    writeFileSync(path, String(process.pid));
    const release = () => rmSync(path, { force: true });
    process.once("exit", release);
    return release;
  }
}
