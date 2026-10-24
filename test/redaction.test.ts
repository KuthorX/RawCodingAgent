import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTracer, redactText } from "../src/agent/trace.ts";
import { tempWorkspace } from "./helpers.ts";

test("known credential shapes are redacted", () => {
  assert.match(redactText("OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz"), /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(redactText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"), /Bearer \[REDACTED\]/);
  assert.match(redactText("token tvly-abcdefghijklmn"), /tvly-\[REDACTED\]/);
  assert.match(redactText('{"apiKey":"sk-abcdefghijklmnopqrstuvwxyz"}'), /\[REDACTED\]/);
  assert.doesNotMatch(redactText("sk-abcdefghijklmnopqrstuvwxyz"), /abcdefghijklmnop/);
});

test("trace files do not contain credentials from tool output", () => {
  const workspace = tempWorkspace();
  const path = join(workspace, "trace.jsonl");
  const tracer = createTracer(path);
  tracer.log("response", { text: "OPENAI_API_KEY=sk-livekey1234567890abcdef\nSECRET_TOKEN=abc1234567890xyz" });
  const content = readFileSync(path, "utf8");
  assert.doesNotMatch(content, /livekey1234567890abcdef/);
  assert.doesNotMatch(content, /abc1234567890xyz/);
  assert.match(content, /REDACTED/);
});
