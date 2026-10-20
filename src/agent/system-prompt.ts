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
  spec:
    "If the task refers to a spec, docstring or ticket, go through it point by point and make sure every point " +
    "is implemented and checked before you finish.",
} as const;

export type PromptRule = keyof typeof PROMPT_RULES;

export function isPromptRule(name: string): name is PromptRule {
  return Object.hasOwn(PROMPT_RULES, name);
}

export function buildSystemPrompt(workspace: string, rules: readonly PromptRule[] = []): string {
  return [...BASE.map((line) => line.replace("{workspace}", () => workspace)), ...rules.map((r) => PROMPT_RULES[r])].join("\n");
}
