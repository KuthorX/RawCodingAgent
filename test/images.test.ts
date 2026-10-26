import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";
import { toOpenAIMessages } from "../src/providers/openai.ts";
import { SessionRunner } from "../src/session/runner.ts";
import type { SessionEvent } from "../src/session/events.ts";
import type { Message } from "../src/types.ts";
import { ManualProvider, reply, ScriptedProvider, tempWorkspace, testRuntime } from "./helpers.ts";

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

test("runner: an interjection can carry images, delivered at the next step", async () => {
  const provider = new ManualProvider();
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const events: SessionEvent[] = [];
  runner.subscribe((e) => events.push(e));
  const { done } = runner.send("start");
  await provider.requested(1);
  const img = runtime.store.saveAttachment(meta.id, PNG, "image/png");
  assert.equal(runner.send("", [img]).queued, true);
  assert.deepEqual(events.at(-1), { type: "user", text: "", queued: true, images: [img.name] });
  provider.respond(reply("", [{ id: "a", name: "write_file", input: { path: "x.txt", content: "x" } }]));
  await provider.requested(2);
  assert.deepEqual(provider.requests[1]!.messages.at(-1), { role: "user", content: "[User interjection]\n", images: [{ path: img.path, mediaType: "image/png" }] });
  provider.respond(reply("ok"));
  await done;
});

test("runner: late interjections with images merge into the next turn", async () => {
  const provider = new ManualProvider();
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const { done } = runner.send("start");
  await provider.requested(1);
  const a = runtime.store.saveAttachment(meta.id, PNG, "image/png");
  const b = runtime.store.saveAttachment(meta.id, PNG, "image/png");
  runner.send("first", [a]);
  runner.send("", [b]);
  provider.respond(reply("done")); // the turn ends without another step, so they start the next one
  await provider.requested(2);
  assert.deepEqual(provider.requests[1]!.messages.at(-1), {
    role: "user",
    content: "first",
    images: [a, b].map(({ path, mediaType }) => ({ path, mediaType })),
  });
  provider.respond(reply("ok"));
  await done;
});

test("store: attachment names are validated", () => {
  const { store } = testRuntime(new ScriptedProvider([]));
  const meta = store.create("/tmp", "m");
  assert.throws(() => store.attachmentPath(meta.id, "../meta.json"), /invalid attachment name/);
  assert.throws(() => store.saveAttachment(meta.id, PNG, "image/svg+xml"), /unsupported image type/);
});

test("an attached file is saved and named in the message the model sees", async () => {
  const provider = new ScriptedProvider([reply("ok")]);
  const runtime = testRuntime(provider);
  const meta = runtime.store.create(tempWorkspace(), "m", "auto");
  const runner = new SessionRunner({ store: runtime.store, meta, makeDeps: runtime.makeDeps });
  const stored = runtime.store.saveAttachment(meta.id, Buffer.from("hello attachment"), "text/plain", "note.txt");
  assert.equal(stored.name.endsWith(".txt"), true);
  const done = runner.send("read it", [], [{ path: stored.path, name: "note.txt", mediaType: "text/plain", bytes: stored.bytes }]);
  await done.done;
  const first = runtime.store.loadMessages(meta.id)[0]!;
  assert.ok(first.role === "user");
  assert.match(first.content, /\[Attached files\]/);
  assert.match(first.content, /note\.txt/);
  assert.match(first.content, new RegExp(stored.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const event = runtime.store.loadEvents(meta.id).find((entry): entry is Extract<SessionEvent, { type: "user" }> => entry.type === "user");
  assert.deepEqual(event!.files, [{ name: stored.name, label: "note.txt", bytes: stored.bytes }]);
});
