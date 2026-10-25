import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PROVIDERS } from "../src/providers/catalog.ts";
import { ProviderStore } from "../src/providers/store.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "rca-provider-store-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, file: join(root, "private", "providers.json") };
}

test("provider list includes every default and binds the environment key only to legacy", (t) => {
  const { file } = fixture(t);
  const store = new ProviderStore(file, { apiKey: "environment-secret-abcd", baseURL: "https://gateway.example/v1", model: "custom-model" });
  const list = store.list();
  assert.deepEqual(list.map(({ id }) => id), PROVIDERS.map(({ id }) => id));
  const legacy = list.find(({ id }) => id === "legacy")!;
  assert.equal(legacy.source, "environment");
  assert.equal(legacy.configured, true);
  assert.equal(legacy.defaultModel, "custom-model");
  assert.equal(legacy.baseURL, "https://gateway.example/v1");
  assert.equal(legacy.keyMask, "••••abcd");
  assert.ok(list.filter(({ id }) => id !== "legacy").every((entry) => !entry.configured && entry.source === "local"));
  assert.equal(store.get("openai").apiKey, "");
  assert.equal(store.get("legacy").apiKey, "environment-secret-abcd");
  assert.doesNotMatch(JSON.stringify(list), /environment-secret-abcd|apiKey/);
  assert.equal(existsSync(file), false, "reads must not create a credentials file");
});

test("local provider credentials persist while UI summaries stay masked", (t) => {
  const { file } = fixture(t);
  const store = new ProviderStore(file);
  const response = store.update("anthropic", { apiKey: "  local-anthropic-secret-9876  ", baseURL: "https://proxy.example/anthropic" });
  assert.equal(response.configured, true);
  assert.equal(response.source, "local");
  assert.equal(response.keyMask, "••••9876");
  assert.doesNotMatch(JSON.stringify(response), /local-anthropic-secret-9876|apiKey/);
  assert.deepEqual(new ProviderStore(file).get("anthropic"), { id: "anthropic", apiKey: "local-anthropic-secret-9876", baseURL: "https://proxy.example/anthropic" });
  assert.equal(new ProviderStore(file).get("openai").apiKey, "");
});

test("omitted and blank keys preserve credentials; null clears even the legacy environment fallback", (t) => {
  const { file } = fixture(t);
  const legacy = { apiKey: "env-credential-4321", baseURL: "https://legacy.example/v1" };
  const store = new ProviderStore(file, legacy);
  store.update("legacy", { baseURL: "https://override.example/v1" });
  assert.equal(store.get("legacy").apiKey, legacy.apiKey);
  store.update("legacy", { apiKey: "" });
  assert.equal(store.get("legacy").apiKey, legacy.apiKey);
  store.update("legacy", { apiKey: "local-credential-1234" });
  store.update("legacy", { apiKey: "   " });
  store.update("legacy", {});
  assert.equal(store.get("legacy").apiKey, "local-credential-1234");
  const cleared = store.update("legacy", { apiKey: null });
  assert.equal(cleared.configured, false);
  assert.equal(cleared.keyMask, "");
  assert.equal(cleared.source, "local");
  assert.equal(new ProviderStore(file, legacy).get("legacy").apiKey, "");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).legacy.apiKey, null);
});

test("URL deletion uses provider defaults and can explicitly remove a legacy environment URL", (t) => {
  const { file } = fixture(t);
  const store = new ProviderStore(file, { apiKey: "secret", baseURL: "https://legacy.example/v1" });
  store.update("legacy", { baseURL: null });
  assert.equal(store.get("legacy").baseURL, undefined);
  const before = store.list().find(({ id }) => id === "openai")!.baseURL;
  store.update("openai", { baseURL: "http://127.0.0.1:8080/v1" });
  store.update("openai", { baseURL: null });
  assert.equal(store.get("openai").baseURL ?? "", before);
});

test("short keys are completely masked", (t) => {
  const { file } = fixture(t);
  const store = new ProviderStore(file);
  for (const apiKey of ["x", "1234", "12345678"]) {
    const summary = store.update("google", { apiKey });
    assert.equal(summary.keyMask, "••••••••");
    assert.equal(Object.hasOwn(summary, "apiKey"), false);
  }
});

