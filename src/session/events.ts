import type { AgentEvent, FinishReason } from "../agent/loop.ts";
import type { ApprovalMode } from "../agent/permissions.ts";
import type { ToolCall } from "../types.ts";
import type { PlanItem } from "../tools/plan.ts";
import type { AgentRole } from "../tools/multi-agent.ts";
import type { SessionMode } from "./store.ts";

// Everything a UI needs to render (and later replay) a conversation.
type SessionEventBody =
  | AgentEvent
  // queued: sent while a turn was running (an interjection), delivered at the next step.
  // images: attachment file names in the session's attachments/ directory.
  | { type: "user"; text: string; queued?: boolean; images?: string[] }
  // A command the user typed (/help, /plan, /multiagent …). It never enters the model history, but it is user input,
  // so the transcript and its replay show it before the command's own output.
  | { type: "command"; text: string }
  | { type: "interjection_dropped"; count: number }
  | { type: "approval_request"; id: string; call: ToolCall }
  | { type: "approval_resolved"; id: string; allow: boolean }
  | { type: "approval_mode"; mode: ApprovalMode }
  | { type: "skill_loaded"; name: string; path: string }
  | { type: "compaction_start"; manual?: boolean }
  | { type: "compacted"; beforeTokens: number; afterTokens: number; manual?: boolean }
  // continues: queued interjections start the next turn right away, so the session stays busy.
  | { type: "turn_end"; finishReason: FinishReason; steps: number; continues?: boolean }
  | { type: "error"; message: string; continues?: boolean }
  // First event of a forked session, right after the events copied from the source.
  | { type: "forked"; from: string; fromTitle: string; turns: number }
  | { type: "plan"; items: PlanItem[] }
  // mode null = back to a normal session. note explains an automatic end (plan complete, cap reached, stopped).
  | { type: "mode"; mode: SessionMode | null; prompt?: string; max?: number; count?: number; note?: string }
  // A child agent started. callId is the multi_agent call it belongs to, so the UI can nest it under that card.
  | { type: "agent_start"; agent: string; callId: string; role: AgentRole; name: string; workspace: string; branch: string | null }
  // Finished child: the same numbers the parent model already has in the tool result.
  | { type: "agent_end"; agent: string; ok: boolean; steps: number; costUsd: number; finishReason: string; branch: string | null; files: number }
  // /multiagent: whether the session exposes multi_agent at all.
  | { type: "multiagent"; enabled: boolean };

// Child agents emit the ordinary agent events with `agent` set; their transcript is grouped in the UI instead of
// entering the parent's message history.
export type SessionEvent = SessionEventBody & { agent?: string };
