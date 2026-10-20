import { existsSync } from "node:fs";
import { isPromptRule, type PromptRule } from "./agent/system-prompt.ts";

export interface Config {
  maxSteps: number;
  maxTurnCostUsd: number | null; // null = no cost limit
  maxRepeats: number;
  promptRules: PromptRule[];
  // vision: the model accepts images (OpenAI image_url parts). Off for deepseek-chat, which is text-only.
  llm: { apiKey: string; baseURL: string | undefined; model: string; vision: boolean };
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

function promptRules(value: string): PromptRule[] {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !isPromptRule(n));
  if (unknown.length > 0) throw new Error(`AGENT_PROMPT_RULES: unknown rule(s) ${unknown.join(", ")}`);
  return [...new Set(names)] as PromptRule[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required (see .env.example)");
  return {
    maxSteps: positiveInt("AGENT_MAX_STEPS", env.AGENT_MAX_STEPS ?? "100"),
    // 0 turns the cost limit off.
    maxTurnCostUsd: nonNegative("AGENT_MAX_TURN_COST_USD", env.AGENT_MAX_TURN_COST_USD ?? "0.5") || null,
    maxRepeats: positiveInt("AGENT_MAX_REPEATS", env.AGENT_MAX_REPEATS ?? "3"),
    // D3: "spec" had the only consistent (not significant) positive signal in the prompt experiment;
    // "tools" steers file work away from bash (D4). Set AGENT_PROMPT_RULES= (empty) to run the bare baseline.
    promptRules: promptRules(env.AGENT_PROMPT_RULES ?? "spec,tools"),
    llm: {
      apiKey,
      baseURL: env.OPENAI_BASE_URL || undefined,
      model: env.OPENAI_MODEL ?? "deepseek-chat",
      vision: /^(1|true|yes)$/i.test(env.OPENAI_VISION ?? ""),
    },
  };
}

export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
