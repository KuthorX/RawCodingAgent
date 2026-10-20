import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const run = (args, input) => execFileSync("node", ["bin/wordfreq.js", ...args], { input, encoding: "utf8" });
const text = "b a c a b a\n";

test("default: by count desc, ties alphabetical", () => {
  assert.equal(run([], text), "a 3\nb 2\nc 1\n");
});
test("--reverse: by count asc, ties alphabetical", () => {
  assert.equal(run(["--reverse"], text), "c 1\nb 2\na 3\n");
});
test("--top N limits output, combines with --reverse", () => {
  assert.equal(run(["--top", "2"], text), "a 3\nb 2\n");
  assert.equal(run(["--reverse", "--top", "1"], text), "c 1\n");
});
test("unknown flag exits non-zero", () => {
  assert.throws(() => execFileSync("node", ["bin/wordfreq.js", "--nope"], { input: "", stdio: "pipe" }));
});
