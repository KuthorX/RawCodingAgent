// USD per 1M tokens. Defaults: deepseek-flash peak prices from https://api-docs.deepseek.com/quick_start/pricing
// (checked 2026-10-20; off-peak is half). The page does not say which model "deepseek-chat" maps to,
// so set these in .env to match the model you actually use.
export interface Pricing {
  inputPerMTok: number;
  cachedInputPerMTok: number;
  outputPerMTok: number;
}

export const DEFAULT_PRICING: Pricing = { inputPerMTok: 0.3, cachedInputPerMTok: 0.006, outputPerMTok: 1.2 };

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export function costUsd(usage: TokenUsage, pricing: Pricing): number {
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
  return {
    inputPerMTok: price("PRICE_INPUT_PER_MTOK", env.PRICE_INPUT_PER_MTOK, DEFAULT_PRICING.inputPerMTok),
    cachedInputPerMTok: price("PRICE_CACHED_INPUT_PER_MTOK", env.PRICE_CACHED_INPUT_PER_MTOK, DEFAULT_PRICING.cachedInputPerMTok),
    outputPerMTok: price("PRICE_OUTPUT_PER_MTOK", env.PRICE_OUTPUT_PER_MTOK, DEFAULT_PRICING.outputPerMTok),
  };
}
