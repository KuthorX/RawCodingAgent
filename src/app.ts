import { resolve } from "node:path";
import type { AgentDeps } from "./agent/loop.ts";
import type { ApprovalMode } from "./agent/permissions.ts";
import { buildSystemPrompt, loadProjectInstructions, type PromptRule } from "./agent/system-prompt.ts";
import { createTracer } from "./agent/trace.ts";
import { loadConfig, loadDotEnv, sanitizeToolEnv } from "./config.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { loadPricing, type Pricing } from "./pricing.ts";
import type { RunnerOptions } from "./session/runner.ts";
import { SessionStore } from "./session/store.ts";
import { SettingsStore } from "./gui/settings.ts";
import { ProjectStore } from "./workspace/store.ts";
import { defaultTools } from "./tools/index.ts";
import { webFetchTool } from "./tools/web-fetch.ts";
import { searchBackendFromEnv, webSearchTool } from "./tools/web-search.ts";
import { planTool } from "./tools/plan.ts";
import { delegateTool } from "./tools/delegate.ts";

export const PROJECT_ROOT = resolve(import.meta.dirname, "..");

export interface Runtime {
  store: SessionStore;
  projects: ProjectStore;
  settings: SettingsStore;
  model: string;
  contextWindow: (model: string) => number;
  listModels?: () => Promise<string[]>;
  pricing: Pricing;
  promptRules: readonly PromptRule[];
  // Turn guards from .env; a session's own limits override them (see SessionRunner.turnDeps).
  limits: { maxSteps: number | null; maxTurnCostUsd: number | null };
  // Mode given to newly created sessions (--yes => "auto"); each session can change its own later.
  defaultApprovalMode: ApprovalMode;
  makeDeps: RunnerOptions["makeDeps"];
}

// Shared by the CLI and the GUI: config, provider, session storage, and per-session agent wiring.
export interface RuntimeOptions {
  // Where sessions are stored; the eval keeps its sessions next to each run's results instead of in the GUI list.
  sessionsDir?: string;
  // web_search is added when a search key is configured; the eval turns it off so runs stay offline and comparable.
  webSearch?: boolean;
  // Where .projects.json / .worktrees.json / .settings.json live (default: the project root). Tests point it elsewhere.
  dataDir?: string;
}

export function createRuntime(defaultApprovalMode: ApprovalMode, options: RuntimeOptions = {}): Runtime {
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const config = loadConfig();
  const provider = new OpenAIProvider(config.llm);
  const store = new SessionStore(options.sessionsDir ?? resolve(PROJECT_ROOT, ".sessions"));
  const pricing = loadPricing();
  const dataDir = options.dataDir ?? PROJECT_ROOT;
  const backend = options.webSearch === false ? null : searchBackendFromEnv(process.env);
  const webSearch = backend ? webSearchTool(backend) : null;
  // Eval runs offline: webSearch: false removes web_fetch too, so no result depends on the network.
  const webTools = options.webSearch === false ? [] : [webFetchTool, ...(webSearch ? [webSearch] : [])];
  const toolEnv = sanitizeToolEnv(process.env);
  delete process.env.TAVILY_API_KEY;

  return {
    store,
    // .workspaces.json is the list from before projects had worktrees; it becomes .projects.json.
    projects: new ProjectStore(resolve(dataDir, ".projects.json"), resolve(dataDir, ".worktrees.json"), resolve(dataDir, ".workspaces.json")),
    settings: new SettingsStore(resolve(dataDir, ".settings.json"), provider.model),
    model: provider.model,
    contextWindow: (model) => config.contextWindows[model] ?? 64_000,
    listModels: () => provider.listModels(),
    pricing,
    promptRules: config.promptRules,
    limits: { maxSteps: config.maxSteps, maxTurnCostUsd: config.maxTurnCostUsd },
    defaultApprovalMode,
    makeDeps: (meta, hooks) => {
      const tracer = createTracer(store.tracePath(meta.id));
      // D14: repository conventions ride along with the system prompt. Logged below, so the trace shows exactly
      // which revision of AGENTS.md the model saw.
      const system = buildSystemPrompt(meta.workspace, config.promptRules, loadProjectInstructions(meta.workspace));
      const tools = [...defaultTools, ...webTools, ...(hooks.plan ? [planTool(hooks.plan)] : []), ...(hooks.delegateTask ? [delegateTool(hooks.delegateTask)] : [])];
      // Logged every time a session is (re)loaded: a process started before a prompt change keeps the old prompt,
      // so this is the only reliable record of what the model was actually told.
      tracer.log("session", {
        id: meta.id,
        model: provider.model,
        workspace: meta.workspace,
        promptRules: config.promptRules,
        tools: tools.map((t) => t.spec.name),
        system,
      });
      return {
        provider: new OpenAIProvider({ ...config.llm, model: meta.model }),
        tools,
        system,
        workspace: meta.workspace,
        toolEnv,
        maxSteps: config.maxSteps ?? Infinity,
        maxTurnCostUsd: config.maxTurnCostUsd,
        maxRepeats: config.maxRepeats,
        pricing,
        tracer,
        ...hooks,
      } satisfies AgentDeps;
    },
  };
}
