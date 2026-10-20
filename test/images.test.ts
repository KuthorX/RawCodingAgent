import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { toOpenAIMessages } from "../src/providers/openai.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { Message } from "../src/types.ts";
import { reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex"); // just the signature; nothing decodes it here

test("provider: images go as data URLs with vision, as file paths without", () => {
  const path = join(tempWorkspace(), "a.png");
  writeFileSync(path, PNG);
  const messages: Message[] = [{ role: "user", content: "what is this", images: [{ path, mediaType: "image/png" }] }];

  const [, withVision] = toOpenAIMessages("sys", messages, true);
  assert.deepEqual(withVision.content, [
    { type: "text", text: "what is this" },
    { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } },
  ]);
  const [, textOnly] = toOpenAIMessages("sys", messages, false);
  assert.equal(typeof textOnly.content, "string");
  assert.match(textOnly.content as string, /^what is this\n\n\[The user attached 1 image\(s\)\. This model cannot view images.*\n- .*a\.png\]$/s);
  // A deleted attachment doesn't break the request.
  const [, missing] = toOpenAIMessages("sys", [{ role: "user", content: "", images: [{ path: path + "x", mediaType: "image/png" }] }], true);
  assert.match(JSON.stringify(missing.content), /attached image missing/);
});

test("config: OPENAI_VISION turns image input on", () => {
  assert.equal(loadConfig({ OPENAI_API_KEY: "k" }).llm.vision, false);
  assert.equal(loadConfig({ OPENAI_API_KEY: "k", OPENAI_VISION: "true" }).llm.vision, true);
});

test("runner: attached images reach the model, events name them, and a fork gets its own copies", async () => {
  const provider = new ScriptedProvider([reply("a cat")]);
  const runtime = testRuntime(provider);
  const { store } = runtime;
  const meta = store.create("/tmp", "m");
  const saved = store.saveAttachment(meta.id, PNG, "image/png");
  const runner = new SessionRunner({ store, meta, makeDeps: runtime.makeDeps });
  await runner.send("", [saved]).done;

  const sent = provider.requests[0]!.messages[0]!;
  assert.deepEqual(sent, { role: "user", content: "", images: [{ path: saved.path, mediaType: "image/png" }] });
  assert.deepEqual(store.loadEvents(meta.id)[0], { type: "user", text: "", images: [saved.name] });
  assert.equal(store.getMeta(meta.id).title, "（图片）");

  const fork = store.fork(meta.id);
  const forkedPath = (store.loadMessages(fork.id)[0] as Extract<Message, { role: "user" }>).images![0]!.path;
  assert.notEqual(forkedPath, saved.path);
  assert.equal(forkedPath, store.attachmentPath(fork.id, saved.name));
  assert.deepEqual(readFileSync(forkedPath), PNG);
  assert.ok(existsSync(saved.path));
});

test("runner: images can't be sent as an interjection", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const provider = { name: "slow", model: "slow", complete: async () => { await gate; return reply("done"); } };
  const runtime = testRuntime(provider);
  const meta = runtime.store.create("/tmp", "m");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const { done } = runner.send("start");
  const img = runtime.store.saveAttachment(meta.id, PNG, "image/png");
  assert.throws(() => runner.send("look", [img]), /图片要等这一轮结束/);
  release();
  await done;
});

test("store: attachment names are validated", () => {
  const { store } = testRuntime(new ScriptedProvider([]));
  const meta = store.create("/tmp", "m");
  assert.throws(() => store.attachmentPath(meta.id, "../meta.json"), /invalid attachment name/);
  assert.throws(() => store.saveAttachment(meta.id, PNG, "image/svg+xml"), /unsupported image type/);
});
