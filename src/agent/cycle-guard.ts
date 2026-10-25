import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { ToolCall, ToolResult } from "../types.ts";
import { callSignature } from "./limits.ts";

const MAX_PERIOD = 6;
const REPETITIONS = 3;
const HISTORY_SIZE = MAX_PERIOD * REPETITIONS;

// Only runner timing decorations are normalized. Assertion values, paths and other numbers remain evidence.
export function observationHash(tool: string, output: string): string {
  let stable = output;
  if (tool === "bash" || tool === "verify_changes") {
    stable = stripVTControlCharacters(output)
      .replace(/^([ \t]*(?:#|ℹ)[ \t]*duration_ms[ \t]+)\d+(?:\.\d+)?[ \t]*$/gm, "$1<time>")
      .replace(/^(  duration_ms:[ \t]*)\d+(?:\.\d+)?[ \t]*$/gm, "$1<time>")
      .replace(/^([ \t]*[✔✖✓×].*?)[ \t]+\(\d+(?:\.\d+)?[ \t]*ms\)[ \t]*$/gm, "$1 (<time>)")
      .replace(/^(=+ .+?) in \d+(?:\.\d+)?s( =+)$/gm, "$1 in <time>$2");
  }
  return createHash("sha256").update(stable).digest("hex");
}

interface Observation { call: string; result: string }
export interface CycleDecision { kind: "warning" | "stop"; period: number }

export class CycleGuard {
  private history: Observation[] = [];
  private warned: { known: Set<string>; period: number; repeats: number } | null = null;

  reset(): void {
    this.history = [];
    this.warned = null;
  }

  observe(call: ToolCall, result: ToolResult): void {
    // Updating a checklist is neither new evidence nor a reason to forget a repeated diagnostic loop.
    if (call.name === "plan") {
      if (this.warned) this.warned.repeats++;
      return;
    }
    const signature = createHash("sha256").update(callSignature(call)).digest("hex");
    const output = `${result.isError}:${result.observationHash ?? observationHash(call.name, result.content)}`;
    const observation = { call: signature, result: output };
    const previous = this.history.findLast((entry) => entry.call === signature);
    if (previous && previous.result !== output) this.reset();
    const key = `${signature}:${output}`;
    if (this.warned) {
      if (this.warned.known.has(key)) this.warned.repeats++;
      else this.reset();
    }
    this.history = [...this.history, observation].slice(-HISTORY_SIZE);
  }

  // Evaluate between complete model/tool batches, so a later edit in the same batch can establish progress.
  evaluate(): CycleDecision | null {
    if (this.warned) return this.warned.repeats >= this.warned.period ? { kind: "stop", period: this.warned.period } : null;
    for (let period = 2; period <= MAX_PERIOD; period++) {
      const length = period * REPETITIONS;
      if (this.history.length < length) continue;
      const tail = this.history.slice(-length);
      if (new Set(tail.slice(0, period).map((entry) => entry.call)).size < 2) continue;
      if (!tail.every((entry, index) => entry.call === tail[index % period]!.call && entry.result === tail[index % period]!.result)) continue;
      this.warned = { known: new Set(tail.map((entry) => `${entry.call}:${entry.result}`)), period, repeats: 0 };
      return { kind: "warning", period };
    }
    return null;
  }
}

export function cycleNotice(period: number): string {
  return `[agent loop warning] The last ${period}-call cycle repeated ${REPETITIONS} times with unchanged results. ` +
    "Reconsider your hypothesis and choose a different diagnostic action, obtain new evidence, or make a justified fix. " +
    "Do not repeat the same cycle: another cycle without progress will stop this turn. " +
    "Changing the plan or saying you made progress is not new evidence.";
}
