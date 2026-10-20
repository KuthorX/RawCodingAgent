import { parseArgs } from "node:util";
import { createRuntime } from "./app.ts";
import { runCli } from "./cli.ts";
import { generateToken } from "./gui/http.ts";
import { SessionManager } from "./gui/manager.ts";
import { createGuiServer, listen } from "./gui/server.ts";
import { renderError } from "./ui.ts";

const DEFAULT_PORT = 4317;

const USAGE = `usage:
  npm start -- [--cwd <dir>] [--yes] [--resume <id>] [task]   terminal mode
  npm run gui -- [--cwd <dir>] [--yes] [--port <n>]           web UI
  --cwd <dir>     workspace (added to the saved workspace list); terminal default: current directory
  --yes           new sessions (and a --resume'd one) auto-approve bash; switchable per session later
  --resume <id>   continue a stored session (ids are listed in the web UI and .sessions/)
  task            run once and exit; omit for interactive mode (/exit)`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      yes: { type: "boolean", default: false },
      resume: { type: "string" },
      gui: { type: "boolean", default: false },
      port: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE + "\n");
    return;
  }

  const runtime = createRuntime(values.yes ? "auto" : "ask");
  // Every workspace used is remembered, so the GUI can offer it next time without --cwd.
  const workspace = values.cwd === undefined ? undefined : runtime.projects.add(values.cwd).path;

  if (!values.gui) {
    const task = positionals.join(" ").trim();
    const cwd = workspace ?? (values.resume ? process.cwd() : runtime.projects.add(process.cwd()).path);
    await runCli(runtime, { workspace: cwd, resumeId: values.resume, task, forceAuto: values.yes });
    return;
  }

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port must be 0-65535, got "${values.port}"`);
  const token = generateToken();
  const actual = await listen(createGuiServer(new SessionManager(runtime), token), port);
  process.stdout.write(`raw-coding-agent GUI: http://127.0.0.1:${actual}/?token=${token}\n`);
}

// Turn Ctrl-C / kill into a normal exit so "exit" handlers (session lock release) run.
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

main().catch((err: unknown) => {
  renderError(err);
  process.exitCode = 1;
});
