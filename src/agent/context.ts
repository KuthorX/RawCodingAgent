import type { CompletionRequest, Message } from "../types.ts";

// Estimates the complete request, including opaque reasoning, tool schemas and image overhead.
// Image tokenization is provider-specific; reserve 8192 tokens per image until a provider supplies a counter.
export function estimateTokens(messages: readonly Message[]): number {
  return textTokens(JSON.stringify(messages)) + messages.reduce((sum, message) =>
    sum + (message.role === "user" ? (message.images?.length ?? 0) * 8192 : 0), 0);
}

export function textTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 128) ascii++;
    else wide++;
  }
  return Math.ceil(ascii / 4 + wide / 1.5);
}

export function requestTokens(request: CompletionRequest): number {
  return textTokens(request.system) + textTokens(JSON.stringify(request.tools)) + estimateTokens(request.messages) + 32;
}

export class ContextLimitError extends Error {}
