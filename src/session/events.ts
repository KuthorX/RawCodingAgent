import type { AgentEvent, FinishReason } from "../agent/loop.ts";
import type { ApprovalMode } from "../agent/permissions.ts";
import type { ToolCall } from "../types.ts";

// Everything a UI needs to render (and later replay) a conversation.
export type SessionEvent =
  | AgentEvent
  // queued: sent while a turn was running (an interjection), delivered at the next step.
  // images: attachment file names in the session's attachments/ directory.
  | { type: "user"; text: string; queued?: boolean; images?: string[] }
  | { type: "interjection_dropped"; count: number }
  | { type: "approval_request"; id: string; call: ToolCall }
  | { type: "approval_resolved"; id: string; allow: boolean }
  | { type: "approval_mode"; mode: ApprovalMode }
  | { type: "compaction_start"; manual?: boolean }
  | { type: "compacted"; beforeTokens: number; afterTokens: number; manual?: boolean }
  // continues: queued interjections start the next turn right away, so the session stays busy.
  | { type: "turn_end"; finishReason: FinishReason; steps: number; continues?: boolean }
  | { type: "error"; message: string; continues?: boolean }
  // First event of a forked session, right after the events copied from the source.
  | { type: "forked"; from: string; fromTitle: string; turns: number };
