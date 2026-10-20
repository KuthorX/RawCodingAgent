import OpenAI from "openai";
import type { Config } from "../config.ts";
import type { CompletionRequest, CompletionResponse, Message, Provider, StopReason, ToolCall } from "../types.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const PROVIDER = "openai";
const MAX_TOKENS = 8192;

export function toOpenAIMessages(system: string, messages: Message[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];
  for (const m of messages) {
    switch (m.role) {
      case "user":
        out.push({ role: "user", content: m.content });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: m.text || null,
          ...(m.toolCalls.length > 0
            ? {
                tool_calls: m.toolCalls.map((c) => ({
                  id: c.id,
                  type: "function" as const,
                  function: { name: c.name, arguments: JSON.stringify(c.input) },
                })),
              }
            : {}),
        });
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
  readonly model: string;
  private readonly client: OpenAI;

  constructor(config: Config["llm"]) {
    this.model = config.model;
    this.client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const res = await this.client.chat.completions.create(
      {
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: toOpenAIMessages(req.system, req.messages),
      ...(req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      },
      { signal },
    );
    const choice = res.choices[0];
    if (!choice) throw new Error("OpenAI-compatible API returned no choices");

    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).flatMap((c) =>
      c.type === "function" ? [{ id: c.id, name: c.function.name, input: parseArguments(c.function.arguments) }] : [],
    );
    return {
      message: { role: "assistant", text: choice.message.content ?? "", toolCalls },
      stopReason: mapFinishReason(choice.finish_reason),
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
        cachedInputTokens: cachedTokens(res.usage),
      },
    };
  }
}
