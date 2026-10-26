// Internal message format, decoupled from the wire protocol (see providers/openai.ts).
import type { AssistantMessage as PiAssistantMessage } from "@earendil-works/pi-ai";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
  // Full-output digest for cycle detection, before display truncation. Not sent to the provider.
  observationHash?: string;
}

// An image the user attached. Stored as a file in the session directory and read when a request is built,
// so messages.json stays small.
export interface ImageAttachment {
  path: string; // absolute
  mediaType: string; // image/png, image/jpeg, ...
}

// Any other file: saved in the session's attachments directory and readable through the file tools.
export interface FileAttachment {
  path: string; // absolute, inside <session>/attachments/
  name: string; // what the user called it, e.g. report.pdf
  mediaType: string;
  bytes: number;
}

export type UserMessage = { role: "user"; content: string; images?: ImageAttachment[]; files?: FileAttachment[] };

export type Message =
  | UserMessage
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
      // DeepSeek thinking models require this opaque reasoning trace on the next request.
      reasoningContent?: string;
      // Preserve signed/encrypted reasoning and origin for native multi-provider continuation.
      piMessage?: PiAssistantMessage;
    }
  | { role: "tool_results"; results: ToolResult[] };

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
}

export interface CompletionResponse {
  message: Extract<Message, { role: "assistant" }>;
  stopReason: StopReason;
  // cachedInputTokens is the part of inputTokens served from the provider's prompt cache (billed cheaper).
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteTokens?: number; costUsd?: number };
}

// Text as it arrives from a streaming response. Tool-call arguments are assembled by the provider and only
// surface in the final CompletionResponse; UIs don't need to render them token by token.
export interface ModelDelta {
  text?: string;
  reasoning?: string;
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  setModel?(model: string): void;
  listModels?(): Promise<string[]>;
  // The signal aborts the in-flight request when the user stops the turn. When onDelta is given (and the
  // provider supports it), text is delivered incrementally; the return value is the complete message either way.
  complete(req: CompletionRequest, signal?: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<CompletionResponse>;
}
