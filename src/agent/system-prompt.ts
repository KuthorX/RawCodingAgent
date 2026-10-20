// D3: the system prompt. Kept deliberately minimal so you can observe what each added line changes.
export function buildSystemPrompt(workspace: string): string {
  return [
    "You are a coding agent working inside a local repository.",
    `The workspace root is ${workspace}. All relative paths resolve against it.`,
    "Use the tools to inspect files before changing them, and verify your changes (e.g. run tests) when possible.",
    "When the task is done, reply with a short summary of what you changed.",
  ].join("\n");
}
