import { bashTool } from "./bash.ts";
import { editFileTool } from "./edit-file.ts";
import { readFileTool } from "./read-file.ts";
import type { Tool } from "./types.ts";
import { writeFileTool } from "./write-file.ts";

export const defaultTools: readonly Tool[] = [readFileTool, writeFileTool, editFileTool, bashTool];

export type { Tool, ToolContext } from "./types.ts";
export { ToolError } from "./types.ts";
