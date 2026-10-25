import { requireString, ToolError, type Tool } from "./types.ts";

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PlanController {
  get(): PlanItem[];
  replace(items: PlanItem[]): string;
}

export function parsePlanItems(raw: unknown): PlanItem[] {
  if (!Array.isArray(raw) || raw.length > 30) throw new ToolError('"items" must be an array with at most 30 entries');
  const items = raw.map((item, i): PlanItem => {
    if (typeof item !== "object" || item === null) throw new ToolError(`items[${i}] must be an object`);
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    const status = row.status;
    if (!text || text.length > 300) throw new ToolError(`items[${i}].text must be 1-300 characters`);
    if (status !== "pending" && status !== "in_progress" && status !== "completed") throw new ToolError(`items[${i}].status is invalid`);
    return { text, status };
  });
  if (items.filter((item) => item.status === "in_progress").length > 1) throw new ToolError("plan may have at most one in_progress item");
  return items;
}

export function planTool(controller: PlanController): Tool {
  return {
    spec: {
      name: "plan",
      description: "Create or update the short task plan. Use it for multi-step work; mark exactly one current item in_progress.",
      inputSchema: {
        type: "object",
        properties: {
          items: { type: "array", description: "Up to 30 items: {text, status} where status is pending, in_progress, or completed" },
        },
        required: ["items"],
      },
    },
    dangerous: false,
    async run(input) {
      return controller.replace(parsePlanItems(input.items));
    },
  };
}

export function planText(items: readonly PlanItem[]): string {
  if (items.length === 0) return "Plan cleared.";
  return items.map((item, i) => `${i + 1}. [${item.status}] ${item.text}`).join("\n");
}

