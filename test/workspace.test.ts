import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeWorkspacePath, WorkspaceStore } from "../src/workspace/store.ts";
import { tempWorkspace } from "./helpers.ts";

test("workspace store adds, dedupes, persists and removes", () => {
  const root = tempWorkspace();
  const repo = join(root, "my-repo");
  mkdirSync(repo);
  const file = join(root, "workspaces.json");
  const store = new WorkspaceStore(file);

  const added = store.add(repo);
  assert.equal(added.name, "my-repo");
  assert.equal(store.add(repo + "/").addedAt, added.addedAt);
  assert.equal(new WorkspaceStore(file).list().length, 1);
  assert.throws(() => store.add(join(root, "missing")), /not a directory/);
  assert.equal(store.remove(repo), true);
  assert.equal(store.remove(repo), false);
  assert.deepEqual(store.list(), []);
});

test("a corrupt workspace file reads as empty", () => {
  const file = join(tempWorkspace(), "workspaces.json");
  writeFileSync(file, "{not json");
  assert.deepEqual(new WorkspaceStore(file).list(), []);
});

test("~ expands to the home directory", () => {
  assert.equal(normalizeWorkspacePath("~"), homedir());
  assert.equal(normalizeWorkspacePath("~/x"), join(homedir(), "x"));
});
