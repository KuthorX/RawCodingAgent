import type { ToolSpec } from "../types.ts";
import type { PlanController } from "./plan.ts";

export interface ToolContext {
  workspace: string;
  // Sanitized process environment for subprocess tools. Omitted in direct tool tests, where process.env is used.
  env?: NodeJS.ProcessEnv;
  plan?: PlanController;
  // Aborted when the user stops the turn; long-running tools should stop early.
  signal?: AbortSignal;
}

export interface Tool {
  spec: ToolSpec;
  // Whether a human must approve each call (see permission policy in agent/permissions.ts).
  dangerous: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

// Thrown by tools for errors that should be shown to the model as is_error results.
export class ToolError extends Error {}

export function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") throw new ToolError(`"${key}" must be a string`);
  return value;
}
