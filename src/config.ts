import { existsSync } from "node:fs";

export interface Config {
  maxSteps: number;
  maxTurnCostUsd: number | null; // null = no cost limit
  maxRepeats: number;
  llm: { apiKey: string; baseURL: string | undefined; model: string };
}

function positiveInt(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

function nonNegative(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a number >= 0, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (see .env.example)");
  return {
    maxSteps: positiveInt("AGENT_MAX_STEPS", env.AGENT_MAX_STEPS ?? "100"),
    // 0 turns the cost limit off.
    maxTurnCostUsd: nonNegative("AGENT_MAX_TURN_COST_USD", env.AGENT_MAX_TURN_COST_USD ?? "0.5") || null,
    maxRepeats: positiveInt("AGENT_MAX_REPEATS", env.AGENT_MAX_REPEATS ?? "3"),
    llm: {
      apiKey,
      baseURL: env.OPENAI_BASE_URL || undefined,
      model: env.OPENAI_MODEL ?? "deepseek-chat",
    },
  };
}

export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
