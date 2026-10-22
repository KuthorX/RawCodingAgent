import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { HttpError } from "../http.ts";
import type { Entry } from "./access.ts";

export const PAIRING_TTL_MS = 5 * 60_000;
// Failed pairing attempts allowed per window before every attempt is refused until the window ends. Codes are
// 128-bit, so this is a brake on hammering, kept short so it can't lock the owner out for long.
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
// lastSeenAt is written to disk at most this often per device.
const SEEN_PERSIST_MS = 10 * 60_000;
const MAX_NAME = 60;

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  // Which entry it paired through (absent for devices paired before there was more than one).
  via?: Entry;
}

interface StoredDevice extends Device {
  // sha256 of the device token; the token itself only ever lives in the device's cookie.
  tokenHash: string;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
  // Only redeemable through this entry (the one whose link was shown).
  via?: Entry;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const sameCode = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

// Devices paired for remote access (.devices.json) plus the one-time pairing codes shown on the host (memory only).
// Another GUI instance may share the file, so it is re-read whenever it changed on disk.
export class DeviceStore {
  private readonly file: string;
  private readonly now: () => number;
  private devices: StoredDevice[] = [];
  private loadedVersion: string | null = null;
  private codes: PairingCode[] = [];
  private failures: number[] = [];
  private readonly persistedSeen = new Map<string, number>();

  constructor(file: string, now: () => number = Date.now) {
    this.file = file;
    this.now = now;
    this.sync();
  }

  list(): Device[] {
    this.sync();
    return this.devices.map(({ tokenHash: _, ...device }) => device);
  }

  createPairingCode(via?: Entry): PairingCode {
    const code = { code: randomBytes(16).toString("base64url"), expiresAt: this.now() + PAIRING_TTL_MS, ...(via ? { via } : {}) };
    this.codes = [...this.codes.filter((c) => c.expiresAt > this.now()), code];
    return code;
  }

  // Trades a pairing code (single use) for a new device and its token.
  redeem(code: unknown, name: unknown, via?: Entry): { device: Device; token: string } {
    const now = this.now();
    this.failures = this.failures.filter((t) => t > now - FAILURE_WINDOW_MS);
    if (this.failures.length >= MAX_FAILURES) throw new HttpError(429, "too many failed pairing attempts; try again later");
    const match = typeof code === "string" ? this.codes.find((c) => c.expiresAt > now && (!c.via || c.via === via) && sameCode(c.code, code)) : undefined;
    if (!match) {
      this.failures = [...this.failures, now];
      throw new HttpError(403, "pairing code is wrong or expired; create a new one on the host");
    }
    this.codes = this.codes.filter((c) => c !== match);
    const token = randomBytes(32).toString("base64url");
    const at = new Date(now).toISOString();
    const label = typeof name === "string" && name.trim() ? name.trim().slice(0, MAX_NAME) : "未命名设备";
    const stored: StoredDevice = { id: randomBytes(6).toString("hex"), name: label, createdAt: at, lastSeenAt: at, ...(via ? { via } : {}), tokenHash: hash(token) };
    this.sync();
    this.devices = [...this.devices, stored];
    this.save();
    const { tokenHash: _, ...device } = stored;
    return { device, token };
  }

  // The device a token belongs to, or null. Hash lookup, so no timing-sensitive comparison of the token itself.
  authenticate(token: string | undefined): Device | null {
    if (!token) return null;
    this.sync();
    const tokenHash = hash(token);
    const found = this.devices.find((d) => d.tokenHash === tokenHash);
    if (!found) return null;
    const now = this.now();
    const seen = { ...found, lastSeenAt: new Date(now).toISOString() };
    this.devices = this.devices.map((d) => (d === found ? seen : d));
    if (now - (this.persistedSeen.get(found.id) ?? 0) >= SEEN_PERSIST_MS) {
      this.persistedSeen.set(found.id, now);
      // Only a timestamp: a failed write must not turn every remote request into an error.
      try {
        this.save();
      } catch (err) {
        process.stderr.write(`could not record device activity in ${this.file}: ${(err as Error).message}\n`);
      }
    }
    const { tokenHash: _, ...device } = seen;
    return device;
  }

  revoke(id: unknown): boolean {
    this.sync();
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => d.id !== id);
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  private sync(): void {
    const version = this.version();
    if (version === this.loadedVersion) return;
    const devices = version ? this.load() : [];
    // null: a passing read error; keep what is in memory and try again next time.
    if (devices === null) return;
    this.devices = devices;
    this.loadedVersion = version;
  }

  // mtime alone can miss a write by another instance within the same millisecond.
  private version(): string {
    if (!existsSync(this.file)) return "";
    const { mtimeMs, size, ino } = statSync(this.file);
    return `${mtimeMs}:${size}:${ino}`;
  }

  // A file that isn't a device list is set aside (not overwritten by the next save), so no device is lost silently.
  private load(): StoredDevice[] | null {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      process.stderr.write(`could not read ${this.file}: ${(err as Error).message}\n`);
      return null;
    }
    try {
      const saved = JSON.parse(text) as unknown;
      if (!Array.isArray(saved)) throw new Error("not a list");
      return saved.filter((d): d is StoredDevice => typeof d?.id === "string" && typeof d?.tokenHash === "string");
    } catch (err) {
      const aside = `${this.file}.bad`;
      try {
        renameSync(this.file, aside);
        process.stderr.write(`${this.file} is not a device list (${(err as Error).message}); moved to ${aside}, devices need pairing again\n`);
        return [];
      } catch (renameErr) {
        process.stderr.write(`${this.file} is not a device list and could not be moved aside: ${(renameErr as Error).message}\n`);
        return null;
      }
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.devices, null, 2), { mode: 0o600 });
    // Version of what we wrote, taken before the rename, so another instance's later write still counts as new.
    const { mtimeMs, size, ino } = statSync(tmp);
    renameSync(tmp, this.file);
    this.loadedVersion = `${mtimeMs}:${size}:${ino}`;
  }
}
