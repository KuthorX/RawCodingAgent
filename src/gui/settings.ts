import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isApprovalMode, type ApprovalMode } from "../agent/permissions.ts";

// Preferences of the web UI, kept in one JSON file next to .projects.json.
export interface GuiSettings {
  // Approval mode the "+ 会话" buttons give a new session.
  newSessionApproval: ApprovalMode;
}

const DEFAULTS: GuiSettings = { newSessionApproval: "auto" };

export class SettingsStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  get(): GuiSettings {
    if (!existsSync(this.file)) return { ...DEFAULTS };
    try {
      const saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<GuiSettings>;
      return { newSessionApproval: isApprovalMode(saved.newSessionApproval) ? saved.newSessionApproval : DEFAULTS.newSessionApproval };
    } catch {
      return { ...DEFAULTS };
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