test("atomic saves have private permissions, replace the file and leave no temporary secrets", (t) => {
  const { root, file } = fixture(t);
  const store = new ProviderStore(file);
  store.update("openai", { apiKey: "first-private-key" });
  if (process.platform !== "win32") {
    assert.equal(statSync(join(root, "private")).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    chmodSync(file, 0o644);
  }
  store.update("openai", { apiKey: "second-private-key" });
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(join(root, "private")), ["providers.json"]);
  assert.doesNotMatch(readFileSync(file, "utf8"), /first-private-key/);
});

test("multiple store instances reread saved provider changes before updates", (t) => {
  const { file } = fixture(t);
  const first = new ProviderStore(file);
  const second = new ProviderStore(file);
  first.update("openai", { apiKey: "openai-test-key" });
  second.update("google", { apiKey: "google-test-key" });
  assert.equal(first.get("google").apiKey, "google-test-key");
  assert.equal(second.get("openai").apiKey, "openai-test-key");
});

test("invalid URLs and unknown provider IDs are rejected without leaking values or changing storage", (t) => {
  const { file } = fixture(t);
  const store = new ProviderStore(file);
  store.update("openai", { apiKey: "preserved-secret" });
  const before = readFileSync(file, "utf8");
  for (const url of ["", "relative/path", "ftp://server.example", "https://user:secret@server.example", "https://@server.example", "https://server.example?secret=hidden", "https://server.example?", "https://server.example#hidden", "https://server.example#"]) {
    assert.throws(() => store.update("openai", { apiKey: "never-saved-secret", baseURL: url }), (error: unknown) => error instanceof Error && !error.message.includes(url || "never-saved-secret") && !error.message.includes("never-saved-secret"));
    assert.equal(readFileSync(file, "utf8"), before);
  }
  for (const id of ["unknown-secret-provider", "__proto__", "constructor"]) {
    assert.throws(() => store.get(id), /^Error: Unknown provider$/);
    assert.throws(() => store.update(id, { apiKey: "never-saved-secret" }), /^Error: Unknown provider$/);
  }
  assert.equal(readFileSync(file, "utf8"), before);
});

test("malformed credential files are preserved and cannot be overwritten through update", (t) => {
  const { root, file } = fixture(t);
  mkdirSync(join(root, "private"));
  const store = new ProviderStore(file);
  const invalid = [
    '{"openai":{"apiKey":"unclosed-secret"}',
    '[]', 'null',
    JSON.stringify({ unknown: { apiKey: "hidden-secret" } }),
    JSON.stringify({ openai: { apiKey: 123 } }),
    JSON.stringify({ openai: { apiKey: "hidden-secret", extra: true } }),
    JSON.stringify({ openai: { baseURL: "https://user:hidden-secret@server.example" } }),
  ];
  for (const content of invalid) {
    writeFileSync(file, content);
    for (const operation of [() => store.list(), () => store.get("openai"), () => store.update("openai", { apiKey: "replacement-secret" })]) {
      assert.throws(operation, (error: unknown) => error instanceof Error && /credential file is invalid/.test(error.message) && !/hidden-secret|unclosed-secret|replacement-secret/.test(error.message));
    }
    assert.equal(readFileSync(file, "utf8"), content);
    assert.deepEqual(readdirSync(join(root, "private")), ["providers.json"]);
  }
});

test("invalid patch shapes and credential characters cannot create or replace secret data", (t) => {
  const { file } = fixture(t);
  const store = new ProviderStore(file);
  for (const patch of [null, [], { apiKey: 1 }, { baseURL: false }, { apiKey: "secret\nvalue" }, { model: "unsupported" }]) {
    assert.throws(() => store.update("openai", patch as never), (error: unknown) => error instanceof Error && !error.message.includes("secret\nvalue"));
    assert.equal(existsSync(file), false);
  }
});

test("credential file symlinks are not followed or replaced", { skip: process.platform === "win32" }, (t) => {
  const { root, file } = fixture(t);
  mkdirSync(join(root, "private"));
  const target = join(root, "untouched.json");
  writeFileSync(target, '{"openai":{"apiKey":"outside-secret"}}');
  symlinkSync(target, file);
  const store = new ProviderStore(file);
  assert.throws(() => store.update("openai", { apiKey: "replacement-secret" }), /Cannot read provider credential file/);
  assert.equal(readFileSync(target, "utf8"), '{"openai":{"apiKey":"outside-secret"}}');
});
