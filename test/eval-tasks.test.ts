import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { PROJECT_ROOT } from "../src/app.ts";
import { copyRepo, loadTasks, overlay, runCheck } from "../src/eval/tasks.ts";
import { tempWorkspace } from "./helpers.ts";

const tasks = loadTasks(join(PROJECT_ROOT, "eval", "tasks"));

test("eval suite has tasks of every difficulty", () => {
  assert.ok(tasks.length >= 10);
  for (const d of ["easy", "medium", "hard"]) assert.ok(tasks.some((t) => t.difficulty === d), d);
});

// A task is only meaningful if the untouched repo fails the check and the reference solution passes it.
for (const task of tasks) {
  test(`eval task ${task.id}: original fails, solution passes`, async () => {
    const original = tempWorkspace();
    copyRepo(task, original);
    overlay(task, "check", original);
    const before = await runCheck(task, original);
    assert.equal(before.passed, false, `original repo should fail:\n${before.output}`);

    const solved = tempWorkspace();
    copyRepo(task, solved);
    overlay(task, "solution", solved);
    overlay(task, "check", solved);
    const after = await runCheck(task, solved);
    assert.equal(after.passed, true, `solution should pass:\n${after.output}`);
  });
}
