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
  const append = (record: unknown) => appendFileSync(path, JSON.stringify(record) + "\n");
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
