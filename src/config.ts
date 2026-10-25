import { existsSync } from "node:fs";
import { isPromptRule, type PromptRule } from "./agent/system-prompt.ts";

export interface Config {
  maxSteps: number | null; // null = no step limit
  maxTurnCostUsd: number | null; // null = no cost limit
  maxRepeats: number;
  promptRules: PromptRule[];
  contextWindows: Record<string, number>;
  // vision: the model accepts images (OpenAI image_url parts). Off for deepseek-chat, which is text-only.
  // stream: deliver assistant text as it is generated. Disable for an endpoint that rejects stream_options.
  llm: { apiKey: string; baseURL: string | undefined; model: string; vision: boolean; visionModels?: Record<string, boolean>; stream: boolean };
}

const SECRET_ENV_NAME = /(^|_)(API_?KEY|ACCESS_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(_|$)/i;

// Provider keeps credentials in memory; child tools do not need them. Keep Git's config variables because they
// are control-plane settings, not credentials, and Git itself relies on them.
export function sanitizeToolEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of Object.keys(out)) {
    if (SECRET_ENV_NAME.test(name) && !name.startsWith("GIT_CONFIG_")) delete out[name];
  }
  return out;
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

function contextWindows(raw: string | undefined): Record<string, number> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("MODEL_CONTEXT_WINDOWS_JSON must be valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_CONTEXT_WINDOWS_JSON must be an object");
  const result: Record<string, number> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`MODEL_CONTEXT_WINDOWS_JSON.${model} must be a positive integer`);
    result[model] = value;
  }
  return result;
}

function visionModels(raw: string | undefined): Record<string, boolean> {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("MODEL_VISION_JSON must be valid JSON"); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MODEL_VISION_JSON must be an object");
  const result: Record<string, boolean> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "boolean") throw new Error(`MODEL_VISION_JSON.${model} must be boolean`);
    result[model] = value;
  }
  return result;
}

function promptRules(value: string): PromptRule[] {
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = names.filter((n) => !isPromptRule(n));
  if (unknown.length > 0) throw new Error(`AGENT_PROMPT_RULES: unknown rule(s) ${unknown.join(", ")}`);
  return [...new Set(names)] as PromptRule[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // GUI setup must work before a provider key is configured.
  const apiKey = env.OPENAI_API_KEY ?? "";
  return {
    // 0 turns the step / cost limit off. Steps are unlimited by default: the cost limit and the repeat guard
    // already stop a runaway turn, and long tasks shouldn't be cut off halfway.
    maxSteps: Math.floor(nonNegative("AGENT_MAX_STEPS", env.AGENT_MAX_STEPS ?? "0")) || null,
    maxTurnCostUsd: nonNegative("AGENT_MAX_TURN_COST_USD", env.AGENT_MAX_TURN_COST_USD ?? "0.5") || null,
    maxRepeats: positiveInt("AGENT_MAX_REPEATS", env.AGENT_MAX_REPEATS ?? "3"),
    // D3: "spec" had the only consistent (not significant) positive signal in the prompt experiment;
    // "tools" steers file work away from bash (D4). Set AGENT_PROMPT_RULES= (empty) to run the bare baseline.
    promptRules: promptRules(env.AGENT_PROMPT_RULES ?? "spec,tools"),
    contextWindows: contextWindows(env.MODEL_CONTEXT_WINDOWS_JSON),
    llm: {
      apiKey,
      baseURL: env.OPENAI_BASE_URL || undefined,
      model: env.OPENAI_MODEL ?? "deepseek-chat",
      vision: /^(1|true|yes)$/i.test(env.OPENAI_VISION ?? ""),
      visionModels: visionModels(env.MODEL_VISION_JSON),
      stream: !/^(0|false|no)$/i.test(env.OPENAI_STREAM ?? ""),
    },
  };
}

export function loadDotEnv(path = ".env"): void {
  if (existsSync(path)) process.loadEnvFile(path);
}
