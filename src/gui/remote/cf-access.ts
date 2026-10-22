import { createPublicKey, verify, type KeyObject, type webcrypto } from "node:crypto";
import { HttpError } from "../http.ts";

// Clock skew allowed on exp / nbf.
const LEEWAY_S = 60;
// An unknown key id refetches the key set at most this often (keys rotate about every 6 weeks).
const REFETCH_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

export interface AccessConfig {
  // e.g. "https://myteam.cloudflareaccess.com": the token's issuer, and where its signing keys are published.
  teamDomain: string;
  // AUD tag of the Access application in front of this app.
  aud: string;
  // Lowercased; the Access policy should already allow only these, this is the second check.
  emails: readonly string[];
}

type JsonWebKey = webcrypto.JsonWebKey;

export type FetchKeys = (url: string) => Promise<{ keys?: (JsonWebKey & { kid?: string })[] }>;

const defaultFetchKeys: FetchKeys = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
};

function decodePart(part: string | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(403, "malformed Access token");
  }
}

// Verifies the Cf-Access-Jwt-Assertion header Cloudflare Access adds to every request it lets through:
// RS256 signature against the team's published keys, issuer, audience, expiry, and an allowed email.
export class AccessVerifier {
  private readonly config: AccessConfig;
  private readonly fetchKeys: FetchKeys;
  private readonly now: () => number;
  private keys = new Map<string, KeyObject>();
  // Last fetch attempt, successful or not: an unreachable key set mustn't be retried on every request.
  private triedAt = 0;
  private pending: Promise<void> | null = null;

  constructor(config: AccessConfig, fetchKeys: FetchKeys = defaultFetchKeys, now: () => number = Date.now) {
    this.config = config;
    this.fetchKeys = fetchKeys;
    this.now = now;
  }

  get certsUrl(): string {
    return `${this.config.teamDomain}/cdn-cgi/access/certs`;
  }

  // Loads the key set; at startup this also proves the team domain is right before anything is served.
  refresh(): Promise<void> {
    this.triedAt = this.now();
    this.pending ??= this.fetchKeys(this.certsUrl)
      .then(({ keys }) => {
        const next = new Map<string, KeyObject>();
        for (const jwk of keys ?? []) {
          if (!jwk.kid || jwk.kty !== "RSA") continue;
          // One malformed key must not take the good ones down with it.
          try {
            next.set(jwk.kid, createPublicKey({ key: jwk, format: "jwk" }));
          } catch (err) {
            process.stderr.write(`skipping Access key ${jwk.kid}: ${(err as Error).message}\n`);
          }
        }
        if (next.size === 0) throw new Error(`${this.certsUrl} has no RSA keys`);
        this.keys = next;
      })
      .finally(() => (this.pending = null));
    return this.pending;
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    // A key Cloudflare rotated in less than REFETCH_MS after our last fetch is refused until then (403).
    if (!this.keys.has(kid) && this.now() - this.triedAt >= REFETCH_MS) {
      await this.refresh().catch((err: unknown) => {
        throw new HttpError(503, `could not load Access signing keys: ${(err as Error).message}`);
      });
    }
    const key = this.keys.get(kid);
    if (!key) throw new HttpError(403, "Access token signed with an unknown key");
    return key;
  }

  async verify(token: string | undefined): Promise<{ email: string }> {
    if (!token) throw new HttpError(403, "missing Access token (is this hostname behind Cloudflare Access?)");
    const [head, body, signature] = token.split(".");
    if (signature === undefined || token.split(".").length !== 3) throw new HttpError(403, "malformed Access token");
    const header = decodePart(head);
    // Only what Access issues: an attacker must not pick "none" or an HMAC with the public key as secret.
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new HttpError(403, "unexpected Access token algorithm");
    const key = await this.keyFor(header.kid);
    if (!verify("RSA-SHA256", Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url"))) {
      throw new HttpError(403, "bad Access token signature");
    }
    const claims = decodePart(body);
    const nowS = this.now() / 1000;
    if (claims.iss !== this.config.teamDomain) throw new HttpError(403, "Access token from another team");
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(this.config.aud)) throw new HttpError(403, "Access token for another application");
    if (typeof claims.exp !== "number" || claims.exp + LEEWAY_S < nowS) throw new HttpError(403, "Access token expired");
    if (typeof claims.nbf === "number" && claims.nbf - LEEWAY_S > nowS) throw new HttpError(403, "Access token not valid yet");
    const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
    if (!this.config.emails.includes(email)) throw new HttpError(403, "this account is not allowed");
    return { email };
  }
}

// From .env: CF_ACCESS_TEAM_DOMAIN (team name or URL), CF_ACCESS_AUD, PUBLIC_ALLOWED_EMAILS (comma separated).
export function accessConfigFromEnv(env: NodeJS.ProcessEnv): AccessConfig {
  const team = env.CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.CF_ACCESS_AUD?.trim();
  const emails = (env.PUBLIC_ALLOWED_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const missing = [!team && "CF_ACCESS_TEAM_DOMAIN", !aud && "CF_ACCESS_AUD", !emails.length && "PUBLIC_ALLOWED_EMAILS"].filter(Boolean);
  if (missing.length) throw new Error(`--public needs ${missing.join(", ")} in .env (see README: 从公网访问)`);
  const teamDomain = new URL(/^https?:\/\//.test(team!) ? team! : `https://${team}.cloudflareaccess.com`).origin;
  // The signing keys come from here: over plain HTTP anyone on the path could swap in their own.
  if (!teamDomain.startsWith("https://")) throw new Error(`CF_ACCESS_TEAM_DOMAIN must be https://, got ${team}`);
  return { teamDomain, aud: aud!, emails };
}
