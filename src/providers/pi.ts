import { readFileSync } from "node:fs";
import type { AssistantMessage, Context, ImageContent, Message as PiMessage, TextContent, TSchema, ToolCall as PiToolCall, Usage } from "@earendil-works/pi-ai";
import type { CompletionRequest, CompletionResponse, Message, ModelDelta, Provider, ToolCall } from "../types.ts";
import { getPiModel, nativeModels, validateModelSelection, type ModelSelection } from "./catalog.ts";

export const PI_MAX_OUTPUT_TOKENS = 32768;
type ReportedUsage = CompletionResponse["usage"];

export class PiProviderError extends Error {
  readonly usage?: ReportedUsage;
  readonly stopReason: string;
  readonly code?: string;
  constructor(message: string, stopReason: string, usage?: ReportedUsage) {
    super(message);
    this.name = "PiProviderError";
    this.stopReason = stopReason;
    this.usage = usage;
    // Pi flattens upstream errors into text; preserve recognized network codes for the existing retry guard.
    this.code = message.match(/\b(ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)\b/)?.[1];
  }
}

function usageOf(usage: Usage): ReportedUsage {
  return {
    inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    outputTokens: usage.output,
    cachedInputTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: usage.cost.total,
  };
}

const EMPTY_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function oldAssistant(message: Extract<Message, { role: "assistant" }>): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "legacy", model: "legacy", timestamp: 0,
    content: [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...message.toolCalls.map((call) => ({ type: "toolCall" as const, id: call.id, name: call.name, arguments: call.input as PiToolCall["arguments"] })),
    ],
    usage: EMPTY_USAGE, stopReason: message.toolCalls.length ? "toolUse" : "stop",
  };
}

export function toPiContext(request: CompletionRequest, vision: boolean): Context {
  const messages: PiMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const message of request.messages) {
    if (message.role === "user") {
      const images = message.images ?? [];
      const parts: (TextContent | ImageContent)[] = message.content ? [{ type: "text", text: message.content }] : [];
      if (vision) for (const image of images) {
        try { parts.push({ type: "image", data: readFileSync(image.path).toString("base64"), mimeType: image.mediaType }); }
        catch { parts.push({ type: "text", text: `[attached image missing: ${image.path}]` }); }
      }
      messages.push({
        role: "user", timestamp: 0,
        content: images.length && vision
          ? parts
          : message.content + (images.length ? `\n\n[Attached image files: ${images.map((image) => image.path).join(", ")}; this model cannot view images.]` : ""),
      });
    } else if (message.role === "assistant") {
      for (const call of message.toolCalls) toolNames.set(call.id, call.name);
      // Preserve signed/encrypted reasoning and tool signatures with their original provider/model identity.
      messages.push(message.piMessage ?? oldAssistant(message));
    } else {
      for (const result of message.results) messages.push({
        role: "toolResult", toolCallId: result.callId, toolName: toolNames.get(result.callId) ?? "unknown",
        content: [{ type: "text", text: result.content }], isError: result.isError, timestamp: 0,
      });
    }
  }
  return { systemPrompt: request.system, messages, tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema as TSchema })) };
}

function toolCall(block: PiToolCall): ToolCall {
  return { id: block.id, name: block.name, input: block.argumentsError ? { __invalid_arguments: block.argumentsError } : block.arguments };
}

export interface PiProviderOptions { apiKey: string; baseURL?: string; stream?: boolean }

export class PiProvider implements Provider {
  private readonly selection: ModelSelection;
  private readonly options: PiProviderOptions;

  constructor(selection: ModelSelection, options: PiProviderOptions) {
    this.selection = validateModelSelection(selection);
    this.options = { ...options };
    if (options.baseURL) {
      const url = new URL(options.baseURL);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Provider base URL must be an http(s) URL without embedded credentials");
    }
  }

  get name(): string { return this.selection.provider; }
  get model(): string { return this.selection.model; }

  async complete(request: CompletionRequest, signal?: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<CompletionResponse> {
    const key = this.options.apiKey.trim();
    if (!key) throw new PiProviderError(`No API key configured for ${this.name}`, "error");
    if (signal?.aborted) throw new PiProviderError("Request aborted", "aborted");
    const scrub = (text: string) => text.split(key).join("[REDACTED]");
    try {
      const catalog = getPiModel(this.name, this.model);
      // Older Anthropic adapters add a thinking budget to the requested output cap. Cap the model too so
      // thinking and answer tokens together remain inside the harness's reserved output space.
      const model = { ...catalog, maxTokens: Math.min(catalog.maxTokens, PI_MAX_OUTPUT_TOKENS), ...(this.options.baseURL ? { baseUrl: this.options.baseURL } : {}) };
      const stream = nativeModels.streamSimple(model, toPiContext(request, model.input.includes("image")), {
        apiKey: key, signal, maxTokens: model.maxTokens,
        ...(this.selection.thinkEffort === "off" ? {} : { reasoning: this.selection.thinkEffort }),
      });
      for await (const event of stream) {
        if (this.options.stream === false) continue;
        if (event.type === "text_delta") onDelta?.({ text: event.delta });
        if (event.type === "thinking_delta") onDelta?.({ reasoning: event.delta });
      }
      const message = await stream.result();
      if (!["stop", "toolUse", "length"].includes(message.stopReason)) {
        const reported = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite > 0 ? usageOf(message.usage) : undefined;
        throw new PiProviderError(scrub(message.errorMessage || `Provider stopped with ${message.stopReason}`), message.stopReason, reported);
      }
      const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("");
      const reasoning = message.content.flatMap((block) => block.type === "thinking" && !block.redacted ? [block.thinking] : []).join("");
      return {
        message: { role: "assistant", text, toolCalls: message.content.flatMap((block) => block.type === "toolCall" ? [toolCall(block)] : []), ...(reasoning ? { reasoningContent: reasoning } : {}), piMessage: message },
        stopReason: message.stopReason === "toolUse" ? "tool_use" : message.stopReason === "length" ? "max_tokens" : "end_turn",
        usage: usageOf(message.usage),
      };
    } catch (error) {
      if (error instanceof PiProviderError) throw error;
      throw new PiProviderError(scrub(error instanceof Error ? error.message : String(error)), signal?.aborted ? "aborted" : "error");
    }
  }
}
