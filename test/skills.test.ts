import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { discoverSkills, loadSkill, MAX_SKILL_BYTES, skillRoots } from "../src/agent/skills.ts";
import { tempWorkspace } from "./helpers.ts";

function writeSkill(root: string, directory: string, content: string): string {
  const dir = join(root, directory);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, content);
  return path;
}

test("discovers metadata, nested packages and nearest-name precedence without following symlink cycles", () => {
  const root = tempWorkspace();
  const local = join(root, "local");
  const global = join(root, "global");
  const path = writeSkill(local, "review", '---\nname: "review"\ndescription: >-\n  Check changes\n  with evidence.\n---\nReview locally.');
  writeSkill(global, "review", "---\nname: review\n---\nGlobal rules.");
  writeSkill(local, "bundle", "---\nname: bundle\n---\nRoot skill.");
  writeSkill(local, "bundle/skills/child", "---\r\nname: child\r\ndescription: 'Check ''quotes'''\r\n---\r\nChild rules.");
  writeSkill(local, "plain", "Plain instructions.");
  writeSkill(local, "invalid", "---\nname: ../../secret\n---\nInvalid.");
  symlinkSync(local, join(local, "cycle"), process.platform === "win32" ? "junction" : "dir");
  symlinkSync(join(local, "plain"), join(local, "alias"), process.platform === "win32" ? "junction" : "dir");
  const skills = discoverSkills(root, [local, global]);
  assert.deepEqual(skills.map((s) => s.name), ["bundle", "child", "plain", "review"]);
  assert.equal(skills.find((s) => s.name === "review")?.description, "Check changes with evidence.");
  assert.equal(skills.find((s) => s.name === "child")?.description, "Check 'quotes'");
  assert.match(loadSkill(skills.find((s) => s.name === "review")!).content, /Review locally/);
  assert.equal(skills.find((s) => s.name === "review")?.path, realpathSync(path));
});

test("workspace and ancestor roots precede user roots", () => {
  const root = tempWorkspace();
  const workspace = join(root, "packages", "app");
  const home = join(root, "user");
  const roots = skillRoots(workspace, home);
  assert.equal(roots[0], join(workspace, ".agents", "skills"));
  assert.ok(roots.indexOf(join(root, ".codex", "skills")) < roots.indexOf(join(home, ".codex", "skills")));
  assert.equal(new Set(roots).size, roots.length);
});

test("loading rejects deleted, empty and oversized files rather than silently truncating instructions", () => {
  const root = tempWorkspace();
  const path = writeSkill(root, "sample", "Follow these rules.");
  const skill = discoverSkills(root, [root])[0]!;
  writeFileSync(path, " ");
  assert.throws(() => loadSkill(skill), /为空/);
  writeFileSync(path, "x".repeat(MAX_SKILL_BYTES + 1));
  assert.throws(() => loadSkill(skill), /超过/);
  rmSync(path);
  assert.throws(() => loadSkill(skill), /无法读取/);
});
