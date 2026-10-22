import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isApprovalMode, type ApprovalMode } from "../agent/permissions.ts";

// Preferences of the web UI, kept in one JSON file next to .projects.json.
export interface GuiSettings {
  // Approval mode the "+ 会话" buttons give a new session.
  newSessionApproval: ApprovalMode;
  defaultModel: string;
  notifications: boolean;
  compactionTokens: number;
}

export class SettingsStore {
  private readonly file: string;
  private readonly defaultModel: string;

  constructor(file: string, defaultModel = "deepseek-chat") {
    this.file = file;
    this.defaultModel = defaultModel;
  }

  get(): GuiSettings {
    const defaults: GuiSettings = { newSessionApproval: "auto", defaultModel: this.defaultModel, notifications: false, compactionTokens: 400_000 };
    if (!existsSync(this.file)) return { ...defaults };
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<GuiSettings>;
      return {
        newSessionApproval: isApprovalMode(saved.newSessionApproval) ? saved.newSessionApproval : defaults.newSessionApproval,
        defaultModel: typeof saved.defaultModel === "string" && saved.defaultModel.trim() ? saved.defaultModel.trim() : defaults.defaultModel,
        notifications: saved.notifications === true,
        compactionTokens: Number.isInteger(saved.compactionTokens) && (saved.compactionTokens as number) >= 0 ? saved.compactionTokens as number : defaults.compactionTokens,
      };
    } catch {
      return { ...defaults };
    }
  }

  update(patch: Partial<GuiSettings>): GuiSettings {
    const next = { ...this.get(), ...patch };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
    return next;
  }
}
