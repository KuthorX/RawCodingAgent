import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Runtime } from "../../app.ts";
import { runAgentTurn, toOutcome, type AgentTurn, type TaskOutcome } from "../runner.ts";
import type { Budget, CheckResult } from "../tasks.ts";
import { promptFor, type SweInstance } from "./dataset.ts";
import { collectPatch, containerBashTool, copyTestbed, removeContainer, startAgentContainer } from "./docker.ts";
import { grade } from "./grade.ts";

export interface SweAttemptOptions {
  runId: string;
  attempt: number;
  budget: Budget;
  workRoot: string; // host directory for checkouts; must be shared with Docker (the system temp dir is on macOS)
  artifactsDir: string; // patch, eval script, test log and report of this attempt
  keepWorkspace: boolean;
}

// Docker container names allow [a-zA-Z0-9_.-].
export function containerName(...parts: string[]): string {
  return parts.join("-").replace(/[^a-zA-Z0-9_.-]/g, "_");
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A harness failure after the agent finished: an "error" outcome that still carries what the turn cost.
function harnessError(turn: AgentTurn, instance: SweInstance, o: SweAttemptOptions, workspace: string, err: unknown): TaskOutcome {
  const check: CheckResult = { passed: false, exitCode: null, output: "", timedOut: false };
  const outcome = toOutcome(turn, instance.instance_id, o.attempt, workspace, o.budget, check);
  return { ...outcome, passed: false, reasons: ["error", ...outcome.reasons], error: `after the turn: ${message(err)}` };
}

// One attempt: check out the instance on the host, run the agent with its bash in the instance's container,
// then grade the resulting diff in a fresh container.
export async function runInstance(runtime: Runtime, instance: SweInstance, o: SweAttemptOptions): Promise<TaskOutcome> {
  const label = `${instance.instance_id}-${o.attempt}`;
  const workspace = join(realpathSync(o.workRoot), label);
  const agentContainer = containerName("rca-swe", o.runId, label);
  mkdirSync(workspace, { recursive: true });
  mkdirSync(o.artifactsDir, { recursive: true });
  try {
    await copyTestbed(instance.image, containerName("rca-swe-copy", o.runId, label), workspace);
    let turn: AgentTurn;
    let patch: string;
    try {
      const base = await startAgentContainer(instance.image, agentContainer, workspace);
      turn = await runAgentTurn(runtime, {
        workspace,
        title: `[swe] ${instance.instance_id} #${o.attempt}`,
        prompt: promptFor(instance),
        budget: o.budget,
        tools: (tools) => tools.map((t) => (t.spec.name === "bash" ? containerBashTool(agentContainer) : t)),
      });
      try {
        patch = await collectPatch(agentContainer, workspace, base);
      } catch (err) {
        return harnessError(turn, instance, o, workspace, err);
      }
    } finally {
      await removeContainer(agentContainer);
    }
    try {
      const check = await grade(instance, patch, o.artifactsDir, containerName("rca-swe-grade", o.runId, label));
      return toOutcome(turn, instance.instance_id, o.attempt, workspace, o.budget, check);
    } catch (err) {
      return harnessError(turn, instance, o, workspace, err);
    }
  } finally {
    if (!o.keepWorkspace) {
      try {
        rmSync(workspace, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write(`could not remove ${workspace}: ${message(err)}\n`);
      }
    }
  }
}
