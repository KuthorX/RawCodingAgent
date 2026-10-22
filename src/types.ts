// Internal message format, decoupled from the wire protocol (see providers/openai.ts).

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  content: string;
  isError: boolean;
}

// An image the user attached. Stored as a file in the session directory and read when a request is built,
// so messages.json stays small.
export interface ImageAttachment {
  path: string; // absolute
  mediaType: string; // image/png, image/jpeg, ...
}

export type UserMessage = { role: "user"; content: string; images?: ImageAttachment[] };

export type Message =
  | UserMessage
  | {
      role: "assistant";
      text: string;
      toolCalls: ToolCall[];
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
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}

export interface Provider {
  readonly name: string;
  readonly model: string;
  setModel?(model: string): void;
  listModels?(): Promise<string[]>;
  // The signal aborts the in-flight request when the user stops the turn.
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse>;
}
