import { createInterface } from "node:readline";
import { styleText } from "node:util";
import type { Runtime } from "./app.ts";
import type { ApprovalMode } from "./agent/permissions.ts";
import { SessionRunner } from "./session/runner.ts";
import { commandCatalog, runCommand } from "./session/commands.ts";
import type { SessionMeta } from "./session/store.ts";
import type { ToolCall } from "./types.ts";
import { describeCall, renderError, renderEvent, renderTurnEnd } from "./ui.ts";

export interface CliOptions {
  workspace: string;
  resumeId: string | undefined;
  task: string;
  forceAuto: boolean;
}

const MODE_LABEL: Record<ApprovalMode, string> = { ask: "ask (mutations need approval)", auto: "auto (everything runs without asking)" };
const HELP = "type while the agent works to interject · Tab completes commands · Ctrl-C stops the turn · /help · /auto on|off · /exit";
const note = (text: string) => process.stdout.write(styleText("dim", text) + "\n");

export async function runCli(runtime: Runtime, options: CliOptions): Promise<void> {
  const { store } = runtime;
  let meta = options.resumeId
    ? store.getMeta(options.resumeId)
    : store.create(options.workspace, runtime.settings.get().defaultModel, runtime.defaultApprovalMode);
  if (!options.resumeId) {
    const defaults = runtime.settings.get();
    meta = store.updateMeta(meta.id, { provider: defaults.defaultProvider, thinkEffort: defaults.defaultThinkEffort });
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, completer: (line: string) => {
    const catalog = commandCatalog(meta.workspace);
    const candidates = /^\/skill\s/i.test(line)
      ? catalog.skills.map((s) => `/skill ${s.name}`)
      : [...catalog.commands.map((c) => c.command), "/auto on", "/auto off", "/exit"];
    return [candidates.filter((command) => command.toLowerCase().startsWith(line.toLowerCase())), line];
  } });
  let closed = false;
  rl.on("close", () => { closed = true; });

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
  const makeRunner = (meta: SessionMeta): SessionRunner => new SessionRunner({ store, meta, makeDeps: runtime.makeDeps, confirm, contextWindow: (session) => runtime.contextWindow(session.model, session.provider), makeProvider: runtime.makeProvider });
  let runner = makeRunner(meta);
  if (options.forceAuto) runner.setApprovalMode("auto");

  // Subscribe after replay so a resumed session doesn't reprint its old transcript.
  let live = false;
  const observe = () => runner.subscribe((event) => {
    if (!live) return;
    switch (event.type) {
      case "turn_end":
        return renderTurnEnd(event, runner.deps.tracer.path);
      case "error":
        return renderError(new Error(event.message));
      case "approval_mode":
        return note(`approval mode: ${MODE_LABEL[event.mode]}`);
      case "skill_loaded":
        return note(`已加载技能 ${event.name} · ${event.path}`);
      case "compacted":
        return note(`上下文已压缩：${event.beforeTokens} → ${event.afterTokens} token`);
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
  observe();
  live = true;

  const submit = async (input: string) => {
    const result = runCommand(runner, input);
    if (!result) return runner.send(input).done;
    if (result.message) note(result.message);
    if (result.session) {
      const next = makeRunner(result.session);
      live = false;
      runner.close();
      runner = next;
      meta = result.session;
      observe();
      live = true;
      note(`上下文已清空 · session ${meta.id} · 旧会话保留`);
    }
    if (result.task) return runner.send(result.task).done;
    return result.done;
  };

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
    await submit(options.task);
    runner.close();
    return;
  }

  process.stdout.write(`${runner.info.provider ?? "legacy"}/${runner.info.model} · thinking ${runner.info.thinkEffort ?? "off"} · workspace ${meta.workspace}\n`);
  note(HELP);
  const prompt = () => {
    if (!closed && !runner.isBusy) rl.prompt();
  };

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
      if (input) void submit(input).catch(renderError).finally(prompt);
      else prompt();
    });
    prompt();
  });
  runner.stop();
  await runner.whenIdle();
  runner.close();
}
