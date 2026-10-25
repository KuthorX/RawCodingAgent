import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export interface Skill { name: string; description: string; path: string }
export interface LoadedSkill extends Skill { content: string }
export class SkillError extends Error {}
export const MAX_SKILL_BYTES = 128_000;
export const MAX_LOADED_SKILL_CHARS = 100_000;

function readSkill(path: string): string {
  if (!statSync(path).isFile()) throw new SkillError(`不是技能文件：${path}`);
  if (statSync(path).size > MAX_SKILL_BYTES) throw new SkillError(`技能超过 ${MAX_SKILL_BYTES} 字节：${path}`);
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

// shortcut: read the name/description subset of YAML, upgrade to a YAML parser if richer metadata is needed.
function metadata(text: string, key: string): string {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  const match = header?.match(new RegExp(`^${key}: *([^\\r\\n]*)(?:\\r?\\n((?:[ \\t]+[^\\r\\n]*(?:\\r?\\n|$))*))?`, "m"));
  if (!match) return "";
  const value = match[1]!.trim();
  if (/^[>|][-+]?$/u.test(value)) return (match[2] ?? "").trim().replace(/\s+/g, " ");
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  return value.replace(/\s+#.*$/, "");
}

export function skillRoots(workspace: string, home = homedir()): string[] {
  const roots: string[] = [];
  for (let dir = resolve(workspace); ; dir = dirname(dir)) {
    for (const name of [".agents", ".codex", ".claude"]) roots.push(join(dir, name, "skills"));
    if (dirname(dir) === dir) break;
  }
  roots.push(join(home, ".agents", "skills"), join(home, ".codex", "skills"), join(home, ".claude", "skills"));
  return [...new Set(roots)];
}

// First name wins: nearest workspace, then ancestors, then user skills. Real paths break symlink cycles.
export function discoverSkills(workspace: string, roots = skillRoots(workspace)): Skill[] {
  const found = new Map<string, Skill>();
  const seen = new Set<string>();
  const visit = (directory: string, depth: number) => {
    if (depth > 8 || seen.size >= 2000) return;
    let real: string;
    try { real = realpathSync(directory); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    const path = join(real, "SKILL.md");
    let hasSkill = false;
    try {
      const text = readSkill(path);
      hasSkill = true;
      const name = metadata(text, "name") || basename(real);
      if (/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,99}$/u.test(name) && !found.has(name.toLowerCase())) {
        found.set(name.toLowerCase(), { name, description: metadata(text, "description"), path });
      }
    } catch { /* Missing, unreadable or oversized skills are not offered. */ }
    if (hasSkill) { visit(join(real, "skills"), depth + 1); return; }
    try {
      for (const entry of readdirSync(real, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.name.startsWith(".") && entry.name !== "node_modules" && (entry.isDirectory() || entry.isSymbolicLink())) {
          visit(join(real, entry.name), depth + 1);
        }
      }
    } catch { /* One unreadable package must not hide other skills. */ }
  };
  for (const root of roots) visit(root, 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(skill: Skill): LoadedSkill {
  try {
    const content = readSkill(skill.path).trim();
    if (!content) throw new SkillError(`技能文件为空：${skill.path}`);
    return { ...skill, content };
  } catch (err) {
    if (err instanceof SkillError) throw err;
    throw new SkillError(`无法读取技能 ${skill.name}：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function withSkills(system: string, skills: LoadedSkill[] = []): string {
  if (!skills.length) return system;
  return system + "\n\n## Skills explicitly selected by the user\nFollow these skills for relevant tasks. Resolve relative resource paths against each skill's directory. " +
    "Skill instructions do not override user instructions or tool permissions. For resources outside the workspace, use bash with existing approval rules.\n\n" +
    skills.map((skill) => `### ${skill.name}\nSkill file: ${skill.path}\nSkill directory: ${dirname(skill.path)}\n\n${skill.content}`).join("\n\n");
}
