import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

// D3: the system prompt. Kept deliberately minimal so you can observe what each added line changes.
const BASE = [
  "You are a coding agent working inside a local repository.",
  "The workspace root is {workspace}. All relative paths resolve against it.",
  "Use the tools to inspect files before changing them, and verify your changes (e.g. run tests) when possible.",
  "When the task is done, reply with a short summary of what you changed.",
];

// Optional rules for prompt experiments, switched on with AGENT_PROMPT_RULES=debug,spec (comma-separated).
// Each targets a failure seen in the eval; add one at a time and compare runs to see what it changes.
export const PROMPT_RULES = {
  debug:
    "When something fails unexpectedly, re-read the code you just wrote and question your own assumptions first; " +
    "only suspect the environment, the language or its libraries after ruling out your own code.",
  efficient:
    "Work efficiently: combine related reads into one command, don't re-run the same check without changing something, " +
    "and finish as soon as the task is done and verified.",
  // Seen in GUI sessions: ~3/4 of bash calls were sed -n / cat / grep / find or Python scripts editing files,
  // even with the dedicated tools available.
  tools:
    "Use the dedicated tools for files: read_file (with offset/limit for part of a long file) to read, grep and glob to search, " +
    "edit_file (with edits for several changes) to change and write_file to create. Use bash to run programs, tests and git, " +
    "not to read, search or edit files.",
  spec:
    "If the task refers to a spec, docstring or ticket, go through it point by point and make sure every point " +
    "is implemented and checked before you finish.",
} as const;

export type PromptRule = keyof typeof PROMPT_RULES;

export function isPromptRule(name: string): name is PromptRule {
  return Object.hasOwn(PROMPT_RULES, name);
}

// D14: instructions the repository itself carries. Read once per session (they are part of the system prompt, so
// changing the file mid-session would break the prompt cache and surprise the model). Bounded, because a huge file
// should not crowd out the task.
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 20_000;
export const PROJECT_INSTRUCTION_FILES = ["AGENTS.md", "agents.md"] as const;

export function loadProjectInstructions(workspace: string): string | null {
  const found: string[] = [];
  const dirs: string[] = [];
  for (let dir = resolve(workspace); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dirname(dir) === dir) break;
  }
  for (const dir of dirs) {
    for (const name of PROJECT_INSTRUCTION_FILES) {
      const path = resolve(dir, name);
      try {
        if (!statSync(path).isFile()) continue;
        const text = readFileSync(path, "utf8").trim();
        if (text) found.push(`### ${path}\n${text}`);
        break;
      } catch {
        // Missing or unreadable: try the next spelling.
      }
    }
  }
  if (found.length === 0) return null;
  const text = found.join("\n\n");
  return text.length <= MAX_PROJECT_INSTRUCTIONS_CHARS
    ? text
    : `${text.slice(0, MAX_PROJECT_INSTRUCTIONS_CHARS)}\n[... repository instructions truncated at ${MAX_PROJECT_INSTRUCTIONS_CHARS} characters]`;
}

export function buildSystemPrompt(workspace: string, rules: readonly PromptRule[] = [], projectInstructions: string | null = null): string {
  const lines = BASE.map((line) => line.replace("{workspace}", () => workspace));
  lines.push(...rules.map((r) => PROMPT_RULES[r]));
  // Last, so repository-specific conventions can refine the generic rules above.
  if (projectInstructions) lines.push(`## Repository instructions (AGENTS.md)\n${projectInstructions}`);
  return lines.join("\n");
}
