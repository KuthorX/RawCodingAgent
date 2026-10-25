import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { PROVIDERS, type ProviderId } from "./catalog.ts";

export interface ProviderSummary {
  id: ProviderId;
  name: string;
  configured: boolean;
  keyMask: string;
  baseURL: string;
  source: "environment" | "local";
  defaultModel: string;
}

export interface ProviderCredentials {
  id: ProviderId;
  apiKey: string;
  baseURL?: string;
}

export interface ProviderPatch {
  apiKey?: string | null;
  baseURL?: string | null;
}

interface LegacyConfig { apiKey?: string; baseURL?: string; model?: string }
type SavedProviders = Partial<Record<ProviderId, ProviderPatch>>;

function provider(id: string) {
  const found = PROVIDERS.find((entry) => entry.id === id);
  if (!found) throw new Error("Unknown provider");
  return found;
}

function baseURL(value: string): string {
  try {
    const text = value.trim();
    const url = new URL(text);
    const authority = text.match(/^[a-z]+:\/\/([^/?#]*)/i)?.[1];
    if (!text || !["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || authority?.includes("@") || text.includes("?") || text.includes("#")) {
      throw new Error();
    }
    return url.href;
  } catch {
    throw new Error("Provider base URL must be HTTP(S), without credentials, query or fragment");
  }
}

function key(value: string): string {
  const trimmed = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error("Provider API key contains invalid characters");
  return trimmed;
}

function mask(value: string): string {
  if (!value) return "";
  return value.length <= 8 ? "••••••••" : `••••${value.slice(-4)}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Secrets are available only through get(); UI-facing methods return a deliberately separate DTO.
export class ProviderStore {
  private readonly file: string;
  private readonly legacy: LegacyConfig;

  constructor(file: string, legacy: LegacyConfig = {}) {
    this.file = resolve(file);
    this.legacy = {
      apiKey: legacy.apiKey ? key(legacy.apiKey) : undefined,
      baseURL: legacy.baseURL ? baseURL(legacy.baseURL) : undefined,
      model: legacy.model,
    };
  }

  list(): ProviderSummary[] {
    const saved = this.read();
    return PROVIDERS.map(({ id }) => this.summary(id, saved));
  }

  get(id: string): ProviderCredentials {
    return this.credentials(provider(id).id, this.read());
  }

  update(id: string, patch: ProviderPatch): ProviderSummary {
    const selected = provider(id).id;
    if (!record(patch) || Object.keys(patch).some((name) => name !== "apiKey" && name !== "baseURL")) throw new Error("Invalid provider settings");
    const saved = this.read();
    const previous = saved[selected] ?? {};
    const next = { ...previous };
    if (patch.apiKey !== undefined) {
      if (patch.apiKey !== null && typeof patch.apiKey !== "string") throw new Error("Provider API key must be text or null");
      const value = patch.apiKey === null ? null : key(patch.apiKey);
      if (value !== "") next.apiKey = value;
    }
    if (patch.baseURL !== undefined) {
      if (patch.baseURL !== null && typeof patch.baseURL !== "string") throw new Error("Provider base URL must be text or null");
      next.baseURL = patch.baseURL === null ? null : baseURL(patch.baseURL);
    }
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      saved[selected] = next;
      this.write(saved);
    }
    return this.summary(selected, saved);
  }

  private credentials(id: ProviderId, saved: SavedProviders): ProviderCredentials {
    const selected = provider(id);
    const local = saved[id] ?? {};
    const inherited = id === "legacy" ? this.legacy : {};
    // null is a persisted deletion, not permission to fall back to an environment key.
    const apiKey = Object.hasOwn(local, "apiKey") ? local.apiKey ?? "" : inherited.apiKey ?? "";
    const defaultURL = "defaultBaseURL" in selected ? selected.defaultBaseURL : undefined;
    const url = Object.hasOwn(local, "baseURL") ? local.baseURL ?? defaultURL : inherited.baseURL ?? defaultURL;
    return { id, apiKey, ...(url ? { baseURL: url } : {}) };
  }

  private summary(id: ProviderId, saved: SavedProviders): ProviderSummary {
    const selected = provider(id);
    const credentials = this.credentials(id, saved);
    return {
      id, name: selected.name, configured: Boolean(credentials.apiKey), keyMask: mask(credentials.apiKey),
      baseURL: credentials.baseURL ?? "",
      source: id === "legacy" && !Object.hasOwn(saved[id] ?? {}, "apiKey") ? "environment" : "local",
      defaultModel: id === "legacy" && this.legacy.model ? this.legacy.model : selected.defaultModel,
    };
  }

  private read(): SavedProviders {
    let text: string;
    try {
      if (!lstatSync(this.file).isFile()) throw new Error();
      text = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Cannot read provider credential file");
    }
    try {
      const raw: unknown = JSON.parse(text);
      if (!record(raw)) throw new Error();
      const saved: SavedProviders = {};
      for (const [id, value] of Object.entries(raw)) {
        const selected = provider(id).id;
        if (!record(value) || Object.keys(value).some((name) => name !== "apiKey" && name !== "baseURL")) throw new Error();
        const parsed: ProviderPatch = {};
        if (Object.hasOwn(value, "apiKey")) {
          if (value.apiKey !== null && (typeof value.apiKey !== "string" || !key(value.apiKey))) throw new Error();
          parsed.apiKey = value.apiKey === null ? null : key(value.apiKey as string);
        }
        if (Object.hasOwn(value, "baseURL")) {
          if (value.baseURL !== null && typeof value.baseURL !== "string") throw new Error();
          parsed.baseURL = value.baseURL === null ? null : baseURL(value.baseURL as string);
        }
        saved[selected] = parsed;
      }
      return saved;
    } catch {
      throw new Error("Provider credential file is invalid; repair it before updating settings");
    }
  }

  private write(saved: SavedProviders): void {
    const directory = dirname(this.file);
    const temporary = join(directory, `.${basename(this.file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let descriptor: number | undefined;
    try {
      if (mkdirSync(directory, { recursive: true, mode: 0o700 })) chmodSync(directory, 0o700);
      descriptor = openSync(temporary, "wx", 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, JSON.stringify(saved, null, 2) + "\n");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.file);
    } catch {
      throw new Error("Could not save provider credentials");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* absent after a successful rename */ }
    }
  }
}
