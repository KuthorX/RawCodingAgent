import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { PROJECT_ROOT } from "../src/app.ts";

// markdown.js is a browser script; its parser is plain data in, plain data out, so run it in a bare context.
const context = vm.createContext({});
vm.runInContext(readFileSync(join(PROJECT_ROOT, "src", "gui", "markdown.js"), "utf8"), context);
// Round-trip through JSON so objects from the other context compare with deepEqual.
const parse = (text: string): unknown => JSON.parse(JSON.stringify(context.parseMarkdown(text)));
const inline = (text: string): unknown => JSON.parse(JSON.stringify(context.parseInline(text)));
const t = (text: string) => ({ type: "text", text });

test("inline: code, strong, em, del, links", () => {
  assert.deepEqual(inline("**新增 `pyproject.toml`**：声明"), [
    { type: "strong", children: [t("新增 "), { type: "code", text: "pyproject.toml" }] },
    t("：声明"),
  ]);
  assert.deepEqual(inline("*a* ~~b~~ [c](https://x.dev)"), [
    { type: "em", children: [t("a")] },
    t(" "),
    { type: "del", children: [t("b")] },
    t(" "),
    { type: "link", href: "https://x.dev", children: [t("c")] },
  ]);
  assert.deepEqual(inline("``a ` b``"), [{ type: "code", text: "a ` b" }]);
  // Parsed whole (the renderer then shows non-http links as plain text).
  assert.deepEqual(inline("[w](https://w.org/Foo_(bar)) [x](javascript:alert(1))"), [
    { type: "link", href: "https://w.org/Foo_(bar)", children: [t("w")] },
    t(" "),
    { type: "link", href: "javascript:alert(1)", children: [t("x")] },
  ]);
});

test("inline: things that must stay text", () => {
  assert.deepEqual(inline("snake_case_name and __x"), [t("snake_case_name and __x")]);
  assert.deepEqual(inline("2 * 3 * 4"), [t("2 * 3 * 4")]);
  assert.deepEqual(inline("\\*not em\\*"), [t("*not em*")]);
  assert.deepEqual(inline("`**not bold**`"), [{ type: "code", text: "**not bold**" }]);
});

test("inline: bare URLs stop at Chinese text and trailing punctuation", () => {
  const link = (href: string) => ({ type: "link", href, children: [t(href)] });
  assert.deepEqual(inline("见 https://x.dev/a?b=1。然后"), [t("见 "), link("https://x.dev/a?b=1"), t("。然后")]);
  assert.deepEqual(inline("(see https://x.dev)."), [t("(see "), link("https://x.dev"), t(").")]);
});

test("blocks: headings, paragraphs with line breaks, rules, quotes", () => {
  assert.deepEqual(parse("## 一、统一用 uv\n\nline one\nline two\n\n---\n> quoted\n> more"), [
    { type: "heading", level: 2, inline: [t("一、统一用 uv")] },
    { type: "para", inline: [t("line one\nline two")] },
    { type: "rule" },
    { type: "quote", blocks: [{ type: "para", inline: [t("quoted\nmore")] }] },
  ]);
});

test("blocks: fenced code keeps its content verbatim, an unclosed fence runs to the end", () => {
  assert.deepEqual(parse("```toml\n[project]\n**x** = 1\n```\nafter"), [
    { type: "code", lang: "toml", text: "[project]\n**x** = 1" },
    { type: "para", inline: [t("after")] },
  ]);
  assert.deepEqual(parse("~~~\na\n```\nb"), [{ type: "code", lang: "", text: "a\n```\nb" }]);
});

test("blocks: tables with alignment, inline code and escaped pipes", () => {
  assert.deepEqual(parse("| 原来 | 现在 |\n|---|:-:|\n| `a | b` | c \\| d |\n| e |"), [
    {
      type: "table",
      align: ["", "center"],
      head: [[t("原来")], [t("现在")]],
      rows: [
        [[{ type: "code", text: "a | b" }], [t("c | d")]],
        [[t("e")], []],
      ],
    },
  ]);
});

test("blocks: lists, ordered start, nesting, multi-paragraph items", () => {
  const para = (text: string) => ({ type: "para", inline: [t(text)] });
  assert.deepEqual(parse("- a\n- b\n  - b1\n  - b2\n- c\n\n3. x\n4. y"), [
    {
      type: "list",
      ordered: false,
      start: 1,
      items: [[para("a")], [para("b"), { type: "list", ordered: false, start: 1, items: [[para("b1")], [para("b2")]] }], [para("c")]],
    },
    { type: "list", ordered: true, start: 3, items: [[para("x")], [para("y")]] },
  ]);
  assert.deepEqual(parse("1. first\n\n   more about first\n2. second"), [
    { type: "list", ordered: true, start: 1, items: [[para("first"), para("more about first")], [para("second")]] },
  ]);
});

test("blocks: a list or heading right after a paragraph line starts a new block", () => {
  assert.deepEqual(parse("排查发现：\n- one\n## next"), [
    { type: "para", inline: [t("排查发现：")] },
    { type: "list", ordered: false, start: 1, items: [[{ type: "para", inline: [t("one")] }]] },
    { type: "heading", level: 2, inline: [t("next")] },
  ]);
});

test("CRLF input parses like LF", () => {
  assert.deepEqual(parse("# a\r\n\r\nb\r\n"), parse("# a\n\nb\n"));
});
