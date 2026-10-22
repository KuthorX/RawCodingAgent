import { appendFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Caller, Entry } from "./access.ts";

export interface AuditRecord {
  at: string;
  via: Entry;
  // Tailnet login or Access email; absent when the request was refused before we knew.
  who?: string;
  device?: { id: string; name: string };
  method: string;
  path: string;
  status: number;
  // The client went away before the response was complete (e.g. an upload cut off midway).
  aborted?: true;
}

// What other devices did (.audit.jsonl, one JSON object per line): every request that changes something,
// and every refused one. Reads (pages, lists, the event stream) aren't logged.
export class AuditLog {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  // Called when a request on a remote listener arrives; writes once the response is done or abandoned
  // ("close" fires either way, "finish" only for a complete response).
  watch(req: IncomingMessage, res: ServerResponse, via: Entry, caller: () => Caller | undefined): void {
    res.once("close", () => {
      const read = req.method === "GET" || req.method === "HEAD";
      if (read && res.statusCode < 400) return;
      const c = caller();
      const remote = c?.kind === "remote" ? c : undefined;
      this.write({
        at: new Date().toISOString(),
        via,
        ...(remote ? { who: remote.who } : {}),
        ...(remote?.device ? { device: { id: remote.device.id, name: remote.device.name } } : {}),
        method: req.method ?? "",
        // Without the query: GET links may carry the token there.
        path: (req.url ?? "").split("?")[0]!,
        status: res.statusCode,
        ...(res.writableFinished ? {} : { aborted: true as const }),
      });
    });
  }

  private write(record: AuditRecord): void {
    try {
      appendFileSync(this.file, JSON.stringify(record) + "\n", { mode: 0o600 });
    } catch (err) {
      process.stderr.write(`could not write ${this.file}: ${(err as Error).message}\n`);
    }
  }
}
