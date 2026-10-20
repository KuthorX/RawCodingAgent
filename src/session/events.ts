import type { AgentEvent, FinishReason } from "../agent/loop.ts";
import type { ApprovalMode } from "../agent/permissions.ts";
import type { ToolCall } from "../types.ts";

// Everything a UI needs to render (and later replay) a conversation.
export type SessionEvent =
  | AgentEvent
  // queued: sent while a turn was running (an interjection), delivered at the next step.
  | { type: "user"; text: string; queued?: boolean }
  | { type: "interjection_dropped"; count: number }
  | { type: "approval_request"; id: string; call: ToolCall }
  | { type: "approval_resolved"; id: string; allow: boolean }
  | { type: "approval_mode"; mode: ApprovalMode }
  // continues: queued interjections start the next turn right away, so the session stays busy.
  | { type: "turn_end"; finishReason: FinishReason; steps: number; continues?: boolean }
  | { type: "error"; message: string; continues?: boolean };
