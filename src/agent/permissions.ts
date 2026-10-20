import type { Tool } from "../tools/index.ts";
import type { ToolCall } from "../types.ts";

// D6: which calls need human approval.
export type Confirm = (call: ToolCall) => Promise<boolean>;

// "ask": dangerous tools wait for a human; "auto": everything runs without asking.
export type ApprovalMode = "ask" | "auto";
export const APPROVAL_MODES: readonly ApprovalMode[] = ["ask", "auto"];

// How a tool call got permission to run; recorded on its trace span.
export type ApprovalOutcome = "not_required" | "auto" | "allowed" | "denied";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && (APPROVAL_MODES as readonly string[]).includes(value);
}

export function needsApproval(tool: Tool, mode: ApprovalMode): boolean {
  return tool.dangerous && mode === "ask";
}
