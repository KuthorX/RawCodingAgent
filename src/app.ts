import { resolve } from "node:path";
import type { AgentDeps } from "./agent/loop.ts";
import type { ApprovalMode } from "./agent/permissions.ts";
import { buildSystemPrompt } from "./agent/system-prompt.ts";
import { createTracer } from "./agent/trace.ts";
import { loadConfig, loadDotEnv } from "./config.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { loadPricing, type Pricing } from "./pricing.ts";
import type { RunnerOptions } from "./session/runner.ts";
import { SessionStore } from "./session/store.ts";
import { WorkspaceStore } from "./workspace/store.ts";
import { defaultTools } from "./tools/index.ts";

export const PROJECT_ROOT = resolve(import.meta.dirname, "..");

export interface Runtime {
  store: SessionStore;
  workspaces: WorkspaceStore;
  model: string;
  pricing: Pricing;
  // Mode given to newly created sessions (--yes => "auto"); each session can change its own later.
  defaultApprovalMode: ApprovalMode;
  makeDeps: RunnerOptions["makeDeps"];
}

// Shared by the CLI and the GUI: config, provider, session storage, and per-session agent wiring.
export function createRuntime(defaultApprovalMode: ApprovalMode): Runtime {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const config = loadConfig();
  const provider = new OpenAIProvider(config.llm);
  const store = new SessionStore(resolve(PROJECT_ROOT, ".sessions"));

  return {
    store,
    workspaces: new WorkspaceStore(resolve(PROJECT_ROOT, ".workspaces.json")),
    model: provider.model,
    pricing: loadPricing(),
    defaultApprovalMode,
    makeDeps: (meta, hooks) => {
      const tracer = createTracer(store.tracePath(meta.id));
      tracer.log("session", { id: meta.id, model: provider.model, workspace: meta.workspace });
      return {
        provider,
        tools: defaultTools,
        system: buildSystemPrompt(meta.workspace),
        workspace: meta.workspace,
        maxSteps: config.maxSteps,
        tracer,
        ...hooks,
      } satisfies AgentDeps;
    },
  };
}
