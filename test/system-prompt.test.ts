import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { buildSystemPrompt, loadProjectInstructions, MAX_PROJECT_INSTRUCTIONS_CHARS } from "../src/agent/system-prompt.ts";
import { tempWorkspace } from "./helpers.ts";

test("AGENTS.md is injected as repository instructions", () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "AGENTS.md"), "Run `npm test` before finishing.\nUse tabs.\n");
  assert.match(loadProjectInstructions(workspace)!, /Run `npm test` before finishing\.\nUse tabs\./);
  const prompt = buildSystemPrompt(workspace, ["spec"], loadProjectInstructions(workspace));
  assert.match(prompt, /Repository instructions \(AGENTS\.md\)/);
  assert.match(prompt, /Run `npm test` before finishing\./);
  assert.match(prompt, /Use tabs\.$/);
});

test("nested workspace inherits parent repository instructions", () => {
  const root = tempWorkspace();
  const workspace = join(root, "packages", "app");
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "Run root checks.");
  writeFileSync(join(workspace, "AGENTS.md"), "Use app conventions.");
  const loaded = loadProjectInstructions(workspace)!;
  assert.match(loaded, /Run root checks/);
  assert.match(loaded, /Use app conventions/);
});

test("a workspace without AGENTS.md keeps the prompt unchanged", () => {
  const workspace = tempWorkspace();
  assert.equal(loadProjectInstructions(workspace), null);
  assert.equal(buildSystemPrompt(workspace, ["spec"]), buildSystemPrompt(workspace, ["spec"], null));
  assert.doesNotMatch(buildSystemPrompt(workspace, [], null), /Repository instructions/);
});

test("an empty AGENTS.md is ignored and a huge one is truncated", () => {
  const workspace = tempWorkspace();
  writeFileSync(join(workspace, "AGENTS.md"), "  \n");
  assert.equal(loadProjectInstructions(workspace), null);
  writeFileSync(join(workspace, "AGENTS.md"), "x".repeat(MAX_PROJECT_INSTRUCTIONS_CHARS + 100));
  const loaded = loadProjectInstructions(workspace)!;
  assert.equal(loaded.length > MAX_PROJECT_INSTRUCTIONS_CHARS, true);
  assert.match(loaded, /truncated at 20000 characters/);
});
