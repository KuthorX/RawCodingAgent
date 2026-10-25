import { requireString, ToolError, type Tool } from "./types.ts";

// A child agent: "scout" only reads the parent workspace; "worker" writes inside its own git worktree.
export type AgentRole = "scout" | "worker";

export interface AgentTask {
  role: AgentRole;
  prompt: string;
  name?: string;
}

export interface AgentOutcome {
  id: string;
  role: AgentRole;
  name: string;
  ok: boolean;
  steps: number;
  costUsd: number;
  finishReason: string;
  text: string;
  // Worker only: the branch and worktree the changes live in.
  branch: string | null;
  workspace: string;
  files: number;
  error?: string;
}

export type SpawnAgents = (tasks: AgentTask[], callId: string, signal?: AbortSignal) => Promise<AgentOutcome[]>;

export const MAX_AGENT_TASKS = 4;
export const MAX_AGENT_PROMPT_CHARS = 2_000;
const ROLES: readonly AgentRole[] = ["scout", "worker"];

function describeOutcome(outcome: AgentOutcome): string {
  const head = `[${outcome.role} ${outcome.name}] ${outcome.ok ? "ok" : "failed"} · ${outcome.steps} steps · $${outcome.costUsd.toFixed(3)}`;
  const where = outcome.branch ? ` · branch ${outcome.branch} · worktree ${outcome.workspace} · ${outcome.files} changed file(s)` : "";
  const body = outcome.error ? `error: ${outcome.error}` : outcome.text;
  return `${head}${where}\n${body}`;
}

export function multiAgentTool(spawn: SpawnAgents): Tool {
  return {
    spec: {
      name: "multi_agent",
      description:
        "Run child agents in parallel and return their answers. role \"scout\": read-only investigation in this workspace " +
        "(cheap, for parallel searching and reading). role \"worker\": a substantial independent change in its own git " +
        "worktree and branch; it cannot see uncommitted changes or later user messages, its edits are not in your " +
        "workspace, and merging its branch is your job after reviewing the diff. Prefer scouts for investigation, " +
        "workers only for isolated multi-file changes, and do not spawn for a single-file edit.",
      inputSchema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_AGENT_TASKS,
            items: {
              type: "object",
              properties: {
                role: { type: "string", enum: ROLES, description: "scout (read-only) or worker (own worktree)" },
                prompt: { type: "string", description: "One self-contained task; the child cannot see this conversation" },
                name: { type: "string", description: "Short label shown in the UI" },
              },
              required: ["role", "prompt"],
            },
          },
        },
        required: ["tasks"],
      },
    },
    // Workers change files and scouts spend tokens: the batch runs as one approved call.
    dangerous: true,
    async run(input, ctx) {
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) throw new ToolError('"tasks" must be a non-empty array');
      if (input.tasks.length > MAX_AGENT_TASKS) throw new ToolError(`"tasks" accepts at most ${MAX_AGENT_TASKS} agents`);
      const tasks = input.tasks.map((raw, index): AgentTask => {
        if (typeof raw !== "object" || raw === null) throw new ToolError(`tasks[${index}] must be an object`);
        const task = raw as Record<string, unknown>;
        const role = task.role;
        if (role !== "scout" && role !== "worker") throw new ToolError(`tasks[${index}].role must be "scout" or "worker"`);
        const prompt = requireString(task, "prompt").trim();
        if (!prompt || prompt.length > MAX_AGENT_PROMPT_CHARS) throw new ToolError(`tasks[${index}].prompt must be 1-${MAX_AGENT_PROMPT_CHARS} characters`);
        const name = typeof task.name === "string" ? task.name.trim().slice(0, 40) : "";
        return { role, prompt, ...(name ? { name } : {}) };
      });
      if (tasks.filter((task) => task.role === "worker").length > 2) throw new ToolError("at most 2 workers per call; use scouts for the rest");
      const outcomes = await spawn(tasks, ctx.callId ?? "call", ctx.signal);
      return `${outcomes.length} agent(s) ran. Workers keep their work in their own worktree; review their branch before merging.\n\n` +
        outcomes.map(describeOutcome).join("\n\n");
    },
  };
}
