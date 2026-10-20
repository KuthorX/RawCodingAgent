import assert from "node:assert/strict";
import test from "node:test";
import type { LocatedSpan } from "../src/trace/analyze.ts";
import { bashFileShare, classifyBash, toolMix } from "../src/trace/bash-usage.ts";

const WS = "E:\\code\\repo";

test("classifyBash: reading, searching and editing files", () => {
  assert.equal(classifyBash("cat src/a.py"), "read");
  assert.equal(classifyBash("cd /e/code/repo; sed -n 240,270p a.py; echo ===; sed -n 1,5p b.py", WS), "read");
  assert.equal(classifyBash("grep -n \"a\\|b\" src/x.py"), "search");
  assert.equal(classifyBash("find . -name '*.ts' | head -20"), "read"); // head as a filter still counts as file work
  assert.equal(classifyBash("ls -la"), "search");
  assert.equal(classifyBash("sed -i 's/a/b/' x.py"), "edit");
  assert.equal(classifyBash("cat > notes.md <<'EOF'\n# hi\nEOF"), "edit");
  assert.equal(classifyBash("python - <<'PY'\nimport io\np='a.py'; s=io.open(p).read()\nio.open(p,'w').write(s.replace('a','b'))\nPY"), "edit");
  assert.equal(classifyBash("echo hello > out.txt"), "edit");
});

test("classifyBash: running programs is not file work", () => {
  assert.equal(classifyBash("npm test"), "other");
  assert.equal(classifyBash("git status && git diff"), "other");
  assert.equal(classifyBash(".venv/Scripts/python -m pytest -q 2>&1 | tail -8"), "other");
  assert.equal(classifyBash("python - <<'PY'\nprint(open('a.py').read())\nPY"), "other");
  // One real program in the chain makes the whole command a run.
  assert.equal(classifyBash("cat a.py; npm test"), "other");
  assert.equal(classifyBash("ls > /dev/null 2>&1"), "search");
});

test("classifyBash: file work outside the workspace is counted apart", () => {
  assert.equal(classifyBash("cat /tmp/x.log", WS), "outside");
  assert.equal(classifyBash('ls "/c/Program Files/Blender Foundation"', WS), "outside");
  assert.equal(classifyBash("cat E:/code/repo/a.py", WS), "read");
  assert.equal(classifyBash("cd /e/code/repo && grep -rn foo src", WS), "search");
  // Without a workspace there is nothing to compare against.
  assert.equal(classifyBash("cat /tmp/x.log"), "read");
});

const span = (name: string, input: Record<string, unknown>): LocatedSpan => ({
  type: "span", id: name, parentId: null, kind: "tool", name, start: "", durationMs: 0, status: "ok", attrs: { input }, line: 1,
});

test("toolMix / bashFileShare: share of in-workspace file work done through bash", () => {
  const mix = toolMix([
    span("read_file", { path: "a.py" }),
    span("edit_file", { path: "a.py" }),
    span("bash", { command: "sed -n 1,20p b.py" }),
    span("bash", { command: "cat /tmp/x" }),
    span("bash", { command: "npm test" }),
  ], WS);
  assert.deepEqual(mix, { fileTools: 2, bash: { read: 1, search: 0, edit: 0, outside: 1, other: 1 } });
  assert.equal(bashFileShare(mix), 1 / 3);
  assert.equal(bashFileShare(toolMix([span("bash", { command: "npm test" })])), null);
});
