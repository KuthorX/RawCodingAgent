import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../src/app.ts";
import type { AgentDeps } from "../src/agent/loop.ts";
import { createTracer, nullTracer } from "../src/agent/trace.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import { SessionStore } from "../src/session/store.ts";
import { SettingsStore } from "../src/gui/settings.ts";
import { ProjectStore } from "../src/workspace/store.ts";
import { defaultTools } from "../src/tools/index.ts";
import { planTool } from "../src/tools/plan.ts";
import { multiAgentTool } from "../src/tools/multi-agent.ts";
import type { CompletionRequest, CompletionResponse, Provider, StopReason, ToolCall } from "../src/types.ts";

export function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "rca-test-"));
}

export function reply(
  text: string,
  toolCalls: ToolCall[] = [],
  stopReason?: StopReason,
  usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
): CompletionResponse {
  return {
    message: { role: "assistant", text, toolCalls },
    stopReason: stopReason ?? (toolCalls.length > 0 ? "tool_use" : "end_turn"),
    usage,
  };
}

// Replays scripted responses and records every request it received.
export class ScriptedProvider implements Provider {
  readonly name = "scripted";
  model = "scripted";
  readonly requests: CompletionRequest[] = [];
  private readonly script: CompletionResponse[];

  constructor(script: CompletionResponse[]) {
    this.script = [...script];
  }

  setModel(model: string): void {
    this.model = model;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("script exhausted");
    return next;
  }
}

export function makeDeps(provider: Provider, overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    provider,
    tools: [...defaultTools, ...(overrides.plan ? [planTool(overrides.plan)] : []), ...(overrides.spawnAgents ? [multiAgentTool(overrides.spawnAgents)] : [])],
    system: "test",
    workspace: tempWorkspace(),
    maxSteps: 10,
    approvalMode: () => "auto",
    confirm: async () => true,
    tracer: nullTracer,
    ...overrides,
  };
}

// A Runtime backed by a temp session store and a scripted model.
export function testRuntime(provider: Provider): Runtime {
  const store = new SessionStore(tempWorkspace());
  return {
    store,
    projects: new ProjectStore(join(tempWorkspace(), "projects.json"), join(tempWorkspace(), "worktrees.json")),
    settings: new SettingsStore(join(tempWorkspace(), "settings.json"), provider.model),
    model: provider.model,
    contextWindow: () => 400_000,
    pricing: DEFAULT_PRICING,
    promptRules: [],
    limits: { maxSteps: 10, maxTurnCostUsd: null },
    defaultApprovalMode: "ask",
    makeSystem: () => "test",
    makeDeps: (meta, hooks) => ({
      ...makeDeps(provider, hooks),
      workspace: meta.workspace,
      tracer: createTracer(store.tracePath(meta.id)),
      ...hooks,
    }),
  };
}

// A provider whose responses the test releases one at a time; honours the abort signal like a real request.
export class ManualProvider implements Provider {
  readonly name = "manual";
  readonly model = "manual";
  readonly requests: CompletionRequest[] = [];
  private waiting: { resolve: (r: CompletionResponse) => void } | null = null;
  private arrived: (() => void) | null = null;

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    this.requests.push(structuredClone(req));
    this.arrived?.();
    return new Promise((resolve, reject) => {
      this.waiting = { resolve };
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }

  // Resolves once the agent has made its n-th request.
  requested(n: number): Promise<void> {
    if (this.requests.length >= n) return Promise.resolve();
    return new Promise((resolve) => {
      this.arrived = () => {
        if (this.requests.length >= n) resolve();
      };
    });
  }

  respond(response: CompletionResponse): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.resolve(response);
  }
}
