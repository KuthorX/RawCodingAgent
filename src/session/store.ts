import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isApprovalMode, type ApprovalMode } from "../agent/permissions.ts";
import type { ImageAttachment, Message } from "../types.ts";
import type { SessionEvent } from "./events.ts";
import type { PlanItem } from "../tools/plan.ts";
import type { VerificationState } from "../agent/verification.ts";
import type { ThinkEffort } from "../providers/catalog.ts";
import type { LoadedSkill } from "../agent/skills.ts";

export interface SessionMeta {
  id: string;
  title: string;
  workspace: string;
  model: string;
  provider?: string;
  thinkEffort?: ThinkEffort;
  createdAt: string;
  updatedAt: string;
  turns: number;
  approvalMode: ApprovalMode;
  notifications?: boolean;
  // Set on a session created by fork(): where its history came from.
  forkedFrom?: { id: string; turns: number };
  // This session's turn guards. A missing key follows the global default (.env), null means no limit.
  limits?: TurnLimits;
  // Cap on everything this session spends, across turns; missing/null = no cap.
  budgetUsd?: number | null;
  // Hidden from the sidebar's project tree (still searchable, can be restored).
  archived?: boolean;
  plan?: PlanItem[];
  verification?: VerificationState;
  // Snapshots keep explicitly selected instructions stable across restart and compaction.
  skills?: LoadedSkill[];
}

export interface TurnLimits {
  maxSteps?: number | null;
  maxTurnCostUsd?: number | null;
}

export const SESSION_FILES = ["meta.json", "messages.json", "events.jsonl", "trace.jsonl"] as const;
export type SessionFile = (typeof SESSION_FILES)[number];

export function isSessionFile(name: string): name is SessionFile {
  return (SESSION_FILES as readonly string[]).includes(name);
}

const ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-f0-9]{6}$/;
const TITLE_CHARS = 60;

// Pasted images, kept in <session>/attachments/ and referenced from messages and events by file name.
export const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const ATTACHMENT_PATTERN = /^[0-9]+-[a-f0-9]{6}\.(png|jpg|gif|webp)$/;

export function isAttachmentName(name: string): boolean {
  return ATTACHMENT_PATTERN.test(name);
}

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

// Keep one process exit hook for all session locks. The GUI can open many sessions at once
// (for example through its notification stream); one exit listener per session trips Node's
// MaxListenersExceededWarning and leaves the browser fighting the connection limit.
const activeLockReleases = new Set<() => void>();
let lockExitHookInstalled = false;

function releaseLocksOnExit(): void {
  for (const release of [...activeLockReleases]) release();
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

  saveAttachment(id: string, data: Buffer, mediaType: string): ImageAttachment & { name: string } {
    const ext = IMAGE_TYPES[mediaType];
    if (!ext) throw new Error(`unsupported image type "${mediaType}"`);
    const dir = join(this.dir(id), "attachments");
    mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomBytes(3).toString("hex")}.${ext}`;
    writeFileSync(join(dir, name), data);
    return { name, path: join(dir, name), mediaType };
  }

  attachmentPath(id: string, name: string): string {
    if (!isAttachmentName(name)) throw new Error(`invalid attachment name "${name}"`);
    return join(this.dir(id), "attachments", name);
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
  // `workspace`: continue in another directory (a new worktree); default: the source's own workspace.
  // `approvalMode`: default: the source's.
  fork(sourceId: string, options: { workspace?: string; approvalMode?: ApprovalMode; now?: Date } = {}): SessionMeta {
    const now = options.now ?? new Date();
    const source = this.getMeta(sourceId);
    const events = this.loadEvents(sourceId);
    const lastEnd = events.findLastIndex((e) => (e.type === "turn_end" || e.type === "error") && !e.continues);
    const kept = events.slice(0, lastEnd + 1);
    const meta: SessionMeta = {
      ...this.create(options.workspace ?? source.workspace, source.model, options.approvalMode ?? source.approvalMode, now),
      title: source.title,
      ...(source.skills ? { skills: source.skills } : {}),
      ...(source.provider !== undefined ? { provider: source.provider } : {}),
      ...(source.thinkEffort !== undefined ? { thinkEffort: source.thinkEffort } : {}),
      turns: source.turns,
      ...(source.notifications !== undefined ? { notifications: source.notifications } : {}),
      ...(source.plan ? { plan: source.plan } : {}),
      ...(source.verification ? { verification: options.workspace && options.workspace !== source.workspace
        ? { ...source.verification, checked: undefined } : source.verification } : {}),
      forkedFrom: { id: source.id, turns: source.turns },
    };
    writeJsonAtomic(join(this.dir(meta.id), "meta.json"), meta);
    // Images are copied too, and messages point at the copies, so each session owns its files.
    const attachments = join(this.dir(sourceId), "attachments");
    if (existsSync(attachments)) cpSync(attachments, join(this.dir(meta.id), "attachments"), { recursive: true });
    const messages = this.loadMessages(sourceId).map((m) =>
      m.role === "user" && m.images
        ? { ...m, images: m.images.map((img) => ({ ...img, path: img.path.startsWith(attachments) ? join(this.dir(meta.id), "attachments", img.path.slice(attachments.length + 1)) : img.path })) }
        : m,
    );
    writeJsonAtomic(join(this.dir(meta.id), "messages.json"), messages);
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

  // Refuses while another process holds the session (its lock is alive); our own runner must be closed first.
  remove(id: string): void {
    if (!this.exists(id)) throw new Error(`session "${id}" not found`);
    const release = this.acquireLock(id);
    release();
    rmSync(this.dir(id), { recursive: true, force: true });
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

  // The text a person would search for: user messages and the assistant's replies, not tool calls or output.
  // Lines are filtered by prefix before parsing, so big tool results are never parsed.
  readDialogue(id: string): { role: "user" | "assistant"; text: string }[] {
    const path = join(this.dir(id), "events.jsonl");
    if (!existsSync(path)) return [];
    const out: { role: "user" | "assistant"; text: string }[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const user = line.startsWith('{"type":"user"');
      if (!user && !line.startsWith('{"type":"assistant_text"')) continue;
      try {
        const e = JSON.parse(line) as { text?: unknown };
        if (typeof e.text === "string" && e.text) out.push({ role: user ? "user" : "assistant", text: e.text });
      } catch {
        // a half-written line
      }
    }
    return out;
  }

  // One process per session (e.g. the GUI and `--resume` must not both write history).
  // A lock left by a dead process is taken over.
  acquireLock(id: string): () => void {
    const path = join(this.dir(id), "lock");
    for (;;) {
      try {
        const fd = openSync(path, "wx");
        try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        let pid: number;
        try { pid = Number(readFileSync(path, "utf8")); } catch { continue; }
        if (pid !== process.pid && isAlive(pid)) {
          throw new Error(`session "${id}" is open in another process (pid ${pid})`);
        }
        // Acquisition is atomic for live locks. A dead lock can be taken over; retry if another process wins
        // the replacement race.
        try { unlinkSync(path); } catch { /* another owner may have replaced it */ }
      }
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try { unlinkSync(path); } catch { /* already removed by recovery */ }
      activeLockReleases.delete(release);
    };
    activeLockReleases.add(release);
    if (!lockExitHookInstalled) {
      lockExitHookInstalled = true;
      process.once("exit", releaseLocksOnExit);
    }
    return release;
  }
}
