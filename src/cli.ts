import { createInterface } from "node:readline";
import { styleText } from "node:util";
import type { Runtime } from "./app.ts";
import type { ApprovalMode } from "./agent/permissions.ts";
import { SessionRunner } from "./session/runner.ts";
import type { ToolCall } from "./types.ts";
import { describeCall, renderError, renderEvent, renderTurnEnd } from "./ui.ts";

export interface CliOptions {
  workspace: string;
  resumeId: string | undefined;
  task: string;
  forceAuto: boolean;
}

const MODE_LABEL: Record<ApprovalMode, string> = { ask: "ask (mutations need approval)", auto: "auto (everything runs without asking)" };
const HELP = "type while the agent works to interject · Ctrl-C stops the turn · /auto on|off · /exit";
const note = (text: string) => process.stdout.write(styleText("dim", text) + "\n");

export async function runCli(runtime: Runtime, options: CliOptions): Promise<void> {
  const { store } = runtime;
  const meta = options.resumeId
    ? store.getMeta(options.resumeId)
    : store.create(options.workspace, runtime.model, runtime.defaultApprovalMode);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // Lines go to a waiting approval prompt first, otherwise they are commands or messages.
  let answerApproval: ((answer: string) => void) | null = null;
  const confirm = (call: ToolCall): Promise<boolean> =>
    new Promise((resolve) => {
      process.stdout.write(styleText("yellow", `allow ${describeCall(call)}? [y/N/a=always this session] `));
      answerApproval = (answer) => {
        answerApproval = null;
        if (answer === "a") runner.setApprovalMode("auto");
        resolve(answer === "y" || answer === "a");
      };
    });
  const runner: SessionRunner = new SessionRunner({ store, meta, makeDeps: runtime.makeDeps, confirm });
  if (options.forceAuto) runner.setApprovalMode("auto");

  // Subscribe after replay so a resumed session doesn't reprint its old transcript.
  let live = false;
  runner.subscribe((event) => {
    if (!live) return;
    switch (event.type) {
      case "turn_end":
        return renderTurnEnd(event, runner.deps.tracer.path);
      case "error":
        return renderError(new Error(event.message));
      case "approval_mode":
        return note(`approval mode: ${MODE_LABEL[event.mode]}`);
      case "user":
        return event.queued ? note("(interjection queued: the agent sees it before its next step)") : undefined;
      case "interjection_delivered":
        return note(`(${event.count} interjection(s) delivered)`);
      case "output_truncated":
        return note(`(output hit max_tokens mid tool call; asked the model to retry in smaller pieces, ${event.retry})`);
      case "interjection_dropped":
        return note(`(${event.count} undelivered interjection(s) dropped)`);
      case "assistant_text":
      case "tool_call":
      case "tool_result":
        return renderEvent(event);
    }
  });
  live = true;

  process.stdout.write(`session ${meta.id}${options.resumeId ? ` (resumed, ${meta.turns} turns)` : ""}\n`);
  note(`approval mode: ${MODE_LABEL[runner.info.approvalMode]}`);

  if (options.task) {
    // Ctrl-C stops the task; a second one exits.
    process.removeAllListeners("SIGINT");
    process.once("SIGINT", () => {
      runner.stop();
      process.once("SIGINT", () => process.exit(130));
    });
    rl.close();
    await runner.send(options.task).done;
    return;
  }

  process.stdout.write(`${runtime.model} · workspace ${meta.workspace}\n`);
  note(HELP);
  const prompt = () => {
    if (!runner.isBusy) rl.prompt();
  };
  runner.subscribe((event) => {
    if (live && (event.type === "turn_end" || event.type === "error")) setImmediate(prompt);
  });

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
    // Ctrl-C: stop the running turn; when idle, exit.
    rl.on("SIGINT", () => {
      if (answerApproval) answerApproval("n");
      if (!runner.stop()) rl.close();
    });
    rl.on("line", (raw) => {
      const input = raw.trim();
      if (answerApproval) return answerApproval(input.toLowerCase());
      if (input === "/exit") return rl.close();
      if (input === "/auto on" || input === "/auto off") {
        runner.setApprovalMode(input === "/auto on" ? "auto" : "ask");
        return prompt();
      }
      if (input.startsWith("/")) {
        note(HELP);
        return prompt();
      }
      if (input) runner.send(input);
      else prompt();
    });
    prompt();
  });
  runner.stop();
  await runner.whenIdle();
}
