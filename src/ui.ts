import { styleText } from "node:util";
import type { AgentEvent, FinishReason } from "./agent/loop.ts";
import type { ToolCall } from "./types.ts";

const PREVIEW_CHARS = 400;

function write(line: string): void {
  process.stdout.write(line + "\n");
}

function preview(text: string): string {
  const flat = text.trim();
  return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
}

export function describeCall(call: ToolCall): string {
  const input = call.input;
  if (typeof input.command === "string") return `${call.name}: ${input.command}`;
  if (typeof input.path === "string") return `${call.name} ${input.path}`;
  return `${call.name} ${JSON.stringify(input)}`;
}

export function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "assistant_text":
      write(event.text);
      break;
    case "tool_call":
      write(styleText("cyan", `▸ ${describeCall(event.call)}`));
      break;
    case "tool_result":
      write(styleText(event.result.isError ? "red" : "gray", preview(event.result.content)));
      break;
  }
}

export function renderTurnEnd(result: { finishReason: FinishReason; steps: number }, tracePath: string | undefined): void {
  const note = result.finishReason === "end_turn" ? "done" : `stopped: ${result.finishReason}`;
  write(styleText("dim", `── ${note} · ${result.steps} step(s)${tracePath ? ` · trace ${tracePath}` : ""}`));
}

export function renderError(err: unknown): void {
  write(styleText("red", `error: ${err instanceof Error ? err.message : String(err)}`));
}

