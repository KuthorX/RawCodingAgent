// D5: how much tool output the model gets to see.
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

// Keeps head and tail, since errors often appear at the end of command output.
export function truncateOutput(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const omitted = text.length - half * 2;
  return `${text.slice(0, half)}\n\n[... ${omitted} chars omitted ...]\n\n${text.slice(-half)}`;
}
