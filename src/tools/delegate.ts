import { requireString, ToolError, type Tool } from "./types.ts";

export type DelegateTask = (prompt: string, signal?: AbortSignal) => Promise<string>;

export function delegateTool(delegate: DelegateTask): Tool {
  return {
    spec: {
      name: "delegate_task",
      description: "Ask a bounded read-only child agent to investigate a focused question and return findings. It cannot edit files or run shell commands.",
      inputSchema: {
        type: "object",
        properties: { prompt: { type: "string", description: "One focused investigation request, at most 2000 characters" } },
        required: ["prompt"],
      },
    },
    dangerous: true,
    async run(input, ctx) {
      const prompt = requireString(input, "prompt").trim();
      if (!prompt || prompt.length > 2000) throw new ToolError('"prompt" must be 1-2000 characters');
      return delegate(prompt, ctx.signal);
    },
  };
}

