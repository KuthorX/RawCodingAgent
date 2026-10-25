import { createModels, getSupportedThinkingLevels, type Api, type Model, type Models } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";

export type ThinkEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ModelSelection { provider: string; model: string; thinkEffort: ThinkEffort }

export const PROVIDERS = [
  { id: "legacy", name: "兼容端点（原 .env）", defaultModel: "deepseek-chat" },
  { id: "openai", name: "OpenAI", defaultBaseURL: "https://api.openai.com/v1", defaultModel: "gpt-6.1-sol" },
  { id: "anthropic", name: "Anthropic", defaultBaseURL: "https://api.anthropic.com", defaultModel: "claude-sonnet-5-5" },
  { id: "google", name: "Google", defaultBaseURL: "https://generativelanguage.googleapis.com/v1beta", defaultModel: "gemini-3.8-flash" },
  { id: "deepseek", name: "DeepSeek", defaultBaseURL: "https://api.deepseek.com", defaultModel: "deepseek-flash" },
  { id: "openrouter", name: "OpenRouter", defaultBaseURL: "https://openrouter.ai/api/v1", defaultModel: "openai/gpt-6.1-sol" },
] as const;
export type ProviderId = typeof PROVIDERS[number]["id"];

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  vision: boolean;
  thinkingLevels: ThinkEffort[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

// Credentials are resolved by the application. In particular, an old DeepSeek OPENAI_API_KEY must never
// become an ambient credential for the native OpenAI provider.
const collection = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
for (const provider of [openaiProvider(), anthropicProvider(), googleProvider(), deepseekProvider(), openrouterProvider()]) collection.setProvider(provider);
export const nativeModels: Models = collection;

export function getPiModel(provider: string, model: string): Model<Api> {
  const found = nativeModels.getModel(provider, model);
  if (!found) throw new Error(`Unknown model "${model}" for provider "${provider}"`);
  return found;
}

function option(model: Model<Api>): ModelOption {
  return {
    provider: model.provider, id: model.id, name: model.name, api: model.api,
    contextWindow: model.contextWindow, maxTokens: model.maxTokens, vision: model.input.includes("image"),
    thinkingLevels: getSupportedThinkingLevels(model),
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  };
}

export function listCatalogModels(provider: string): ModelOption[] {
  if (!nativeModels.getProvider(provider)) throw new Error(`Unknown native provider "${provider}"`);
  return nativeModels.getModels(provider).map(option).sort((a, b) => a.name.localeCompare(b.name));
}

export function getCatalogModel(provider: string, model: string): ModelOption {
  return option(getPiModel(provider, model));
}

export function validateModelSelection(selection: ModelSelection): ModelSelection {
  const model = getPiModel(selection.provider, selection.model);
  if (!getSupportedThinkingLevels(model).includes(selection.thinkEffort)) throw new Error(`Thinking effort "${selection.thinkEffort}" is not supported by ${selection.provider}/${selection.model}`);
  return { ...selection };
}
