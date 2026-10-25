// USD per 1M tokens. Defaults: deepseek-flash peak prices from https://api-docs.deepseek.com/quick_start/pricing
// (checked 2026-10-20; off-peak is half). The page does not say which model "deepseek-chat" maps to,
// so set these in .env to match the model you actually use.
export interface Pricing {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
  // Optional exact-model overrides from MODEL_PRICING_JSON; base rates remain the fallback.
  models?: Record<string, Omit<Pricing, "models">>;
}

export const DEFAULT_PRICING: Pricing = { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 };

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  // Per-request catalog estimate from native providers, including cache writes and pricing tiers.
  costUsd?: number;
}

export function usageFromError(error: unknown): TokenUsage | undefined {
  const usage = error && typeof error === "object" && "usage" in error ? error.usage : undefined;
  if (!usage || typeof usage !== "object") return;
  const row = usage as Record<string, unknown>;
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (!valid(row.inputTokens) || !valid(row.cachedInputTokens) || !valid(row.outputTokens)) return;
  return { inputTokens: row.inputTokens, cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens,
    ...(valid(row.cacheWriteTokens) ? { cacheWriteTokens: row.cacheWriteTokens } : {}),
    ...(valid(row.costUsd) ? { costUsd: row.costUsd } : {}) };
}

export function costUsd(usage: TokenUsage, pricing: Pricing): number {
  if (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0) return usage.costUsd;
  const cached = Math.min(usage.cachedInputTokens, usage.inputTokens);
  return (
    ((usage.inputTokens - cached) * pricing.inputPerMTok +
      cached * pricing.cachedInputPerMTok +
      usage.outputTokens * pricing.outputPerMTok) /
    1_000_000
  );
}

function price(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}

export function loadPricing(env: NodeJS.ProcessEnv = process.env): Pricing {
  const base = {
    inputPerMTok: price("PRICE_INPUT_PER_MTOK", env.PRICE_INPUT_PER_MTOK, DEFAULT_PRICING.inputPerMTok),
    cachedInputPerMTok: price("PRICE_CACHED_INPUT_PER_MTOK", env.PRICE_CACHED_INPUT_PER_MTOK, DEFAULT_PRICING.cachedInputPerMTok),
    outputPerMTok: price("PRICE_OUTPUT_PER_MTOK", env.PRICE_OUTPUT_PER_MTOK, DEFAULT_PRICING.outputPerMTok),
  };
  const raw = env.MODEL_PRICING_JSON?.trim();
  if (!raw) return base;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("MODEL_PRICING_JSON must be valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_PRICING_JSON must be an object");
  const models: Record<string, Omit<Pricing, "models">> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`MODEL_PRICING_JSON.${model} must be an object`);
    const row = value as Record<string, unknown>;
    models[model] = {
      inputPerMTok: price(`MODEL_PRICING_JSON.${model}.inputPerMTok`, String(row.inputPerMTok ?? ""), base.inputPerMTok),
      cachedInputPerMTok: price(`MODEL_PRICING_JSON.${model}.cachedInputPerMTok`, String(row.cachedInputPerMTok ?? ""), base.cachedInputPerMTok),
      outputPerMTok: price(`MODEL_PRICING_JSON.${model}.outputPerMTok`, String(row.outputPerMTok ?? ""), base.outputPerMTok),
    };
  }
  return { ...base, models };
}

export function pricingForModel(pricing: Pricing, model: string): Omit<Pricing, "models"> {
  return pricing.models?.[model] ?? pricing;
}
