import OpenAI from "openai";
import type { Config } from "../config.ts";
import { readFileSync } from "node:fs";
import type { CompletionRequest, CompletionResponse, Message, ModelDelta, Provider, StopReason, ToolCall, UserMessage } from "../types.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function needsReasoningContent(model: string): boolean {
  return /deepseek-(?:flash|reasoner)|deepseek-v4-(?:flash|pro)/i.test(model);
}

const PROVIDER = "openai";
const MAX_TOKENS = 8192;

// With vision the images go along as data URLs; otherwise the model is told where they are saved,
// so it can still mention or copy them instead of silently not knowing they exist.
function userContent(m: UserMessage, vision: boolean): OpenAI.Chat.Completions.ChatCompletionUserMessageParam["content"] {
  const images = m.images ?? [];
  if (images.length === 0) return m.content;
  if (!vision) {
    const list = images.map((img) => `- ${img.path}`).join("\n");
    return `${m.content}\n\n[The user attached ${images.length} image(s). This model cannot view images; they are saved at:\n${list}]`;
  }
  const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = m.content ? [{ type: "text", text: m.content }] : [];
  for (const img of images) {
    let data: string;
    try {
      data = readFileSync(img.path).toString("base64");
    } catch {
      parts.push({ type: "text", text: `[attached image missing: ${img.path}]` });
      continue;
    }
    parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${data}` } });
  }
  return parts;
}

export function toOpenAIMessages(system: string, messages: Message[], vision = false, model = ""): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push({ role: "user", content: userContent(m, vision) });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: m.text || null,
          ...(needsReasoningContent(model) ? { reasoning_content: m.reasoningContent ?? "" } : m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
          ...(m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        } as ChatMessage & { reasoning_content?: string });
        break;
      case "tool_results":
        // OpenAI protocol: one "tool" message per result.
        for (const r of m.results) {
          out.push({ role: "tool", tool_call_id: r.callId, content: r.isError ? `ERROR: ${r.content}` : r.content });
        }
        break;
    }
  }
  return out;
}

// Malformed JSON arguments are passed through under a sentinel key so the tool layer can report it to the model.
export function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { __invalid_arguments: raw };
  } catch {
    return { __invalid_arguments: raw };
  }
}

// OpenAI reports cache hits in prompt_tokens_details; DeepSeek uses its own prompt_cache_hit_tokens field.
export function cachedTokens(usage: unknown): number {
  const u = (usage ?? {}) as { prompt_tokens_details?: { cached_tokens?: unknown }; prompt_cache_hit_tokens?: unknown };
  const value = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens;
  return typeof value === "number" ? value : 0;
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

export class OpenAIProvider implements Provider {
  readonly name = PROVIDER;
  model: string;
  vision: boolean;
  readonly stream: boolean;
  private readonly forceVision: boolean;
  private readonly visionModels: Record<string, boolean>;
  private readonly client: OpenAI;

  constructor(config: Config["llm"]) {
    this.model = config.model;
    this.forceVision = config.vision;
    this.visionModels = config.visionModels ?? {};
    this.vision = this.forceVision || this.visionModels[this.model] === true;
    this.stream = config.stream;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  setModel(model: string): void {
    this.model = model;
    this.vision = this.forceVision || this.visionModels[model] === true;
  }

  async listModels(): Promise<string[]> {
    const page = await this.client.models.list();
    return page.data.map((model) => model.id).sort();
  }

  private request(req: CompletionRequest) {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: toOpenAIMessages(req.system, req.messages, this.vision, this.model),
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };
  }

  async complete(req: CompletionRequest, signal?: AbortSignal, onDelta?: (delta: ModelDelta) => void): Promise<CompletionResponse> {
    if (onDelta && this.stream) {
      let emitted = false;
      try {
        return await this.completeStreaming(req, signal, (delta) => {
          emitted = true;
          onDelta(delta);
        });
      } catch (err) {
        // An endpoint that rejects stream_options (or cannot stream at all) still works without it. Only fall
        // back before anything was shown: retrying after partial text would duplicate it.
        if (emitted || signal?.aborted) throw err;
      }
    }
    return this.completeOnce(req, signal);
  }

  private async completeOnce(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const res = await this.client.chat.completions.create(this.request(req), { signal });
    const choice = res.choices[0];
    if (!choice) throw new Error("OpenAI-compatible API returned no choices");

    const message = choice.message as typeof choice.message & { reasoning_content?: unknown };
    const reasoningContent = typeof message.reasoning_content === "string" ? message.reasoning_content : undefined;
    const toolCalls: ToolCall[] = (message.tool_calls ?? []).flatMap((c) =>
      c.type === "function" ? [{ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }] : [],
    );
    return {
      message: { role: "assistant", text: message.content ?? "", toolCalls, ...(reasoningContent ? { reasoningContent } : {}) },
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cachedInputTokens: cachedTokens(res.usage),
      },
    };
  }

  // SSE chunks: text arrives in delta.content, tool calls arrive as fragments keyed by index (id and name
  // usually once, arguments split across many chunks), and usage arrives in a final chunk with no choices.
  private async completeStreaming(
    req: CompletionRequest,
    signal: AbortSignal | undefined,
    onDelta: (delta: ModelDelta) => void,
  ): Promise<CompletionResponse> {
    const stream = await this.client.chat.completions.create(
      { ...this.request(req), stream: true, stream_options: { include_usage: true } },
      { signal },
    );
    let text = "";
    let reasoning = "";
    let finish: string | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    const calls = new Map<number, { id?: string; name?: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta as typeof choice.delta & { reasoning_content?: unknown };
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        onDelta({ text: delta.content });
      }
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        reasoning += delta.reasoning_content;
        onDelta({ reasoning: delta.reasoning_content });
      }
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const call = calls.get(index) ?? { args: "" };
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) call.name = tc.function.name;
        if (tc.function?.arguments) call.args += tc.function.arguments;
        calls.set(index, call);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([index, call]) => (call.name ? [{ id: call.id ?? `call_${index}`, name: call.name, input: parseArguments(call.args) }] : []));
    const stopReason = finish === null && toolCalls.length > 0 ? "tool_use" : mapFinishReason(finish);
    return {
      message: { role: "assistant", text, toolCalls, ...(reasoning ? { reasoningContent: reasoning } : {}) },
      stopReason,
      usage: {
        inputTokens: usage?.prompt_tokens ?? 0,
        outputTokens: usage?.completion_tokens ?? 0,
        cachedInputTokens: cachedTokens(usage),
      },
    };
  }
}
