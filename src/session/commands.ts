import type { ApprovalMode } from "../agent/permissions.ts";
import { discoverSkills, loadSkill, type Skill } from "../agent/skills.ts";
import type { SessionRunner } from "./runner.ts";
import type { SessionMeta } from "./store.ts";

export class CommandError extends Error {}
export const BUILTIN_COMMANDS = [
  { command: "/clear", description: "切到同配置的空会话，保留旧会话" },
  { command: "/compact", description: "压缩当前会话上下文，可附加压缩重点" },
  { command: "/loop", description: "循环模式：/loop [--max N] [任务]，自动继续到计划完成" },
  { command: "/multiagent", description: "多 agent：/multiagent [on|off]，开启后可用 multi_agent 并发子 agent" },
  { command: "/plan", description: "计划模式：只读探索并给出计划，/plan off 退出" },
  { command: "/help", description: "查看命令帮助" },
  { command: "/skills", description: "列出可用技能和已加载技能" },
  { command: "/skill", description: "加载技能：/skill 名称 [任务]" },
];
const RESERVED = new Set([...BUILTIN_COMMANDS.map((c) => c.command), "/auto", "/exit"]);

export function commandCatalog(workspace: string) {
  const skills = discoverSkills(workspace);
  return {
    commands: [...BUILTIN_COMMANDS, ...skills.map((skill) => ({
      command: RESERVED.has(`/${skill.name.toLowerCase()}`) ? `/skill ${skill.name}` : `/${skill.name}`,
      description: skill.description || "加载技能",
    }))],
    skills: skills.map(({ name, description }) => ({ name, description })),
  };
}

export interface CommandResult {
  message?: string;
  session?: SessionMeta;
  task?: string;
  done?: Promise<void>;
  compacting?: boolean;
}

// GUI and CLI share command semantics; only task text is sent to the model.
export function runCommand(runner: SessionRunner, text: string, approvalMode?: ApprovalMode, skills?: Skill[]): CommandResult | null {
  if (!text.startsWith("/")) return null;
  const [, rawName, rawArgs = ""] = /^\/(\S*)(?:\s+([\s\S]*))?$/.exec(text.trim())!;
  const name = rawName!.toLowerCase();
  const args = rawArgs.trim();
  if (["clear", "help", "skills"].includes(name) && args) throw new CommandError(`/${name} 不接受参数`);
  if (name === "clear") return { session: runner.freshSession(approvalMode) };
  if (name === "compact") return { done: runner.compact(args), compacting: true };
  if (name === "plan") {
    if (args === "off" || args === "exit") {
      runner.setMode(null);
      return { message: "已退出计划模式" };
    }
    runner.setMode("plan");
    return args ? { task: args } : { message: "已进入计划模式：agent 只读探索并给出计划。点「执行计划」或发送 /plan off 退出。" };
  }
  if (name === "loop") {
    if (args === "off" || args === "stop") {
      runner.setMode(null);
      return { message: "已退出循环模式" };
    }
    const match = /^--max(?:=|\s+)(\d+)(?:\s+|$)/.exec(args);
    const max = match ? Number(match[1]) : undefined;
    if (max !== undefined && (max < 1 || max > 50)) throw new CommandError("--max 必须是 1-50 的整数");
    const task = args.slice(match?.[0].length ?? 0).trim();
    try { runner.setMode("loop", max === undefined ? {} : { max }); }
    catch (err) { throw new CommandError(err instanceof Error ? err.message : String(err)); }
    return task ? { task } : { message: "已进入循环模式：每轮结束后自动继续，直到计划完成或达到轮数上限。" };
  }
  if (name === "multiagent") {
    const enabled = args === "on" ? true : args === "off" ? false : !runner.info.multiagent;
    if (args && args !== "on" && args !== "off") throw new CommandError("/multiagent 只接受 on 或 off");
    runner.setMultiAgent(enabled);
    return { message: enabled
      ? "已开启多 agent：agent 可用 multi_agent 并发只读侦察（scout）和工作区隔离的改动（worker）。"
      : "已关闭多 agent。" };
  }
  if (name === "help") return { message: BUILTIN_COMMANDS.map((c) => `${c.command}  ${c.description}`).join("\n") +
    "\n/技能名 [任务]  加载指定技能；不带任务时不调用模型\n技能持续生效，/clear 后重置。终端另支持 /auto on|off、/exit。" };
  const available = skills ?? discoverSkills(runner.info.workspace);
  if (name === "skills" || (name === "skill" && !args)) {
    const active = new Set((runner.info.skills ?? []).map((skill) => skill.name.toLowerCase()));
    const selected = runner.info.skills?.length ? `已加载：${runner.info.skills.map((skill) => skill.name).join("、")}\n\n` : "";
    return { message: selected + (available.length ? available.map((skill) =>
      `${active.has(skill.name.toLowerCase()) ? "[已加载] " : ""}/skill ${skill.name}${skill.description ? "  " + skill.description : ""}\n  ${skill.path}`).join("\n") :
      "未发现技能。请将 SKILL.md 放在项目或用户目录的 .agents/skills/<名称>/、.codex/skills/<名称>/ 或 .claude/skills/<名称>/。") };
  }
  const [, skillName, task = ""] = name === "skill" ? /^(\S+)(?:\s+([\s\S]*))?$/.exec(args)! : ["", name, args];
  const skill = available.find((item) => item.name.toLowerCase() === skillName!.toLowerCase());
  if (!skill || (name !== "skill" && RESERVED.has(`/${name}`))) throw new CommandError(`未知命令或技能：/${rawName}。用 /help 查看命令，/skills 查看技能。`);
  runner.useSkill(loadSkill(skill));
  return task.trim() ? { task: task.trim() } : {};
}
