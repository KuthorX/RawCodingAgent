import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

export type SpanKind = "turn" | "llm" | "tool";
export type SpanStatus = "ok" | "error";
export type Attrs = Record<string, unknown>;

// One line in the JSONL trace, written when the span ends.
export interface SpanRecord {
  type: "span";
  id: string;
  parentId: string | null;
  kind: SpanKind;
  name: string;
  start: string;
  durationMs: number;
  status: SpanStatus;
  attrs: Attrs;
}

export interface Span {
  readonly id: string;
  end(attrs?: Attrs, status?: SpanStatus): void;
}

export interface Tracer {
  readonly path: string | undefined;
  // Free-form event (raw requests/responses), for reading what the model actually saw.
  log(event: string, data: unknown): void;
  startSpan(kind: SpanKind, name: string, parentId: string | null, attrs?: Attrs): Span;
}

// Traces are copied into the GUI, stats pages and bug reports, so credentials that pass through a tool call
// (a key echoed by `env`, a `.env` read, an Authorization header) must not land there verbatim. This is a
// best-effort scrubber for well-known token shapes, not a data-loss-prevention system.
const SECRET_RULES: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "sk-[REDACTED]"],
  [/\btvly-[A-Za-z0-9_-]{10,}/g, "tvly-[REDACTED]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, "[REDACTED GITHUB TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "xox[REDACTED]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza[REDACTED]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED JWT]"],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi, "$1 [REDACTED]"],
  [/(-----BEGIN [A-Z ]*PRIVATE KEY-----)[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----)/g, "$1 [REDACTED] $2"],
  // .env-style lines: a name that says key/token/secret/password, then anything.
  [/^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*).+$/gim, "$1[REDACTED]"],
  // JSON-ish fields: "apiKey": "...", "password": "...".
  [/(["']?(?:api[_-]?key|access[_-]?token|secret|password|passwd)["']?\s*:\s*["'])[^"']{8,}(["'])/gi, "$1[REDACTED]$2"],
];

export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_RULES) out = out.replace(pattern, replacement);
  return out;
}

function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (depth >= 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) out[key] = redactValue(v, depth + 1);
  return out;
}

export function redactRecord(record: unknown): unknown {
  return redactValue(record);
}

function spanFactory(write: (record: SpanRecord) => void): Tracer["startSpan"] {
  return (kind, name, parentId, attrs = {}) => {
    const id = randomUUID();
    const start = new Date().toISOString();
    const t0 = performance.now();
    let ended = false;
    return {
      id,
      end(endAttrs = {}, status = "ok") {
        if (ended) return;
        ended = true;
        const durationMs = Math.round(performance.now() - t0);
        write({ type: "span", id, parentId, kind, name, start, durationMs, status, attrs: { ...attrs, ...endAttrs } });
      },
    };
  };
}

// Appends to one JSONL file per session.
export function createTracer(path: string): Tracer {
  mkdirSync(dirname(path), { recursive: true });
  const append = (record: unknown) => appendFileSync(path, JSON.stringify(redactRecord(record)) + "\n");
  return {
    path,
    log(event, data) {
      append({ type: "event", ts: new Date().toISOString(), event, data });
    },
    startSpan: spanFactory(append),
  };
}

// Collects spans in memory; used by tests.
export function createMemoryTracer(): Tracer & { spans: SpanRecord[] } {
  const spans: SpanRecord[] = [];
  return { path: undefined, spans, log() {}, startSpan: spanFactory((r) => spans.push(r)) };
}

export const nullTracer: Tracer = {
  path: undefined,
  log() {},
  startSpan: spanFactory(() => {}),
};
